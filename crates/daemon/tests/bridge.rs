//! Out-of-process coverage for `gavin-daemon bridge`, the host side of an
//! ssh workspace (`docs/superpowers/specs/2026-09-22-ssh-workspaces-design.md`).
//!
//! The bridge is a process whose whole contract is what it does with its
//! stdio: one banner line, then bytes relayed to and from the daemon's
//! endpoint until either side closes. That contract can only be checked
//! from outside -- through a real child's pipes -- so, like `shutdown.rs`,
//! this spawns the actual binary under a fake data directory rather than
//! calling anything in-process.

use protocol::transport::{Endpoint, Listener, Stream};
use protocol::{read_message, write_message, Request, Response};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A fake data directory: the daemon endpoint, token file and log the
/// bridge derives from `protocol::app_support_dir` all land under it, so
/// nothing here can reach the developer's real daemon. Under `/tmp` on
/// unix for the sun_path budget `shutdown.rs` explains.
struct FakeHome {
    dir: tempfile::TempDir,
}

impl FakeHome {
    fn new() -> Self {
        let temp_root = if cfg!(windows) { std::env::temp_dir() } else { PathBuf::from("/tmp") };
        let dir = tempfile::Builder::new().prefix("gavin-bridge-").tempdir_in(&temp_root).unwrap();
        let this = FakeHome { dir };
        std::fs::create_dir_all(this.support_dir()).unwrap();
        this
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }

    /// Where the bridge will look, asked of the same function it asks.
    fn support_dir(&self) -> PathBuf {
        let fake = Some(self.path().as_os_str().to_os_string());
        protocol::resolve_app_support_dir(
            fake.clone(),
            None,
            fake.clone(),
            fake,
            protocol::HostOs::current(),
        )
        .unwrap()
    }

    fn profile_file(&self, stem: &str, extension: &str) -> PathBuf {
        self.support_dir().join(protocol::profile_file_name(
            stem,
            extension,
            protocol::BuildProfile::current(),
        ))
    }

    fn socket_path(&self) -> PathBuf {
        self.profile_file("daemon", "sock")
    }

    fn token_path(&self) -> PathBuf {
        self.profile_file("daemon", "token")
    }

    fn log_path(&self) -> PathBuf {
        self.profile_file("daemon", "log")
    }

    /// `gavin-daemon bridge <args>` under this fake home, stdio piped.
    fn bridge(&self, args: &[&str]) -> Child {
        Command::new(env!("CARGO_BIN_EXE_gavin-daemon"))
            .arg("bridge")
            .args(args)
            .env("HOME", self.path())
            .env("LOCALAPPDATA", self.path())
            .env("USERPROFILE", self.path())
            .env_remove("XDG_DATA_HOME")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to spawn gavin-daemon bridge")
    }
}

/// Kills the child if the test has not finished with it in time: a bridge
/// that never prints its banner would otherwise block a `read_line` for
/// ever, and `cargo test` has no per-test timeout.
struct Watchdog {
    child: Arc<Mutex<Child>>,
    done: Arc<std::sync::atomic::AtomicBool>,
}

impl Watchdog {
    fn arm(child: Child) -> Self {
        let child = Arc::new(Mutex::new(child));
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (c, d) = (Arc::clone(&child), Arc::clone(&done));
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(20);
            while Instant::now() < deadline {
                if d.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let _ = c.lock().unwrap().kill();
        });
        Watchdog { child, done }
    }

    fn wait(&self) -> std::process::ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = self.child.lock().unwrap().try_wait().unwrap() {
                self.done.store(true, std::sync::atomic::Ordering::SeqCst);
                return status;
            }
            assert!(Instant::now() < deadline, "bridge did not exit in time");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        self.done.store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = self.child.lock().unwrap().kill();
    }
}

fn read_banner(stdout: &mut impl BufRead) -> serde_json::Value {
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    serde_json::from_str(line.trim_end()).unwrap_or_else(|e| panic!("banner {line:?} is not JSON: {e}"))
}

