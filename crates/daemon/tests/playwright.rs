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
    // Both after the process is gone, on the daemon's own thread.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !daemon.recorded_pids().is_empty() || Path::new(&output_dir).exists() {
        assert!(
            Instant::now() < deadline,
            "5s after the browser stopped: recorded {:?}, the session's folder {}",
            daemon.recorded_pids(),
            if Path::new(&output_dir).exists() { "still there" } else { "gone" }
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    drop(watch);
}

/// One `gavin-daemon bridge` -- what the desktop runs over ssh on a host --
/// with its stdio as the link. Its first line is the banner; after that
/// it is the daemon's protocol, both ways.
struct Bridge {
    child: Child,
    stdin: std::process::ChildStdin,
    stdout: Option<BufReader<std::process::ChildStdout>>,
}

impl Bridge {
    fn start(home: &Path, browsers: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_gavin-daemon"))
            .arg("bridge")
            .env("HOME", home)
            .env("LOCALAPPDATA", home)
            .env("USERPROFILE", home)
            .env_remove("XDG_DATA_HOME")
            // What the host's daemon inherits when the bridge starts it.
            .env("PLAYWRIGHT_BROWSERS_PATH", browsers)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn gavin-daemon bridge");
        let stdin = child.stdin.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut banner = String::new();
        std::io::BufRead::read_line(&mut stdout, &mut banner).unwrap();
        assert!(banner.contains("BridgeReady"), "banner: {banner:?}");
        Self { child, stdin, stdout: Some(stdout) }
    }

    fn ask(&mut self, req: Request) -> Response {
        write_message(&mut self.stdin, &req).unwrap();
        read_message(self.stdout.as_mut().unwrap()).unwrap().expect("a reply over the bridge")
    }

    /// The link's far end, for a reader thread of its own.
    fn take_stdout(&mut self) -> BufReader<std::process::ChildStdout> {
        self.stdout.take().unwrap()
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The ssh workspace's half (parent plan, "ssh workspace" item): the
/// browser launches on the HOST -- where the bridge's daemon and the
/// agent run -- and its frames reach the desktop through the bridge, on a
/// streaming connection of their own as the desktop opens one per link.
#[test]
fn over_an_ssh_bridge_the_browser_runs_on_the_host_and_its_frames_cross_the_link() {
    let Some(browsers) = installed_browsers() else {
        assert!(
            std::env::var_os("GAVIN_REQUIRE_PLAYWRIGHT").is_none(),
            "GAVIN_REQUIRE_PLAYWRIGHT is set and no complete Playwright headless shell is installed"
        );
        eprintln!("SKIPPED: no complete Playwright headless shell is installed on this machine");
        return;
    };
    let temp_root = if cfg!(windows) { std::env::temp_dir() } else { PathBuf::from("/tmp") };
    let home = tempfile::Builder::new().prefix("gavin-pw-host-").tempdir_in(&temp_root).unwrap();
    let fake = Some(home.path().as_os_str().to_os_string());
    let state_dir =
        protocol::resolve_app_support_dir(fake.clone(), None, fake.clone(), fake, protocol::HostOs::current())
            .unwrap();
    let socket = state_dir.join(protocol::profile_file_name("daemon", "sock", protocol::BuildProfile::current()));
    // The daemon the first bridge starts outlives it, as on a host; this
    // stops it at the end.
    struct Stop(PathBuf);
    impl Drop for Stop {
        fn drop(&mut self) {
            if let Ok(mut stream) = Stream::connect(&self.0) {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let _ = write_message(&mut stream, &Request::Shutdown);
                let mut reader = BufReader::new(stream);
                let _ = read_message::<_, Response>(&mut reader);
            }
        }
    }
    let _stop = Stop(socket);

    // The command link: a session on the host, and its endpoint.
    let mut commands = Bridge::start(home.path(), &browsers);
    let workspace = tempfile::tempdir().unwrap();
    let root = workspace.path().to_string_lossy().into_owned();
    let session_id = match commands.ask(Request::CreateSession {
        workspace_path: root.clone(),
        cwd: root,
        command: None,
        profile_id: None,
        api_family: None,
        without_headroom: true,
    }) {
        Response::SessionCreated { id, .. } => id,
        other => panic!("CreateSession over the bridge: {other:?}"),
    };
    let endpoint = match commands.ask(Request::PlaywrightEndpoint { session_id: session_id.clone() }) {
        Response::PlaywrightEndpoint { endpoint, .. } => endpoint,
        other => panic!("PlaywrightEndpoint over the bridge: {other:?}"),
    };

    // The streaming link: the desk's watch, at the ssh rate.
    let mut frames_link = Bridge::start(home.path(), &browsers);
    write_message(
        &mut frames_link.stdin,
        &Request::WatchBrowser { session_id: session_id.clone(), size: BrowserViewSize::Desk, max_fps: 4 },
    )
    .unwrap();
    let mut frames_out = frames_link.take_stdout();
    let (pushes, received) = mpsc::channel();
    std::thread::spawn(move || {
        while let Ok(Some(push)) = read_message::<_, Response>(&mut frames_out) {
            if pushes.send(push).is_err() {
                return;
            }
        }
    });

    // The agent's MCP, on the host, through the host's proxy.
    let mut cdp = Cdp::connect(&endpoint);
    let targets = cdp.call("Target.getTargets", serde_json::json!({}), None);
    let page = targets["targetInfos"].as_array().unwrap().iter().find(|t| t["type"] == "page").unwrap()["targetId"]
        .as_str()
        .unwrap()
        .to_string();
    let attached = cdp.call("Target.attachToTarget", serde_json::json!({ "targetId": page, "flatten": true }), None);
    let cdp_session = attached["sessionId"].as_str().unwrap().to_string();
    cdp.call(
        "Page.navigate",
        serde_json::json!({ "url": "data:text/html,<body style='background:%233a6'><h1>over the bridge</h1></body>" }),
        Some(&cdp_session),
    );

    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match received.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Response::BrowserFrame { session_id: s, url, data, .. }) => {
                assert_eq!(s, session_id);
                if url.starts_with("data:text/html") {
                    assert!(data.starts_with("/9j/"), "a JPEG crossed the link");
                    break;
                }
            }
            Ok(other) => panic!("unexpected push over the bridge: {other:?}"),
            Err(_) => panic!("no frame of the navigated page crossed the bridge within 20s"),
        }
    }

    // And the session's end crosses it too.
    drop(cdp);
    assert!(matches!(commands.ask(Request::KillSession { id: session_id.clone() }), Response::Ok));
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match received.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Response::BrowserGone { session_id: s }) => {
                assert_eq!(s, session_id);
                break;
            }
            Ok(Response::BrowserFrame { .. }) => continue,
            Ok(other) => panic!("unexpected push over the bridge: {other:?}"),
            Err(_) => panic!("no BrowserGone crossed the bridge within 10s of the kill"),
        }
    }
}

