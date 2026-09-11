//! One subprocess runner for every git call (spec §2): argv arrays, the
//! user's environment plus GIT_TERMINAL_PROMPT=0, a 10 s timeout with the
//! stdout/stderr pipes drained on threads (the same deadlock avoidance
//! crates/daemon/src/git_status.rs documents), optional stdin.

use std::io::{Read, Write};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const GIT_TIMEOUT: Duration = Duration::from_secs(10);
/// Ceiling for network ops (fetch/pull/push); they stream progress and are
/// cancellable, so this only catches a truly hung transport.
pub const GIT_OP_TIMEOUT: Duration = Duration::from_secs(600);
pub const GIT_NOT_FOUND: &str = "git was not found on PATH";

/// A running long op's child, shared with whoever may cancel it: the
/// canceller `take()`s and kills it, and the runner reports "cancelled".
pub type SharedChild = Arc<Mutex<Option<Child>>>;

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
    let mut child = crate::program::command("git")
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

/// `run_git` with extra environment variables (e.g. `GIT_EDITOR=true` so a
/// `rebase --continue` never opens an editor).
pub fn run_git_env(cwd: &str, args: &[&str], env: &[(&str, &str)]) -> Result<GitOutput, String> {
    if !std::path::Path::new(cwd).is_dir() {
        return Err(format!("directory not found: {cwd}"));
    }
    let out = crate::program::command("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .output()
        .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { GIT_NOT_FOUND.to_string() } else { format!("failed to run git: {e}") })?;
    Ok(GitOutput { stdout: out.stdout, stderr: String::from_utf8_lossy(&out.stderr).into_owned(), code: out.status.code().unwrap_or(-1) })
}

/// Streams git's stderr (its progress channel) line by line — `\r` counts
/// as a line break so progress updates arrive as they are drawn. The child
/// is handed to `register` so a canceller can `take()` and kill it; a taken
/// child makes this return `Err("cancelled")`.
pub fn run_git_streaming(
    cwd: &str,
    args: &[&str],
    on_line: &mut dyn FnMut(String),
    register: &mut dyn FnMut(SharedChild),
) -> Result<(), String> {
    if !std::path::Path::new(cwd).is_dir() {
        return Err(format!("directory not found: {cwd}"));
    }
    let mut child = crate::program::command("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { GIT_NOT_FOUND.to_string() } else { format!("failed to run git: {e}") })?;
    let mut stderr = child.stderr.take().ok_or("git stderr unavailable")?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut acc: Vec<u8> = Vec::new();
        loop {
            let n = match stderr.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            for &b in &buf[..n] {
                if b == b'\n' || b == b'\r' {
                    if !acc.is_empty() {
                        let _ = tx.send(String::from_utf8_lossy(&acc).into_owned());
                        acc.clear();
                    }
                } else {
                    acc.push(b);
                }
            }
        }
        if !acc.is_empty() {
            let _ = tx.send(String::from_utf8_lossy(&acc).into_owned());
        }
    });
    let shared: SharedChild = Arc::new(Mutex::new(Some(child)));
    register(shared.clone());

    let mut tail: Vec<String> = Vec::new();
    let mut push_tail = |line: &str| {
        if tail.len() >= 8 {
            tail.remove(0);
        }
        tail.push(line.to_string());
    };
    let deadline = Instant::now() + GIT_OP_TIMEOUT;
    let status = loop {
        while let Ok(line) = rx.try_recv() {
            push_tail(&line);
            on_line(line);
        }
        {
            let mut guard = shared.lock().unwrap();
            let Some(child) = guard.as_mut() else { return Err("cancelled".to_string()) };
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(format!("git {} timed out after {}s", args.join(" "), GIT_OP_TIMEOUT.as_secs()));
                    }
                }
                Err(e) => return Err(format!("failed waiting for git: {e}")),
            }
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    // Drain what the reader still holds; it ends when the pipe closes.
    while let Ok(line) = rx.recv_timeout(Duration::from_millis(200)) {
        push_tail(&line);
        on_line(line);
    }
    *shared.lock().unwrap() = None;
    if status.success() {
        Ok(())
    } else {
        let msg = tail.iter().filter(|l| !l.trim().is_empty()).cloned().collect::<Vec<_>>().join("\n");
        Err(if msg.is_empty() { format!("git exited with status {}", status.code().unwrap_or(-1)) } else { msg })
    }
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

    #[test]
    fn streaming_delivers_stderr_lines_and_reports_the_error_tail() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        let mut lines = Vec::new();
        // `clone --progress` of a missing path fails fast with a stderr line:
        // enough to prove the stream and the error tail without a network.
        let err = run_git_streaming(
            cwd,
            &["clone", "--progress", "/definitely/missing/repo", "x"],
            &mut |l| lines.push(l),
            &mut |_| {},
        )
        .unwrap_err();
        assert!(!lines.is_empty());
        assert!(err.contains("exist") || err.contains("fatal"), "{err}");
    }

    #[test]
    fn streaming_can_be_cancelled_by_taking_the_child() {
        // The `ext::` transport makes git spawn our sleeper script as the
        // remote and wait on it — a hang we can cancel. (`ext::` splits its
        // command on whitespace, hence a script rather than `sh -c '…'`.)
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        let _ = run_git(cwd, &["init", "-q"], None).unwrap();
        let script = dir.path().join("sleepy.sh");
        std::fs::write(&script, "#!/bin/sh\nsleep 30\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let remote = format!("ext::{} %S", script.display());
        let slot: Arc<Mutex<Option<SharedChild>>> = Arc::new(Mutex::new(None));
        let slot2 = slot.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            loop {
                let registered = slot2.lock().unwrap().clone();
                if let Some(child) = registered {
                    if let Some(mut c) = child.lock().unwrap().take() {
                        let _ = c.kill();
                        let _ = c.wait();
                    }
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        let started = Instant::now();
        let err = run_git_streaming(
            cwd,
            &["-c", "protocol.ext.allow=always", "fetch", "--progress", &remote],
            &mut |_| {},
            &mut |child| *slot.lock().unwrap() = Some(child),
        )
        .unwrap_err();
        canceller.join().unwrap();
        assert_eq!(err, "cancelled");
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
