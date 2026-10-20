//! The daemon's singleton lock, and what anyone else can learn from it.
//!
//! One file per build beside the socket -- `daemon.lock` or
//! `daemon-dev.lock` -- held with `File::try_lock` for the whole life of
//! the daemon that took it, with that daemon's pid written inside. The
//! daemon takes it before it opens a store (`gavin-daemon`'s `serve`);
//! the app reads the pid to know when a stopped daemon has really gone,
//! and gavin-mcp reads it to say why a connect failed.
//!
//! Reading the pid is all a client does. Nobody but a daemon ever TRIES
//! the lock, not even for an instant to see whether it is free: a probe
//! that holds it at the moment a daemon starts is a daemon that refuses
//! to start, and gavin-mcp's sessions probe in a crowd exactly when the
//! app is restarting its daemon.

use std::path::{Path, PathBuf};

/// Where this build's daemon keeps its lock.
pub fn daemon_lock_path() -> anyhow::Result<PathBuf> {
    Ok(crate::app_support_dir()?.join(crate::profile_file_name(
        "daemon",
        "lock",
        crate::BuildProfile::current(),
    )))
}

/// The lock that belongs to the daemon serving `socket`.
///
/// From the socket's own name, not from this build's profile: gavin-mcp
/// is handed its socket by whichever daemon opened its tab
/// (`GAVIN_SESSION_SOCKET`), and that daemon may be the other build.
/// `daemon-dev.sock` sits beside `daemon-dev.lock`, whoever asks.
pub fn lock_path_beside(socket: &Path) -> PathBuf {
    socket.with_extension("lock")
}

/// Who holds a daemon lock, as far as reading the file can tell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockHolder {
    /// No lock file, or one with no pid in it: no daemon of this build
    /// has taken it -- or one too old to know about it is running.
    Nobody,
    /// The pid recorded there, and that process is still running.
    Alive(Option<u32>),
    /// The pid recorded there names a process that has exited. The file
    /// outlives its daemon; the lock on it does not.
    Dead(u32),
}

/// Reads who holds the lock at `path`, without touching the lock.
pub fn lock_holder(path: &Path) -> LockHolder {
    match std::fs::read_to_string(path) {
        Ok(text) => match text.trim().parse::<u32>() {
            Ok(pid) if pid_alive(pid) => LockHolder::Alive(Some(pid)),
            Ok(pid) => LockHolder::Dead(pid),
            Err(_) => LockHolder::Nobody,
        },
        // Windows locks are mandatory: a whole-file `LockFileEx` refuses
        // every other handle's read with ERROR_LOCK_VIOLATION. Refused
        // is itself the answer -- a live daemon holds it -- only without
        // a pid to name.
        #[cfg(windows)]
        Err(e) if e.raw_os_error() == Some(33) => LockHolder::Alive(None),
        Err(_) => LockHolder::Nobody,
    }
}

/// Whether `pid` names a process that has not exited.
///
/// A zombie counts as exited, and that is the case this exists for. A
/// daemon the app spawned stays the app's unreaped child after it dies,
/// so `kill(pid, 0)` -- which answers yes for a zombie -- would hold a
/// restart for its whole timeout and call a dead daemon wedged. An
/// exited process has closed every descriptor it had, its lock among
/// them, whether or not anyone has reaped it.
pub fn pid_alive(pid: u32) -> bool {
    imp::pid_alive(pid)
}

