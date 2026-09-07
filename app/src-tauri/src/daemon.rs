use protocol::transport::Stream;
use protocol::{read_message, write_message, Request, Response};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// `EXE_SUFFIX` rather than a bare name: it is "" on unix and ".exe" on
/// Windows, where a file without it is not executable and `externalBin`
/// bundles the binary WITH it. Same rule in `resolve_mcp_binary_path`,
/// and the absolute path gavin writes into a workspace's agent config
/// has to name the file that actually exists.
pub fn resolve_daemon_binary_path() -> anyhow::Result<PathBuf> {
    let current_exe = std::env::current_exe()?;
    let dir = current_exe
        .parent()
        .ok_or_else(|| anyhow::anyhow!("current_exe has no parent directory"))?;
    Ok(dir.join(format!("gavin-daemon{}", std::env::consts::EXE_SUFFIX)))
}

/// Tries to connect to `socket_path`. If nothing is listening, calls
/// `spawn_daemon` to start a process expected to bind that socket, then
/// polls with a short backoff until the connection succeeds or `timeout`
/// elapses.
pub fn connect_or_spawn(
    socket_path: &Path,
    timeout: Duration,
    mut spawn_daemon: impl FnMut() -> anyhow::Result<std::process::Child>,
) -> anyhow::Result<Stream> {
    if let Ok(stream) = Stream::connect(socket_path) {
        return Ok(stream);
    }

    spawn_daemon()?;

    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(stream) = Stream::connect(socket_path) {
            return Ok(stream);
        }
        if Instant::now() >= deadline {
            anyhow::bail!(
                "daemon did not become reachable at {} within {:?}",
                socket_path.display(),
                timeout
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub fn spawn_real_daemon() -> anyhow::Result<std::process::Child> {
    let binary = resolve_daemon_binary_path()?;
    Ok(Command::new(binary).spawn()?)
}

/// How long a daemon gets to exit after being asked, before the blunt
/// route is used and before a caller looks for a listener again.
///
/// `Request::Shutdown` replies and then calls `std::process::exit`, so
/// the wait is for a process teardown, not for work.
const DAEMON_EXIT_GRACE: Duration = Duration::from_millis(300);

/// Stops the running daemon: over the wire if it can hear, by force if
/// it cannot. The restart path behind the connection-error overlay and
/// the Settings button.
///
/// **Asked first.** `Request::Shutdown` is a clean exit -- the daemon
/// closes its stores rather than losing whatever SQLite had in flight --
/// and it is the only route that exists on every platform. It is not
/// enough on its own, though, and that is the whole reason the second
/// half is still here: `Shutdown` is gated at protocol version 12, so a
/// daemon older than that cannot PARSE the request, and "a daemon too
/// old to talk to" is precisely the failure this function is reached
/// from. A wedged daemon that never replies is the same case.
///
/// So the fallback stays, per platform, and it is by NAME because there
/// is nothing else left to address it by. The socket file a killed
/// daemon leaves behind is removed by the next one when it binds (see
/// `run_server`); the Windows pipe has no such debris.
pub fn stop_running_daemon(socket_path: &Path) -> anyhow::Result<()> {
    if ask_daemon_to_stop(socket_path).is_ok() && wait_until_gone(socket_path) {
        return Ok(());
    }
    kill_running_daemons()?;
    wait_until_gone(socket_path);
    Ok(())
}

/// One `Request::Shutdown`, with the reply read back.
///
/// The reply is what distinguishes "it heard and is going" from "the
/// bytes went into a socket nobody is reading". A read timeout, because
/// a daemon wedged inside a request handler would otherwise hold the
/// restart open forever -- and the caller's answer to that case is the
/// forceful one below, which it cannot reach while blocked here.
fn ask_daemon_to_stop(socket_path: &Path) -> anyhow::Result<()> {
    let mut stream = Stream::connect(socket_path)?;
    stream.set_read_timeout(Some(DAEMON_EXIT_GRACE))?;
    write_message(&mut stream, &Request::Shutdown)?;
    let mut reader = BufReader::new(stream.try_clone()?);
    match read_message::<_, Response>(&mut reader)? {
        Some(Response::Ok) => Ok(()),
        other => anyhow::bail!("daemon answered a Shutdown with {other:?}"),
    }
}

/// Polls until nothing answers on the endpoint, or the grace runs out.
///
/// Asking whether something ANSWERS rather than sleeping a fixed 300ms:
/// the old code slept regardless and still raced, because a dying
/// daemon's socket accepts connections until its process actually goes.
/// `false` means one is still there.
fn wait_until_gone(socket_path: &Path) -> bool {
    let endpoint = protocol::transport::Endpoint::new(socket_path.to_path_buf());
    let deadline = Instant::now() + DAEMON_EXIT_GRACE;
    loop {
        if !protocol::transport::is_listening(&endpoint) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Kills every running gavin-daemon by process name.
///
/// The fallback half of `stop_running_daemon`, and only ever that.
/// `/F` on Windows is not optional: without it `taskkill` posts WM_CLOSE
/// to top-level windows, and a console process that owns none of those
/// is answered with "can only be terminated forcefully" rather than
/// terminated.
fn kill_running_daemons() -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        let status = Command::new("taskkill").args(["/F", "/IM", "gavin-daemon.exe"]).status()?;
        return match status.code() {
            // 128 == "no tasks matching", the normal already-gone case.
            Some(0) | Some(128) => Ok(()),
            other => anyhow::bail!("taskkill exited with {other:?}"),
        };
    }
    #[cfg(not(windows))]
    {
        let status = Command::new("pkill").arg("-x").arg("gavin-daemon").status()?;
        match status.code() {
            // 1 == "no processes matched", which is a normal already-gone case.
            Some(0) | Some(1) => Ok(()),
            other => anyhow::bail!("pkill exited with {other:?}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::transport::Listener;

    #[test]
    fn resolve_daemon_binary_path_is_sibling_of_current_exe() {
        let path = resolve_daemon_binary_path().unwrap();
        let current_exe = std::env::current_exe().unwrap();
        assert_eq!(path.parent(), current_exe.parent());
        // With the platform's executable suffix, which is what
        // `externalBin` bundles and what CreateProcess will run.
        assert_eq!(
            path.file_name().unwrap(),
            std::ffi::OsStr::new(&format!("gavin-daemon{}", std::env::consts::EXE_SUFFIX))
        );
    }

    /// The whole point of asking before killing: a daemon that can hear
    /// the request gets to close its stores.
    #[test]
    fn stop_asks_over_the_wire_and_returns_once_nothing_answers() {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("polite.sock");
        let listener = Listener::bind(&socket_path).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut stream = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let req: Option<Request> = read_message(&mut reader).unwrap();
            tx.send(matches!(req, Some(Request::Shutdown))).unwrap();
            write_message(&mut stream, &Response::Ok).unwrap();
            // Standing in for `std::process::exit`: the endpoint stops
            // answering, which is the only thing the caller can observe.
            drop(reader);
            drop(stream);
            drop(listener);
        });
        stop_running_daemon(&socket_path).unwrap();
        assert!(rx.recv().unwrap(), "the daemon was asked, not killed");
    }

    /// Nothing there at all -- the case every restart hits when the
    /// daemon has already gone -- must not become an error.
    #[test]
    fn stop_is_content_when_nothing_is_listening() {
        let dir = tempfile::tempdir().unwrap();
        stop_running_daemon(&dir.path().join("absent.sock")).unwrap();
    }

    #[test]
    fn connect_or_spawn_returns_immediately_if_already_listening() {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("already.sock");
        let _listener = Listener::bind(&socket_path).unwrap();

        let mut spawn_calls = 0;
        let result = connect_or_spawn(&socket_path, Duration::from_secs(1), || {
            spawn_calls += 1;
            anyhow::bail!("should not be called")
        });

        assert!(result.is_ok());
        assert_eq!(spawn_calls, 0);
    }

    /// A child that stays alive and binds nothing -- what
    /// `connect_or_spawn` is handed when the spawn "succeeds".
    ///
    /// Spelled per platform because there is no one command: `sleep` is
    /// not on Windows, and `timeout` there refuses to run with the
    /// redirected stdin a test harness gives it, so `ping` is the
    /// idiomatic stand-in.
    fn a_child_that_binds_nothing() -> std::io::Result<std::process::Child> {
        #[cfg(unix)]
        {
            Command::new("sleep").arg("5").spawn()
        }
        #[cfg(windows)]
        {
            Command::new("ping")
                .args(["-n", "6", "127.0.0.1"])
                .stdout(std::process::Stdio::null())
                .spawn()
        }
    }

    #[test]
    fn connect_or_spawn_spawns_and_retries_until_listening() {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("spawned.sock");

        // The listener comes up a moment AFTER the spawn hook returns,
        // which is the retry loop's whole reason to exist -- and it is
        // bound in-process rather than by an external `nc -lU`, which
        // exists on neither Windows nor a bare CI image.
        let listening = std::sync::Arc::new(std::sync::Mutex::new(None));
        let result = connect_or_spawn(&socket_path, Duration::from_secs(5), || {
            let path = socket_path.clone();
            let slot = std::sync::Arc::clone(&listening);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(150));
                let listener = Listener::bind(&path).unwrap();
                // Held for the life of the test: dropping it would close
                // the endpoint again mid-connect.
                *slot.lock().unwrap() = Some(listener);
                std::thread::sleep(Duration::from_secs(2));
            });
            Ok(a_child_that_binds_nothing()?)
        });

        assert!(result.is_ok(), "expected connection to succeed");
    }

    #[test]
    fn connect_or_spawn_times_out_if_nothing_ever_listens() {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("never.sock");

        let result = connect_or_spawn(&socket_path, Duration::from_millis(300), || {
            // Spawn "succeeds" but nothing ever binds the endpoint.
            Ok(a_child_that_binds_nothing()?)
        });

        assert!(result.is_err());
    }
}
