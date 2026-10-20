//! One daemon per build, enforced by the kernel.
//!
//! The socket used to be the only guard, and it is checked last: a second
//! daemon of the same build ran `Registry::open` (bumping the generation),
//! `recover()` (marking the live daemon's sessions interrupted and opening
//! stray shells), the browser sweep and Headroom's resume, and minted a
//! fresh token the app no longer matched -- all before `bind_server`
//! found someone answering and gave up. This lock is taken before any of
//! that, so a second daemon touches nothing at all.

use std::fs::File;
use std::io::Write;
use std::path::Path;

/// The held lock. Dropped only when the process exits, which is when the
/// kernel releases it anyway: `serve` keeps it in a local that outlives
/// the accept loop.
///
/// Not inherited by anything the daemon starts: std opens files
/// close-on-exec on unix and non-inheritable on Windows. That matters
/// more than it looks -- an agent that outlives its daemon (an orphan,
/// `recover`'s whole subject) holding this descriptor would keep every
/// later daemon from starting.
#[derive(Debug)]
pub struct Singleton {
    _file: File,
}

/// Takes the lock at `path` and writes this process's pid into it, or
/// says who holds it.
pub fn acquire(path: &Path) -> anyhow::Result<Singleton> {
    let mut file = File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| anyhow::anyhow!("could not open {}: {e}", path.display()))?;
    match file.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => {
            let holder = match protocol::daemon_lock::lock_holder(path) {
                protocol::daemon_lock::LockHolder::Alive(Some(pid)) => format!("pid {pid}"),
                _ => "another process".to_string(),
            };
            anyhow::bail!(
                "another gavin-daemon ({holder}) holds {}; this one is exiting without touching anything",
                path.display()
            );
        }
        Err(std::fs::TryLockError::Error(e)) => {
            anyhow::bail!("could not lock {}: {e}", path.display())
        }
    }
    // Truncated only now that it is ours: the holder's pid must survive a
    // refused second daemon, which is what gavin-mcp reads to explain a
    // failed connect.
    file.set_len(0)?;
    writeln!(file, "{}", std::process::id())?;
    file.flush()?;
    Ok(Singleton { _file: file })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_holder_is_refused_naming_the_first_and_leaves_its_pid_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon-dev.lock");
        let first = acquire(&path).unwrap();
        let recorded = std::fs::read_to_string(&path).unwrap();
        assert_eq!(recorded.trim(), std::process::id().to_string());

        // A second `File` is a second open file description, so the
        // kernel refuses it even from the same process.
        let err = acquire(&path).unwrap_err().to_string();
        assert!(err.contains("another gavin-daemon"), "{err}");
        // Windows refuses any read of a locked file, so there the line
        // says "another process" and the pid cannot be read back.
        #[cfg(unix)]
        {
            assert!(err.contains(&format!("pid {}", std::process::id())), "{err}");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), recorded, "the refusal truncated the pid");
        }

        drop(first);
        acquire(&path).expect("released with its holder");
    }
}