/// Polls `pid_alive` until the process has gone or `timeout` runs out.
/// `true` means it went.
pub fn wait_for_exit(pid: u32, timeout: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if !pid_alive(pid) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[cfg(target_os = "macos")]
mod imp {
    pub fn pid_alive(pid: u32) -> bool {
        // proc_pidinfo, the same call `gavin-daemon`'s `proc::identify`
        // makes, for the one field `kill` cannot see: the status.
        const SIZE: i32 = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        // SAFETY: `info` is a live, correctly-sized `proc_bsdinfo` and
        // SIZE is its size; the kernel writes at most that many bytes.
        let written = unsafe {
            libc::proc_pidinfo(
                pid as i32,
                libc::PROC_PIDTBSDINFO,
                0,
                &mut info as *mut libc::proc_bsdinfo as *mut libc::c_void,
                SIZE,
            )
        };
        written == SIZE && info.pbi_pid == pid && info.pbi_status != libc::SZOMB as u32
    }
}

#[cfg(target_os = "linux")]
mod imp {
    /// A zombie LEADER is not yet an exited process. Exiting a
    /// multithreaded process, the thread-group leader turns zombie while
    /// the other threads are still being torn down, and the open files --
    /// the daemon's lock and its listening socket among them -- are
    /// closed only when the last of those threads is gone. A daemon
    /// caught in that window still holds the lock a restart is waiting
    /// on, and still accepts connections into its backlog, so it is gone
    /// only when no thread of it is left running.
    pub fn pid_alive(pid: u32) -> bool {
        match state_in(&format!("/proc/{pid}/stat")) {
            None => false,
            Some(state) if running(&state) => true,
            Some(_) => std::fs::read_dir(format!("/proc/{pid}/task")).is_ok_and(|tasks| {
                tasks.flatten().any(|task| state_in(&task.path().join("stat")).is_some_and(|s| running(&s)))
            }),
        }
    }

    /// The state field of a `stat` file, if it can be read.
    fn state_in(path: impl AsRef<std::path::Path>) -> Option<String> {
        state_of(&std::fs::read_to_string(path).ok()?).map(str::to_owned)
    }

    /// The state is the first field after the LAST `)`: the name before
    /// it is in parentheses and may hold anything, `)` included.
    pub(super) fn state_of(stat: &str) -> Option<&str> {
        stat.rfind(')').and_then(|i| stat[i + 1..].split_whitespace().next())
    }

    pub(super) fn running(state: &str) -> bool {
        state != "Z" && state != "X"
    }
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
mod imp {
    pub fn pid_alive(pid: u32) -> bool {
        // No portable zombie check here; a zombie reads as alive, the
        // cautious direction for a caller that is waiting on it.
        // SAFETY: `kill` with signal 0 and no pointer arguments.
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

#[cfg(windows)]
mod imp {
    use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    pub fn pid_alive(pid: u32) -> bool {
        // SAFETY: no pointer arguments; the handle is closed below.
        let Ok(handle) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) })
        else {
            return false;
        };
        let mut code: u32 = 0;
        // SAFETY: `code` is a live u32 and the handle is ours.
        let ok = unsafe { GetExitCodeProcess(handle, &mut code) }.is_ok();
        // SAFETY: closing the handle opened above, once.
        unsafe {
            let _ = CloseHandle(handle);
        }
        ok && code == STILL_ACTIVE.0 as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Above every platform's pid ceiling, so it names nothing.
    const NO_SUCH_PID: u32 = i32::MAX as u32;

    #[test]
    fn the_lock_sits_beside_the_socket_under_the_sockets_own_build_name() {
        let dir = Path::new("/state");
        assert_eq!(lock_path_beside(&dir.join("daemon-dev.sock")), dir.join("daemon-dev.lock"));
        assert_eq!(lock_path_beside(&dir.join("daemon.sock")), dir.join("daemon.lock"));
        // And this build's own lock is the one beside this build's socket.
        assert_eq!(
            lock_path_beside(&crate::socket_path().unwrap()),
            daemon_lock_path().unwrap()
        );
    }

    #[test]
    fn this_process_is_alive_and_a_pid_past_the_ceiling_is_not() {
        assert!(pid_alive(std::process::id()));
        assert!(!pid_alive(NO_SUCH_PID));
    }

    #[test]
    fn the_holder_is_read_from_the_file_and_checked_against_the_process_table() {
        // No tempfile in this crate; a name no other test run shares.
        let path = std::env::temp_dir()
            .join(format!("gavin-daemon-lock-test-{}-{}.lock", std::process::id(), crate::random_hex(8).unwrap()));
        assert_eq!(lock_holder(&path), LockHolder::Nobody, "no file");

        std::fs::write(&path, "").unwrap();
        assert_eq!(lock_holder(&path), LockHolder::Nobody, "a file nobody wrote a pid into");

        std::fs::write(&path, format!("{}\n", std::process::id())).unwrap();
        assert_eq!(lock_holder(&path), LockHolder::Alive(Some(std::process::id())));

        std::fs::write(&path, NO_SUCH_PID.to_string()).unwrap();
        assert_eq!(lock_holder(&path), LockHolder::Dead(NO_SUCH_PID));
        let _ = std::fs::remove_file(&path);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_state_is_read_after_the_last_paren_and_only_zombies_and_the_dead_are_gone() {
        assert_eq!(imp::state_of("4242 (a) b) Z 1 4242"), Some("Z"));
        assert_eq!(imp::state_of("4242 (gavin-daemon) S 1"), Some("S"));
        assert_eq!(imp::state_of("garbage"), None);
        for state in ["R", "S", "D", "T", "t", "I"] {
            assert!(imp::running(state), "{state}");
        }
        assert!(!imp::running("Z"));
        assert!(!imp::running("X"));
    }

    #[cfg(unix)]
    #[test]
    fn an_unreaped_child_that_exited_reads_as_gone() {
        // The app's own case: the daemon it spawned is its child, and
        // nothing reaps it after a Shutdown.
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        assert!(wait_for_exit(pid, std::time::Duration::from_secs(5)), "a zombie is not alive");
        child.wait().unwrap();
    }
}
