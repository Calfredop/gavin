//! Out-of-process coverage for the daemon's singleton lock
//! (`src/singleton.rs`): two real `gavin-daemon` processes under one
//! temp `$HOME`, which is the only way to watch the second one refuse.
//!
//! Every daemon here is this test's own child, bound under a throwaway
//! home; nothing addresses a daemon by name, and the real one on the
//! machine is never reached. See `shutdown.rs` for why the home sits
//! directly under /tmp on unix.

use protocol::transport::{Endpoint, Stream};
use protocol::{read_message, write_message, BuildProfile, Request, Response};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// A throwaway home, the data directory a daemon started under it will
/// use, and every daemon started there -- killed on the way out, panic
/// or not, so a failing assertion cannot leave one running.
struct Home {
    dir: tempfile::TempDir,
    data: PathBuf,
    children: Vec<Child>,
}

impl Home {
    fn new() -> Home {
        let temp_root = if cfg!(windows) { std::env::temp_dir() } else { PathBuf::from("/tmp") };
        let dir = tempfile::Builder::new().prefix("gavin-singleton-").tempdir_in(&temp_root).unwrap();
        let fake = Some(dir.path().as_os_str().to_os_string());
        let data = protocol::resolve_app_support_dir(
            fake.clone(),
            None,
            fake.clone(),
            fake.clone(),
            protocol::HostOs::current(),
        )
        .unwrap();
        Home { dir, data, children: Vec::new() }
    }

    fn file(&self, stem: &str, extension: &str) -> PathBuf {
        self.data.join(protocol::profile_file_name(stem, extension, BuildProfile::current()))
    }

    fn endpoint(&self) -> Endpoint {
        Endpoint::new(self.file("daemon", "sock"))
    }

    /// Starts a daemon here, stderr captured so a refusal can be read.
    fn spawn(&mut self) -> usize {
        let child = Command::new(env!("CARGO_BIN_EXE_gavin-daemon"))
            .env("HOME", self.dir.path())
            .env("LOCALAPPDATA", self.dir.path())
            .env("USERPROFILE", self.dir.path())
            .env_remove("XDG_DATA_HOME")
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to spawn gavin-daemon");
        self.children.push(child);
        self.children.len() - 1
    }

    fn wait_listening(&self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !protocol::transport::is_listening(&self.endpoint()) {
            assert!(Instant::now() < deadline, "daemon never bound {}", self.endpoint());
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// The exit status of daemon `i`, polled -- never a blocking wait,
    /// so a daemon that fails to refuse fails the test instead of
    /// hanging it.
    fn wait_exit(&mut self, i: usize) -> (std::process::ExitStatus, String) {
        let deadline = Instant::now() + Duration::from_secs(10);
        let child = &mut self.children[i];
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "the second daemon did not exit");
            std::thread::sleep(Duration::from_millis(20));
        };
        let mut stderr = String::new();
        child.stderr.take().unwrap().read_to_string(&mut stderr).unwrap();
        (status, stderr)
    }

    fn generation(&self) -> i64 {
        let conn = rusqlite::Connection::open(self.file("registry", "sqlite")).unwrap();
        conn.query_row("SELECT value FROM registry_meta WHERE key = 'generation'", [], |r| r.get(0))
            .unwrap()
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        for child in &mut self.children {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn shutdown(endpoint: &Endpoint) -> u32 {
    let mut stream = Stream::connect(endpoint.path()).expect("connect to the daemon");
    let pid = stream.server_pid().expect("the kernel names the daemon on the other end");
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    write_message(&mut stream, &Request::Shutdown).unwrap();
    let reply: Option<Response> = read_message(&mut BufReader::new(stream)).unwrap();
    assert!(matches!(reply, Some(Response::Ok)), "{reply:?}");
    pid
}

fn read(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[test]
fn a_second_daemon_of_the_same_build_exits_without_touching_anything() {
    let mut home = Home::new();
    let first = home.spawn();
    home.wait_listening();
    let first_pid = home.children[first].id();

    let generation = home.generation();
    let token = read(&home.file("daemon", "token"));
    // The first daemon swept this file away at startup; a second one
    // that got as far as the sweep would delete it again.
    let browsers = home.file("playwright-browsers", "json");
    std::fs::write(&browsers, "{\"browsers\":[]}").unwrap();

    let second = home.spawn();
    let (status, stderr) = home.wait_exit(second);

    assert!(!status.success(), "the second daemon must exit non-zero: {status:?}");
    assert!(stderr.contains("another gavin-daemon"), "{stderr}");
    #[cfg(unix)]
    assert!(stderr.contains(&format!("pid {first_pid}")), "should name the holder: {stderr}");
    assert_eq!(stderr.trim().lines().count(), 1, "one line in the log: {stderr}");

    assert_eq!(home.generation(), generation, "the registry generation was bumped");
    assert_eq!(read(&home.file("daemon", "token")), token, "the token the app holds was replaced");
    assert_eq!(read(&browsers), b"{\"browsers\":[]}", "the browser record was swept");
    assert!(home.children[first].try_wait().unwrap().is_none(), "the first daemon died");
    assert!(protocol::transport::is_listening(&home.endpoint()), "the first daemon stopped answering");
}

#[test]
fn a_restart_that_waits_for_the_old_pid_does_not_race_the_lock() {
    // The app's restart: Shutdown, wait for that pid to have exited
    // (`stop_running_daemon`), spawn. The old daemon is this test's
    // unreaped child, as it is the app's, so it lingers as a zombie --
    // which `pid_alive` has to read as gone, lock released.
    let mut home = Home::new();
    home.spawn();
    home.wait_listening();

    let old = shutdown(&home.endpoint());
    assert!(
        protocol::daemon_lock::wait_for_exit(old, Duration::from_secs(5)),
        "the old daemon never exited"
    );

    let next = home.spawn();
    home.wait_listening();
    assert!(
        home.children[next].try_wait().unwrap().is_none(),
        "the new daemon hit the lock and left"
    );
    let lock = home.file("daemon", "lock");
    #[cfg(unix)]
    assert_eq!(
        protocol::daemon_lock::lock_holder(&lock),
        protocol::daemon_lock::LockHolder::Alive(Some(home.children[next].id()))
    );
    #[cfg(windows)]
    assert!(matches!(
        protocol::daemon_lock::lock_holder(&lock),
        protocol::daemon_lock::LockHolder::Alive(_)
    ));
}
