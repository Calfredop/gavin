//! A session's browser, end to end, against a real `gavin-daemon`.
//!
//! The daemon runs under a temporary `$HOME`, so it binds its own socket
//! and keeps its own databases and browser folders, the isolated-daemon
//! pattern `shutdown.rs` and `device_wire.rs` use; the developer's daemon
//! is never touched. It is pointed at this machine's real Playwright
//! browsers through `PLAYWRIGHT_BROWSERS_PATH`, and the test skips, saying
//! so, where none is installed. CI installs one first.
//!
//! What it proves, in order:
//! 1. The endpoint is handed out with no browser launched.
//! 2. The first connection through the proxy launches one, which a CDP
//!    client drives the way the Playwright MCP does.
//! 3. A `WatchBrowser` receives a frame of the page it navigated to.
//! 4. Killing the session ends the watch with `BrowserGone` and stops
//!    the browser's process.

use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use protocol::transport::Stream;
use protocol::{read_message, write_message, BrowserViewSize, Request, Response};
use tungstenite::Message;

/// This machine's Playwright browsers directory, when it holds a complete
/// headless shell -- read from the real environment before the daemon's
/// is replaced.
fn installed_browsers() -> Option<PathBuf> {
    let home_var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let home = PathBuf::from(std::env::var_os(home_var)?);
    let dir = protocol::playwright::browsers_dir(protocol::HostOs::current(), &home, |k| std::env::var(k).ok());
    let complete: Vec<String> = std::fs::read_dir(&dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().join(protocol::playwright::INSTALLATION_COMPLETE).is_file())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    protocol::playwright::pick_revision(complete.iter().map(String::as_str))?;
    Some(dir)
}

struct Daemon {
    child: Child,
    socket: PathBuf,
    state_dir: PathBuf,
    _home: tempfile::TempDir,
}

impl Daemon {
    fn start(browsers: &Path) -> Self {
        // Under /tmp on unix: the socket path must fit sun_path (see
        // shutdown.rs).
        let temp_root = if cfg!(windows) { std::env::temp_dir() } else { PathBuf::from("/tmp") };
        let home = tempfile::Builder::new().prefix("gavin-pw-test-").tempdir_in(&temp_root).unwrap();
        let fake = Some(home.path().as_os_str().to_os_string());
        let state_dir = protocol::resolve_app_support_dir(
            fake.clone(),
            None,
            fake.clone(),
            fake.clone(),
            protocol::HostOs::current(),
        )
        .unwrap();
        let socket =
            state_dir.join(protocol::profile_file_name("daemon", "sock", protocol::BuildProfile::current()));
        let child = Command::new(env!("CARGO_BIN_EXE_gavin-daemon"))
            .env("HOME", home.path())
            .env("LOCALAPPDATA", home.path())
            .env("USERPROFILE", home.path())
            .env_remove("XDG_DATA_HOME")
            .env("PLAYWRIGHT_BROWSERS_PATH", browsers)
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn gavin-daemon");
        let endpoint = protocol::transport::Endpoint::new(socket.clone());
        let deadline = Instant::now() + Duration::from_secs(10);
        while !protocol::transport::is_listening(&endpoint) {
            assert!(Instant::now() < deadline, "the daemon never bound {}", socket.display());
            std::thread::sleep(Duration::from_millis(20));
        }
        Self { child, socket, state_dir, _home: home }
    }

    fn connect(&self) -> (Stream, BufReader<Stream>) {
        let stream = Stream::connect(&self.socket).expect("connect");
        stream.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        let reader = BufReader::new(stream.try_clone().unwrap());
        (stream, reader)
    }

    fn ask(&self, req: Request) -> Response {
        let (mut stream, mut reader) = self.connect();
        write_message(&mut stream, &req).unwrap();
        read_message(&mut reader).unwrap().expect("a reply")
    }

