//! One subprocess runner for every git call (spec §2): argv arrays, the
//! user's environment plus GIT_TERMINAL_PROMPT=0, a 10 s timeout with the
//! stdout/stderr pipes drained on threads (the same deadlock avoidance
//! crates/daemon/src/git_status.rs documents), optional stdin.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const GIT_TIMEOUT: Duration = Duration::from_secs(10);
pub const GIT_NOT_FOUND: &str = "git was not found on PATH";

#[derive(Debug)]
pub struct GitOutput {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub code: i32,
}

impl GitOutput {
    pub fn stdout_str(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

/// Runs `git <args>` in `cwd`. `Err` only when git can't be spawned
/// (missing binary → GIT_NOT_FOUND, bad cwd, …) or times out; a non-zero
/// exit is reported through `GitOutput::code` so callers decide.
pub fn run_git(cwd: &str, args: &[&str], stdin: Option<&[u8]>) -> Result<GitOutput, String> {
    // A missing cwd also surfaces as ErrorKind::NotFound from spawn; check it
    // first so that case is never misreported as a missing git binary.
    if !std::path::Path::new(cwd).is_dir() {
        return Err(format!("directory not found: {cwd}"));
    }
    let mut child = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                GIT_NOT_FOUND.to_string()
            } else {
                format!("failed to run git: {e}")
            }
        })?;

    if let Some(bytes) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            let bytes = bytes.to_vec();
            std::thread::spawn(move || {
                let _ = pipe.write_all(&bytes);
            });
        }
    }

    let mut stdout = child.stdout.take().ok_or("git stdout unavailable")?;
    let mut stderr = child.stderr.take().ok_or("git stderr unavailable")?;
    let (out_tx, out_rx) = std::sync::mpsc::channel();
    let (err_tx, err_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = out_tx.send(buf);
    });
    std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf);
        let _ = err_tx.send(buf);
    });

    let deadline = Instant::now() + GIT_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("git {} timed out after {}s", args.join(" "), GIT_TIMEOUT.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(format!("failed waiting for git: {e}")),
        }
    };

    let stdout = out_rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    let stderr = err_rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    Ok(GitOutput { stdout, stderr, code: status.code().unwrap_or(-1) })
}

/// Maps a non-zero exit to `Err(stderr)` — the UI shows that string
/// verbatim (spec §2).
pub fn ok(out: GitOutput) -> Result<GitOutput, String> {
    if out.code == 0 {
        Ok(out)
    } else {
        let msg = out.stderr.trim();
        Err(if msg.is_empty() { format!("git exited with status {}", out.code) } else { msg.to_string() })
    }
}

/// `git` with `--no-optional-locks` prepended: for read-only commands so
/// they never create `.git/index.lock` (top-level option, must precede the
/// subcommand — see crates/daemon/src/git_status.rs).
pub fn run_git_ro(cwd: &str, args: &[&str]) -> Result<GitOutput, String> {
    let mut full = Vec::with_capacity(args.len() + 1);
    full.push("--no-optional-locks");
    full.extend_from_slice(args);
    run_git(cwd, &full, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_git_version_and_captures_stdout() {
        let out = run_git(".", &["--version"], None).unwrap();
        assert_eq!(out.code, 0);
        assert!(out.stdout_str().starts_with("git version"));
    }

    #[test]
    fn non_zero_exit_is_not_an_err_but_ok_maps_it_to_stderr() {
        let out = run_git(".", &["definitely-not-a-subcommand"], None).unwrap();
        assert_ne!(out.code, 0);
        let err = ok(out).unwrap_err();
        assert!(err.contains("definitely-not-a-subcommand"), "{err}");
    }

    #[test]
    fn stdin_is_piped_to_the_child() {
        // `git stripspace` echoes stdin with whitespace normalised: a cheap
        // stdin round-trip that needs no repository.
        let out = run_git(".", &["stripspace"], Some(b"hello   \n\n\n")).unwrap();
        assert_eq!(out.stdout_str(), "hello\n");
    }

    #[test]
    fn missing_cwd_is_a_directory_error_not_a_missing_git_error() {
        let err = run_git("/definitely/not/a/dir", &["--version"], None).unwrap_err();
        assert!(err.starts_with("directory not found:"), "{err}");
        assert_ne!(err, GIT_NOT_FOUND);
    }
}