fn wait_until_gone(endpoint: &Endpoint) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while protocol::transport::is_listening(endpoint) {
        assert!(Instant::now() < deadline, "the daemon at {endpoint} never went away");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn bridge_prints_the_banner_then_relays_both_ways_until_stdin_closes() {
    let home = FakeHome::new();
    let token = "0123456789abcdef0123456789abcdef";
    std::fs::write(home.token_path(), format!("{token}\n")).unwrap();

    // A fake daemon: one connection, one request answered, then it waits
    // for the bridge to close the connection -- which the bridge must do
    // when ITS stdin closes, or the ssh session ending would leave a
    // connection (and its watchers) alive on the host for ever.
    let listener = Listener::bind(home.socket_path()).unwrap();
    let server = std::thread::spawn(move || {
        let stream = listener.incoming().next().unwrap().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let req: Option<Request> = read_message(&mut reader).unwrap();
        assert!(matches!(req, Some(Request::GetProtocolVersion)), "got {req:?}");
        write_message(&mut &stream, &Response::ProtocolVersion { version: 38 }).unwrap();
        let after: Option<Request> = read_message(&mut reader).unwrap();
        assert!(after.is_none(), "the bridge kept the daemon connection open: {after:?}");
    });

    let mut child = home.bridge(&["--no-spawn"]);
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let dog = Watchdog::arm(child);

    let banner = read_banner(&mut stdout);
    assert_eq!(banner["type"], "BridgeReady");
    assert_eq!(banner["daemonToken"], token, "the banner carries the token as written, trimmed");
    assert_eq!(banner["protocolVersion"], protocol::PROTOCOL_VERSION);
    assert_eq!(banner["hostOs"], std::env::consts::OS);
    let home_on_wire = banner["home"].as_str().expect("home is a string");
    assert!(!home_on_wire.is_empty());
    assert!(!home_on_wire.contains('\\'), "paths cross the wire with forward slashes: {home_on_wire}");

    write_message(&mut stdin, &Request::GetProtocolVersion).unwrap();
    let reply: Option<Response> = read_message(&mut stdout).unwrap();
    assert!(matches!(reply, Some(Response::ProtocolVersion { version: 38 })), "got {reply:?}");

    drop(stdin);
    server.join().unwrap();
    let status = dog.wait();
    assert!(status.success(), "bridge exited with {status:?}");
}

#[test]
fn bridge_exits_when_the_daemon_closes_its_side() {
    let home = FakeHome::new();
    std::fs::write(home.token_path(), "tok").unwrap();
    let listener = Listener::bind(home.socket_path()).unwrap();
    let server = std::thread::spawn(move || {
        let stream = listener.incoming().next().unwrap().unwrap();
        write_message(&mut &stream, &Response::Ok).unwrap();
        // Dropping the stream is the daemon going away.
    });

    let mut child = home.bridge(&["--no-spawn"]);
    let stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let dog = Watchdog::arm(child);

    let _banner = read_banner(&mut stdout);
    let pushed: Option<Response> = read_message(&mut stdout).unwrap();
    assert!(matches!(pushed, Some(Response::Ok)), "got {pushed:?}");
    server.join().unwrap();

    // stdin is still open -- the bridge must not wait on it.
    let status = dog.wait();
    assert!(status.success(), "bridge exited with {status:?}");
    drop(stdin);
}

#[test]
fn bridge_with_no_daemon_and_no_spawn_fails_naming_the_endpoint() {
    let home = FakeHome::new();
    let mut child = home.bridge(&["--no-spawn"]);
    drop(child.stdin.take());
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let dog = Watchdog::arm(child);

    let status = dog.wait();
    assert!(!status.success(), "the bridge claimed success with nothing to bridge to");
    let mut out = String::new();
    stdout.read_to_string(&mut out).unwrap();
    assert!(out.is_empty(), "no banner without a daemon, got {out:?}");
    let mut err = String::new();
    stderr.read_to_string(&mut err).unwrap();
    let endpoint = Endpoint::new(home.socket_path()).to_string();
    assert!(err.contains(&endpoint), "stderr should name {endpoint}, got {err:?}");
}

#[test]
fn bridge_rejects_an_argument_it_does_not_know() {
    let home = FakeHome::new();
    let mut child = home.bridge(&["--endpoint"]);
    drop(child.stdin.take());
    let mut stderr = child.stderr.take().unwrap();
    let dog = Watchdog::arm(child);
    let status = dog.wait();
    assert!(!status.success());
    let mut err = String::new();
    stderr.read_to_string(&mut err).unwrap();
    assert!(err.contains("--endpoint"), "stderr should name the argument, got {err:?}");
}

/// Shuts down the daemon a test made the bridge start, even when an
/// assertion fails first: a daemon left running under a temp directory
/// is a process on the developer's machine that nothing will ever
/// clean up.
struct DaemonGuard {
    socket: PathBuf,
}

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        if let Ok(mut stream) = Stream::connect(&self.socket) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let _ = write_message(&mut stream, &Request::Shutdown);
            let mut reader = BufReader::new(stream);
            let _ = read_message::<_, Response>(&mut reader);
        }
    }
}

