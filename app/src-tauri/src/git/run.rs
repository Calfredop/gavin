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
    // An ssh workspace's repo is on the host: the daemon there runs git
    // and returns the same three fields. Every synchronous Git-tab command
    // funnels through here (and through `run_git_ro`, which calls this), so
    // routing this one function is the whole "change only where the process
    // runs" for the tab -- `commands.rs` never learns which machine ran it.
    // The network ops the desktop keeps use `run_git_streaming`, which does
    // not route.
    if let Some(result) = crate::remote::run_git_over_link(cwd, args, stdin) {
        return result.map(|(stdout, stderr, code)| GitOutput { stdout, stderr, code });
    }
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

/// A file inside the repository at `cwd`, read wherever that repository
/// is: `std::fs` for a local checkout, `ReadWorkspaceFile` over the link
/// for one on a host. `Ok(None)` when there is no such file.
///
/// The Git tab reaches past `git` to the disk in exactly two places, and
/// both are here rather than in either of them: `conflict.rs` reads the
/// rebase state under the git dir and the worktree side of a conflicted
/// file, and `ignore.rs` reads `.gitignore` and `.git/info/exclude` after
/// git has located them. `path` is therefore always absolute and always
/// something git just named.
///
/// Two host-side limits worth knowing, both of which surface as an `Err`
/// the caller already knows how to degrade from. A file that is not
/// UTF-8 is refused (the request carries text), which is the same
/// conclusion both callers draw from a binary file anyway. And a path
/// outside the workspace root is refused — which a LINKED worktree's
/// common git dir can be, so `.git/info/exclude` may be unreachable for
/// one over ssh where `.gitignore` at the toplevel is not.
pub fn read_repo_file(cwd: &str, path: &std::path::Path) -> Result<Option<Vec<u8>>, String> {
    if let Some(result) = crate::remote::read_file_over_link(cwd, &protocol::wire_path(path)) {
        return result.map(|text| text.map(String::into_bytes));
    }
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}

/// The write half of `read_repo_file`, for `ignore.rs`'s Save. Parents
/// are created on both sides.
pub fn write_repo_file(cwd: &str, path: &std::path::Path, content: &str) -> Result<(), String> {
    if let Some(result) = crate::remote::write_file_over_link(cwd, &protocol::wire_path(path), content) {
        return result;
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    std::fs::write(path, content).map_err(|e| format!("could not write {}: {e}", path.display()))
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
    // Routed like `run_git`, through its own request rather than a
    // widened `RunGit`: `min_version_for` gates request TYPES, so an
    // `env` field on `RunGit` would be dropped in silence by a v41 host
    // and the cherry-pick would hang on an editor nobody can see.
    if let Some(result) = crate::remote::run_git_env_over_link(cwd, args, env) {
        return result.map(|(stdout, stderr, code)| GitOutput { stdout, stderr, code });
    }
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
///
/// Local only, unlike `run_git` and `run_git_env` above, and deliberately:
/// an op on a host is addressed by an op id (for its progress pushes and
/// its cancel) and this signature has none. `git::ops::run_op` is the
/// layer that has one, so that is where the ssh route lives — see its
/// comment.
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

    /// The file seam `conflict.rs` and `ignore.rs` reach the disk
    /// through. A local cwd takes the `std::fs` path here; the routed one
    /// is exercised where a link exists to route to. What matters on both
    /// sides is the SHAPE -- a missing file is `Ok(None)`, not an error,
    /// because both callers treat "there is no .gitignore yet" and "the
    /// rebase wrote no head-name" as ordinary.
    #[test]
    fn read_repo_file_answers_none_for_a_missing_file_and_bytes_for_a_real_one() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        assert_eq!(read_repo_file(cwd, &dir.path().join("nope.txt")).unwrap(), None);
        std::fs::write(dir.path().join("a.txt"), "hello").unwrap();
        assert_eq!(
            read_repo_file(cwd, &dir.path().join("a.txt")).unwrap(),
            Some(b"hello".to_vec())
        );
    }

    #[test]
    fn write_repo_file_creates_parents_and_overwrites_whole() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        // `.git/info/exclude` is the case that needs the parents: a repo
        // that has never had one has no `info/` either.
        let target = dir.path().join(".git").join("info").join("exclude");
        write_repo_file(cwd, &target, "build/\n").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "build/\n");
        // Verbatim, no reformatting -- what the editor's Save promises.
        write_repo_file(cwd, &target, "# replaced").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "# replaced");
    }

    /// `run_git_env` still runs git with the environment for a local cwd;
    /// the routed arm is its own request (`RunGitEnv`, v42) rather than a
    /// widened `RunGit`, which the protocol crate pins.
    #[test]
    fn run_git_env_sets_the_variable_for_a_local_cwd() {
        let out = run_git_env(".", &["var", "GIT_EDITOR"], &[("GIT_EDITOR", "true")]).unwrap();
        assert_eq!(out.code, 0, "{}", out.stderr);
        assert_eq!(out.stdout_str().trim(), "true");
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
