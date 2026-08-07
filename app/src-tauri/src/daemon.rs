use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

pub fn resolve_daemon_binary_path() -> anyhow::Result<PathBuf> {
    let current_exe = std::env::current_exe()?;
    let dir = current_exe
        .parent()
        .ok_or_else(|| anyhow::anyhow!("current_exe has no parent directory"))?;
    Ok(dir.join("gavin-daemon"))
}

/// Tries to connect to `socket_path`. If nothing is listening, calls
/// `spawn_daemon` to start a process expected to bind that socket, then
/// polls with a short backoff until the connection succeeds or `timeout`
/// elapses.
pub fn connect_or_spawn(
    socket_path: &Path,
    timeout: Duration,
    mut spawn_daemon: impl FnMut() -> anyhow::Result<std::process::Child>,
) -> anyhow::Result<UnixStream> {
    if let Ok(stream) = UnixStream::connect(socket_path) {
        return Ok(stream);
    }

    spawn_daemon()?;

    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(stream) = UnixStream::connect(socket_path) {
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

/// Kills every running gavin-daemon by process name -- the restart
/// recovery path behind the connection-error overlay.
///
/// By NAME, not over the wire: the daemon this exists to replace is one
/// too old to parse current requests (that is the whole failure being
/// recovered from), so no protocol-level "shut down" could reach it. The
/// socket file it leaves behind is removed by the next daemon when it
/// binds (see run_server), so nothing else needs cleaning up here.
pub fn kill_running_daemons() -> anyhow::Result<()> {
    let status = Command::new("pkill").arg("-x").arg("gavin-daemon").status()?;
    match status.code() {
        // 1 == "no processes matched", which is a normal already-gone case.
        Some(0) | Some(1) => Ok(()),
        other => anyhow::bail!("pkill exited with {other:?}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    #[test]
    fn resolve_daemon_binary_path_is_sibling_of_current_exe() {
        let path = resolve_daemon_binary_path().unwrap();
        let current_exe = std::env::current_exe().unwrap();
        assert_eq!(path.parent(), current_exe.parent());
        assert_eq!(path.file_name().unwrap(), "gavin-daemon");
    }

    #[test]
    fn connect_or_spawn_returns_immediately_if_already_listening() {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("already.sock");
        let _listener = UnixListener::bind(&socket_path).unwrap();

        let mut spawn_calls = 0;
        let result = connect_or_spawn(&socket_path, Duration::from_secs(1), || {
            spawn_calls += 1;
            anyhow::bail!("should not be called")
        });

        assert!(result.is_ok());
        assert_eq!(spawn_calls, 0);
    }

    #[test]
    fn connect_or_spawn_spawns_and_retries_until_listening() {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("spawned.sock");

        let result = connect_or_spawn(&socket_path, Duration::from_secs(5), || {
            Ok(Command::new("nc").arg("-lU").arg(&socket_path).spawn()?)
        });

        assert!(result.is_ok(), "expected connection to succeed");
    }

    #[test]
    fn connect_or_spawn_times_out_if_nothing_ever_listens() {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("never.sock");

        let result = connect_or_spawn(&socket_path, Duration::from_millis(300), || {
            // Spawn "succeeds" but this process never actually binds the socket.
            Ok(Command::new("sleep").arg("5").spawn()?)
        });

        assert!(result.is_err());
    }
}