    /// The browsers the daemon's run record lists, by pid.
    fn recorded_pids(&self) -> Vec<u32> {
        let path = self
            .state_dir
            .join(protocol::profile_file_name("playwright-browsers", "json", protocol::BuildProfile::current()));
        let Ok(body) = std::fs::read_to_string(path) else { return Vec::new() };
        let record: serde_json::Value = serde_json::from_str(&body).unwrap();
        record["browsers"]
            .as_array()
            .map(|b| b.iter().filter_map(|b| b["process"]["pid"].as_u64()).map(|p| p as u32).collect())
            .unwrap_or_default()
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        if let Ok(mut stream) = Stream::connect(&self.socket) {
            let _ = write_message(&mut stream, &Request::Shutdown);
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 checks for existence and sends nothing.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(windows)]
fn alive(pid: u32) -> bool {
    let out = Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
}

/// A blocking CDP client, sending one command and reading until its reply.
struct Cdp {
    ws: tungstenite::WebSocket<std::net::TcpStream>,
    next: u64,
}

impl Cdp {
    fn connect(url: &str) -> Self {
        let authority = url.strip_prefix("ws://").unwrap().split('/').next().unwrap();
        let tcp = std::net::TcpStream::connect(authority).unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        let (ws, _) = tungstenite::client::client(url, tcp).expect("handshake through the proxy");
        Self { ws, next: 0 }
    }

    fn call(&mut self, method: &str, params: serde_json::Value, session: Option<&str>) -> serde_json::Value {
        self.next += 1;
        let mut message = serde_json::json!({ "id": self.next, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = session.into();
        }
        self.ws.send(Message::Text(message.to_string().into())).unwrap();
        loop {
            let Message::Text(text) = self.ws.read().expect("a CDP reply") else { continue };
            let reply: serde_json::Value = serde_json::from_str(text.as_str()).unwrap();
            if reply["id"].as_u64() == Some(self.next) {
                assert!(reply.get("error").is_none(), "{method}: {reply}");
                return reply["result"].clone();
            }
        }
    }
}

#[test]
fn a_sessions_browser_launches_on_first_use_streams_frames_and_dies_with_the_session() {
    let Some(browsers) = installed_browsers() else {
        // CI installs the browser first and sets this, so a broken
        // install fails the job instead of passing it by skipping.
        assert!(
            std::env::var_os("GAVIN_REQUIRE_PLAYWRIGHT").is_none(),
            "GAVIN_REQUIRE_PLAYWRIGHT is set and no complete Playwright headless shell is installed"
        );
        eprintln!(
            "SKIPPED: no complete Playwright headless shell is installed on this machine -- run `npx {}` to run this test",
            protocol::playwright::install_args().join(" ")
        );
        return;
    };
    let daemon = Daemon::start(&browsers);
    let workspace = tempfile::tempdir().unwrap();
    let root = workspace.path().to_string_lossy().into_owned();

    let session_id = match daemon.ask(Request::CreateSession {
        workspace_path: root.clone(),
        cwd: root.clone(),
        command: None,
        profile_id: None,
        api_family: None,
        without_headroom: true,
    }) {
        Response::SessionCreated { id, .. } => id,
        other => panic!("CreateSession: {other:?}"),
    };

    // 1. The endpoint, and no browser yet.
    let (endpoint, output_dir) = match daemon.ask(Request::PlaywrightEndpoint { session_id: session_id.clone() }) {
        Response::PlaywrightEndpoint { endpoint, output_dir } => (endpoint, output_dir),
        other => panic!("PlaywrightEndpoint: {other:?}"),
    };
    assert!(endpoint.starts_with("ws://127.0.0.1:"), "{endpoint}");
    assert!(Path::new(&output_dir).is_dir(), "{output_dir}");
    assert!(daemon.recorded_pids().is_empty(), "nothing may launch before the first connection");
    match daemon.ask(Request::ListBrowsers) {
        Response::Browsers { browsers } => assert!(browsers.is_empty(), "{browsers:?}"),
        other => panic!("ListBrowsers: {other:?}"),
    }
    // A wrong secret is refused at the handshake.
    let wrong = format!("{}{}", &endpoint[..endpoint.rfind('/').unwrap() + 1], "0".repeat(64));
    let authority = wrong.strip_prefix("ws://").unwrap().split('/').next().unwrap();
    let tcp = std::net::TcpStream::connect(authority).unwrap();
    assert!(tungstenite::client::client(wrong.as_str(), tcp).is_err(), "a wrong secret must be refused");

    // 3 (armed first). The watch, on a connection of its own.
    let (mut watch, mut watch_reader) = daemon.connect();
    write_message(
        &mut watch,
        &Request::WatchBrowser { session_id: session_id.clone(), size: BrowserViewSize::Desk, max_fps: 8 },
    )
    .unwrap();
    let (pushes, received) = mpsc::channel();
    std::thread::spawn(move || {
        while let Ok(Some(push)) = read_message::<_, Response>(&mut watch_reader) {
            if pushes.send(push).is_err() {
                return;
            }
        }
    });

    // 2. The first connection launches the browser; drive it as the MCP would.
    let started = Instant::now();
    // The handshake completes at once and the launch follows it; the
    // first command waits in the socket until the browser answers it.
    let mut cdp = Cdp::connect(&endpoint);
    let targets = cdp.call("Target.getTargets", serde_json::json!({}), None);
    eprintln!("first CDP reply through the proxy after {:?}", started.elapsed());
    let pids = daemon.recorded_pids();
    assert_eq!(pids.len(), 1, "one browser for the session, recorded");
    let pid = pids[0];
    assert!(alive(pid));
    let page = targets["targetInfos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["type"] == "page")
        .expect("the browser's first tab")["targetId"]
        .as_str()
        .unwrap()
        .to_string();
    let attached = cdp.call("Target.attachToTarget", serde_json::json!({ "targetId": page, "flatten": true }), None);
    let cdp_session = attached["sessionId"].as_str().unwrap().to_string();
    let url = "data:text/html,<body style='background:%23c33'><h1>gavin playwright test</h1></body>";
    cdp.call("Page.navigate", serde_json::json!({ "url": url }), Some(&cdp_session));

    // 3. A frame of that page.
    let deadline = Instant::now() + Duration::from_secs(20);
    let frame = loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match received.recv_timeout(left) {
            Ok(Response::BrowserFrame { session_id: s, data, url: frame_url, seq, .. }) => {
                assert_eq!(s, session_id);
                if frame_url.starts_with("data:text/html") {
                    break (data, seq);
                }
            }
            Ok(other) => panic!("unexpected push on the watch: {other:?}"),
            Err(_) => panic!("no frame of the navigated page within 20s"),
        }
    };
    assert!(frame.0.len() > 100, "a JPEG, base64");
    assert!(frame.0.starts_with("/9j/"), "JPEG magic, base64");
    match daemon.ask(Request::ListBrowsers) {
        Response::Browsers { browsers } => {
            assert_eq!(browsers.len(), 1);
            assert_eq!(browsers[0].session_id, session_id);
            assert!(browsers[0].browser.url.starts_with("data:text/html"), "{browsers:?}");
        }
        other => panic!("ListBrowsers: {other:?}"),
    }

    // 4. The session ends, and the browser with it.
    drop(cdp);
    assert!(matches!(daemon.ask(Request::KillSession { id: session_id.clone() }), Response::Ok));
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match received.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Response::BrowserGone { session_id: s }) => {
                assert_eq!(s, session_id);
                break;
            }
            Ok(Response::BrowserFrame { .. }) => continue,
            Ok(other) => panic!("unexpected push on the watch: {other:?}"),
            Err(_) => panic!("no BrowserGone within 10s of the kill"),
        }
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while alive(pid) {
        assert!(Instant::now() < deadline, "the browser (pid {pid}) outlived its session by 10s");
        std::thread::sleep(Duration::from_millis(50));
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while !daemon.recorded_pids().is_empty() {
        assert!(Instant::now() < deadline, "the run record still lists the stopped browser");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!Path::new(&output_dir).exists(), "the session's folder goes with it");
    drop(watch);
}