/// The ssh workspace's setup step (v66): the host's daemon says whether
/// its own machine has npx and the pinned browser, and runs the install
/// there, answering at once and reporting the finished run on a later
/// status -- all of it through the bridge. The install itself runs only
/// where the pinned browser is already there, so a test never downloads
/// 200 MB; CI installs it first, so there the install path runs too.
#[test]
fn an_ssh_hosts_daemon_checks_and_installs_playwright_on_its_own_machine() {
    let Some(browsers) = installed_browsers() else {
        assert!(
            std::env::var_os("GAVIN_REQUIRE_PLAYWRIGHT").is_none(),
            "GAVIN_REQUIRE_PLAYWRIGHT is set and no complete Playwright headless shell is installed"
        );
        eprintln!("SKIPPED: no complete Playwright headless shell is installed on this machine");
        return;
    };
    let pinned = browsers
        .join(protocol::playwright::headless_shell_folder(protocol::playwright::HEADLESS_SHELL_REVISION))
        .join(protocol::playwright::INSTALLATION_COMPLETE);
    let temp_root = if cfg!(windows) { std::env::temp_dir() } else { PathBuf::from("/tmp") };
    let home = tempfile::Builder::new().prefix("gavin-pw-inst-").tempdir_in(&temp_root).unwrap();
    let fake = Some(home.path().as_os_str().to_os_string());
    let state_dir =
        protocol::resolve_app_support_dir(fake.clone(), None, fake.clone(), fake, protocol::HostOs::current())
            .unwrap();
    let socket = state_dir.join(protocol::profile_file_name("daemon", "sock", protocol::BuildProfile::current()));
    struct Stop(PathBuf);
    impl Drop for Stop {
        fn drop(&mut self) {
            if let Ok(mut stream) = Stream::connect(&self.0) {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let _ = write_message(&mut stream, &Request::Shutdown);
                let mut reader = BufReader::new(stream);
                let _ = read_message::<_, Response>(&mut reader);
            }
        }
    }
    let _stop = Stop(socket);

    let mut link = Bridge::start(home.path(), &browsers);
    let status = match link.ask(Request::PlaywrightMachineStatus) {
        Response::PlaywrightMachine { status } => status,
        other => panic!("PlaywrightMachineStatus over the bridge: {other:?}"),
    };
    assert_eq!(status.browser_installed, pinned.is_file(), "{status:?}");
    assert_eq!(Path::new(&status.marker), pinned, "the host's own environment placed the cache");
    assert!(!status.installing);
    if !status.npx || !status.browser_installed {
        eprintln!("SKIPPED the install: npx {} / pinned browser {} on this machine", status.npx, status.browser_installed);
        return;
    }

    let started = match link.ask(Request::InstallPlaywrightBrowser) {
        Response::PlaywrightMachine { status } => status,
        other => panic!("InstallPlaywrightBrowser over the bridge: {other:?}"),
    };
    assert!(started.installing, "it answers at once, installing: {started:?}");
    let deadline = Instant::now() + Duration::from_secs(300);
    let finished = loop {
        match link.ask(Request::PlaywrightMachineStatus) {
            Response::PlaywrightMachine { status } if !status.installing => break status,
            Response::PlaywrightMachine { .. } => {}
            other => panic!("PlaywrightMachineStatus over the bridge: {other:?}"),
        }
        assert!(Instant::now() < deadline, "the install was still running after 300s");
        std::thread::sleep(Duration::from_millis(250));
    };
    let run = finished.last_install.expect("the finished run is reported");
    assert_eq!(run.code, 0, "the install's output:\n{}", run.output);
    assert!(finished.browser_installed);
}