#[test]
fn bridge_starts_a_daemon_when_none_is_listening_and_that_daemon_outlives_the_bridge() {
    let home = FakeHome::new();
    let endpoint = Endpoint::new(home.socket_path());
    assert!(!protocol::transport::is_listening(&endpoint));
    let _guard = DaemonGuard { socket: home.socket_path() };

    let mut child = home.bridge(&[]);
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let dog = Watchdog::arm(child);

    let banner = read_banner(&mut stdout);
    assert_eq!(banner["type"], "BridgeReady");
    // The daemon the bridge started minted a token before it bound, and
    // the bridge read it only after the connect succeeded -- so it is the
    // real one, not a stale file's.
    let token = banner["daemonToken"].as_str().expect("a spawned daemon has a token");
    assert_eq!(std::fs::read_to_string(home.token_path()).unwrap().trim(), token);
    assert!(protocol::transport::is_listening(&endpoint));

    // Its output went to the log, not down our pipe: the banner was the
    // first line and the next thing on stdout is a protocol reply.
    write_message(&mut stdin, &Request::GetProtocolVersion).unwrap();
    let reply: Option<Response> = read_message(&mut stdout).unwrap();
    assert!(
        matches!(reply, Some(Response::ProtocolVersion { version }) if version == protocol::PROTOCOL_VERSION),
        "got {reply:?}"
    );
    let log = std::fs::read_to_string(home.log_path()).unwrap_or_default();
    assert!(
        log.contains("listening on"),
        "the daemon's startup line should be in {}: {log:?}",
        home.log_path().display()
    );

    // The ssh session ends: the bridge exits, and its stdout reaches EOF
    // promptly -- which it cannot do if the daemon it started inherited a
    // copy of that pipe. On a real host that copy is the ssh channel,
    // held open for as long as the daemon lives.
    drop(stdin);
    let status = dog.wait();
    assert!(status.success(), "bridge exited with {status:?}");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut rest = Vec::new();
        let outcome = stdout.read_to_end(&mut rest).map(|_| rest);
        let _ = tx.send(outcome);
    });
    let rest = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("stdout never reached EOF: the daemon is holding the bridge's pipe")
        .unwrap();
    assert!(rest.is_empty(), "bytes after the bridge exited: {}", String::from_utf8_lossy(&rest));

    // The daemon is still there -- its own process, not the bridge's
    // child -- and takes a Shutdown straight from us like any other.
    assert!(protocol::transport::is_listening(&endpoint), "the daemon died with the bridge");
    let mut direct = Stream::connect(home.socket_path()).unwrap();
    direct.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    write_message(&mut direct, &Request::Shutdown).unwrap();
    let mut reader = BufReader::new(direct.try_clone().unwrap());
    let reply: Option<Response> = read_message(&mut reader).unwrap();
    assert!(matches!(reply, Some(Response::Ok)), "got {reply:?}");
    wait_until_gone(&endpoint);
}
