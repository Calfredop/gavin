//! A real `gavin-daemon` on a machine in a tempdir, for the tests that
//! need one to kill.
//!
//! Everything lives under a temp `$HOME`: the daemon's socket, its
//! databases, its Headroom records. Nothing here can reach the
//! developer's own daemon, and everything a test starts is killed when
//! its `Machine` is dropped, so a failed assertion leaves nothing
//! running.

#![allow(dead_code)]

use protocol::transport::Stream;
use protocol::{read_message, write_message, BuildProfile, HeadroomStatus, Request, Response};
use std::io::BufReader;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// What a macOS app launched from the Dock is handed: no `~/.local/bin`.
pub const DOCK_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

/// Headroom is unavailable on an Intel Mac, so there is no lifecycle to
/// test on one. Said out loud rather than passed vacuously.
pub fn unavailable_here() -> bool {
    let unavailable = cfg!(all(target_os = "macos", target_arch = "x86_64"));
    if unavailable {
        eprintln!("skipped: Headroom is unavailable on this platform");
    }
    unavailable
}

pub fn wait_up_to<T>(how_long: Duration, what: &str, mut look: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + how_long;
    loop {
        if let Some(found) = look() {
            return found;
        }
        assert!(Instant::now() < deadline, "gave up waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

pub fn wait_for<T>(what: &str, look: impl FnMut() -> Option<T>) -> T {
    wait_up_to(Duration::from_secs(30), what, look)
}

pub fn alive(pid: u32) -> bool {
    // Signal 0 asks whether the pid can be signalled and sends nothing.
    // SAFETY: plain integers, no pointers.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

pub fn kill(pid: u32) {
    // SAFETY: a plain signal to a pid this test started.
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
}

/// Whether something answers `/readyz` on the port.
pub fn serving(port: u16) -> bool {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(2))
        .build()
        .get(&format!("http://127.0.0.1:{port}/readyz"))
        .call()
        .is_ok_and(|response| response.status() == 200)
}

pub struct Machine {
    pub home: tempfile::TempDir,
    /// Every Headroom pid a test saw recorded, so the ones a later
    /// record no longer names are still cleaned up.
    seen: std::sync::Mutex<Vec<u32>>,
}

impl Machine {
    pub fn new() -> Machine {
        // Under /tmp, not the default temp directory: see
        // `tests/shutdown.rs` on the socket path's length.
        Machine {
            home: tempfile::Builder::new().prefix("gavin-hr-").tempdir_in("/tmp").unwrap(),
            seen: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Where uv would install a tool's executables on this machine.
    pub fn uv_bin(&self) -> PathBuf {
        self.home.path().join(".local").join("bin")
    }

    /// The daemon's state directory, asked of the same function the
    /// daemon asks.
    pub fn state(&self) -> PathBuf {
        let fake = Some(self.home.path().as_os_str().to_os_string());
        protocol::resolve_app_support_dir(
            fake.clone(),
            None,
            fake.clone(),
            fake,
            protocol::HostOs::current(),
        )
        .unwrap()
    }

    /// Headroom's own state directory under it.
    pub fn workspace(&self) -> PathBuf {
        self.state().join(format!("headroom{}", BuildProfile::current().suffix()))
    }

    pub fn record_path(&self) -> PathBuf {
        self.state().join(protocol::profile_file_name(
            "headroom-run",
            "json",
            BuildProfile::current(),
        ))
    }

    pub fn record(&self) -> serde_json::Value {
        std::fs::read_to_string(self.record_path())
            .ok()
            .and_then(|body| serde_json::from_str(&body).ok())
            .unwrap_or(serde_json::Value::Null)
    }

    pub fn edit_record(&self, change: impl FnOnce(&mut serde_json::Value)) {
        let mut record = self.record();
        change(&mut record);
        std::fs::write(self.record_path(), serde_json::to_string(&record).unwrap()).unwrap();
    }

    /// The pid the daemon recorded for its Headroom.
    pub fn pid(&self) -> Option<u32> {
        let pid = self.record()["process"]["pid"].as_u64().map(|pid| pid as u32);
        if let Some(pid) = pid {
            let mut seen = self.seen.lock().unwrap();
            if !seen.contains(&pid) {
                seen.push(pid);
            }
        }
        pid
    }

    pub fn daemon(&self) -> Daemon {
        self.daemon_with(&[])
    }

    pub fn daemon_with(&self, env: &[(&str, &str)]) -> Daemon {
        let socket = self
            .state()
            .join(protocol::profile_file_name("daemon", "sock", BuildProfile::current()));
        let mut command = Command::new(env!("CARGO_BIN_EXE_gavin-daemon"));
        command
            .env("HOME", self.home.path())
            .env("LOCALAPPDATA", self.home.path())
            .env("USERPROFILE", self.home.path())
            .env_remove("XDG_DATA_HOME")
            .env_remove("XDG_BIN_HOME")
            .env_remove("UV_TOOL_BIN_DIR")
            .env("PATH", DOCK_PATH)
            // What a daemon started from the human's terminal can
            // inherit. Neither may reach the proxy.
            .env("HEADROOM_MODE", "token")
            .env("HEADROOM_PORT", "8787")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for (key, value) in env {
            command.env(key, value);
        }
        let child = command.spawn().expect("failed to spawn gavin-daemon");
        let endpoint = protocol::transport::Endpoint::new(socket.clone());
        wait_for("the daemon to bind its endpoint", || {
            protocol::transport::is_listening(&endpoint).then_some(())
        });
        Daemon { child, socket }
    }
}

impl Drop for Machine {
    fn drop(&mut self) {
        self.pid();
        for pid in self.seen.lock().unwrap().drain(..) {
            if alive(pid) {
                kill(pid);
            }
        }
    }
}

pub struct Daemon {
    pub child: Child,
    socket: PathBuf,
}

impl Daemon {
    pub fn ask(&self, request: Request) -> Response {
        let mut stream = Stream::connect(&self.socket).expect("connect to the daemon");
        stream.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        write_message(&mut stream, &request).unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        read_message(&mut reader).unwrap().expect("the daemon hung up without answering")
    }

    pub fn headroom(&self, request: Request) -> HeadroomStatus {
        match self.ask(request) {
            Response::Headroom { status } => status,
            other => panic!("expected a Headroom status, got {other:?}"),
        }
    }

    pub fn status(&self) -> HeadroomStatus {
        self.headroom(Request::GetHeadroomStatus)
    }

    pub fn until_ready(&self) -> HeadroomStatus {
        self.until_ready_within(Duration::from_secs(30))
    }

    pub fn until_ready_within(&self, how_long: Duration) -> HeadroomStatus {
        wait_up_to(how_long, "Headroom to be ready", || {
            let status = self.status();
            status.ready.then_some(status)
        })
    }

    /// The daemon dies where it stands: no shutdown, nothing stopped.
    pub fn crash(mut self) {
        self.child.kill().unwrap();
        self.child.wait().unwrap();
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
