//! One subprocess runner for every git call (spec §2): argv arrays, the
//! user's environment plus GIT_TERMINAL_PROMPT=0, a deadline with the
//! stdout/stderr pipes drained on threads (the same deadlock avoidance
//! crates/daemon/src/git_status.rs documents), optional stdin.

use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const GIT_TIMEOUT: Duration = Duration::from_secs(10);
/// `GIT_TIMEOUT` for a git that runs on an ssh host. The host kills
/// nothing, so this wait is the only bound it has, and it has a round
/// trip over what may be a slow link to cover as well as the git. What
/// it replaced was the ten minutes a hook-running action gets, for a
/// `git status` -- and a link serves one request at a time, so a host that
/// had stopped answering held every later request that long.
pub const GIT_LINK_TIMEOUT: Duration = Duration::from_secs(30);
/// Ceiling for anything run as an op: the network ops (fetch/pull/push)
/// and the actions that run hooks (`run_git_action`). Both show in the op
/// bar and are cancellable, so this only catches a truly hung transport
/// or hook -- and bounds the rail's branch switch, a checkout with nobody
/// there to press Cancel.
pub const GIT_OP_TIMEOUT: Duration = Duration::from_secs(600);
/// How long a git told to stop gets to stop by itself before it is
/// killed. Git needs microseconds -- the time to unlink its lock files --
/// so this is for a hook that takes no notice of the TERM.
const STOP_GRACE: Duration = Duration::from_secs(2);
pub const GIT_NOT_FOUND: &str = "git was not found on PATH";

/// Set to stop a running git. The runner that owns the process polls it
/// and does the stopping, so a canceller -- `git_cancel_op` -- only ever
/// stores a bool and never waits on the git it is stopping.
pub type CancelFlag = Arc<AtomicBool>;

/// Where a running git's stderr goes, line by line: the op bar's
/// `git-op-progress`. Called on the thread that drains the pipe.
pub type LineSink = Arc<dyn Fn(String) + Send + Sync>;

/// What the owner of an op holds over its git: the flag that cancels it,
/// and where its progress goes. `default()` is neither -- what a test,
/// or the rail's unattended branch switch, runs an action with.
#[derive(Clone, Default)]
pub struct OpControl {
    pub cancel: CancelFlag,
    pub on_line: Option<LineSink>,
}

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

/// Runs `work` on the blocking pool, for a `#[tauri::command] async fn`
/// to await. A plain `fn` command runs on the main thread, where every
/// git process it waits on is a frozen window; `#[tauri::command(async)]`
/// would instead park a runtime worker for up to GIT_TIMEOUT a process.
/// The same call `get_git_baselines` makes, kept to one line per command.
pub async fn off_main_thread<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

/// Runs `git <args>` in `cwd`. `Err` only when git can't be spawned
/// (missing binary → GIT_NOT_FOUND, bad cwd, …) or times out; a non-zero
/// exit is reported through `GitOutput::code` so callers decide.
pub fn run_git(cwd: &str, args: &[&str], stdin: Option<&[u8]>) -> Result<GitOutput, String> {
    run_git_capped(cwd, args, stdin, None)
}

/// `run_git`, keeping at most `stdout_cap + 1` bytes of stdout when a cap
/// is given: one past it is all a caller's `len() > cap` check needs, and
/// the rest is read and dropped rather than kept, so git still runs to its
/// own exit instead of blocking on a full pipe.
fn run_git_capped(cwd: &str, args: &[&str], stdin: Option<&[u8]>, stdout_cap: Option<usize>) -> Result<GitOutput, String> {
    // An ssh workspace's repo is on the host: the daemon there runs git
    // and returns the same three fields. Every Git-tab command that waits
    // for its answer funnels through here (by way of `run_git`, `run_git_ro`
    // or `run_git_ro_capped`) or through `run_git_action`, so routing these
    // two is the whole "change only where the process runs" for the tab --
    // `commands.rs` never learns which machine ran it.
    // The network ops the desktop keeps use `run_git_streaming`, which does
    // not route.
    if let Some(result) = crate::remote::run_git_over_link(cwd, args, stdin, GIT_LINK_TIMEOUT) {
        // The host read all of it; the cap still holds for the caller.
        return result.map(|(mut stdout, stderr, code)| {
            if let Some(cap) = stdout_cap {
                stdout.truncate(cap.saturating_add(1));
            }
            GitOutput { stdout, stderr, code }
        });
    }
    run_local(cwd, args, &[], stdin, stdout_cap, GIT_TIMEOUT, &OpControl::default())
}

/// `run_git` for an action that runs the repository's hooks, signs a
/// commit, or checks files out through a filter: commit, merge, revert,
/// cherry-pick, `--continue` and the checkout family. Those wait on
/// programs the user installed, and sometimes on the user -- a pre-commit
/// suite, a pinentry or Touch ID prompt, an LFS download -- and GIT_TIMEOUT
/// killed them mid-hook: the action failed, the hook ran on orphaned, and
/// `index.lock` stayed behind. So the ceiling is GIT_OP_TIMEOUT, `control`
/// can cancel the action, and its stderr -- where git sends a hook's output
/// -- goes to the op bar while it runs.
///
/// `worktree add` counts as a checkout here. `worktree remove` runs here
/// with a default `control`, for the ceiling alone: deleting a worktree
/// with its build output can take longer than GIT_TIMEOUT, and a remove
/// stopped part-way leaves the tree half deleted.
///
/// `env` is for `GIT_EDITOR=true`, so a cherry-pick or a `--continue`
/// never waits on an editor nobody can see.
pub fn run_git_action(
    cwd: &str,
    args: &[&str],
    env: &[(&str, &str)],
    stdin: Option<&[u8]>,
    control: &OpControl,
) -> Result<GitOutput, String> {
    run_git_action_within(cwd, args, env, stdin, control, GIT_OP_TIMEOUT)
}

fn run_git_action_within(
    cwd: &str,
    args: &[&str],
    env: &[(&str, &str)],
    stdin: Option<&[u8]>,
    control: &OpControl,
    timeout: Duration,
) -> Result<GitOutput, String> {
    // Routed like `run_git`. A call with an environment goes through its
    // own request rather than a widened `RunGit`: `min_version_for` gates
    // request TYPES, so an `env` field on `RunGit` would be dropped in
    // silence by a v41 host and the cherry-pick would hang on an editor
    // nobody can see. `RunGitEnv` carries no stdin, and no caller needs
    // both. Neither request carries a cancel or progress, and the host
    // puts no ceiling on the git: `timeout` bounds the wait for its answer,
    // as it bounds the process here.
    debug_assert!(env.is_empty() || stdin.is_none(), "RunGitEnv carries no stdin");
    let routed = if env.is_empty() {
        crate::remote::run_git_over_link(cwd, args, stdin, timeout)
    } else {
        crate::remote::run_git_env_over_link(cwd, args, env, timeout)
    };
    if let Some(result) = routed {
        return result.map(|(stdout, stderr, code)| GitOutput { stdout, stderr, code });
    }
    run_local(cwd, args, env, stdin, None, timeout, control)
}

/// `git` in `cwd` with what every run gets. On unix it leads a process
/// group of its own, which is how `stop` reaches the hooks, the signing
/// program and the filters git starts, and not git alone.
fn git_command(cwd: &str) -> Command {
    let mut command = crate::program::command("git");
    command.current_dir(cwd).env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
}

fn spawn_error(e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        GIT_NOT_FOUND.to_string()
    } else {
        format!("failed to run git: {e}")
    }
}

/// Stops a git that has to stop: past its deadline, or cancelled.
///
/// SIGTERM to its whole process group first. Git answers a TERM by
/// removing the lock files it holds; a SIGKILL cannot be answered, and
/// left `.git/index.lock` behind for every later git to refuse the
/// repository over until someone deleted it by hand. The group is what
/// reaches a hook git is waiting on -- killing git alone left the hook
/// running, orphaned. A git still there after STOP_GRACE takes the group
/// down with a SIGKILL; it is still unreaped then, so its pid, and with
/// it the group id, cannot have gone to another process.
///
/// Windows has no process group here: git alone is killed, as before.
fn stop(child: &mut Child) {
    #[cfg(unix)]
    {
        let group = -(child.id() as libc::pid_t);
        // SAFETY: kill(2) takes no pointers.
        unsafe { libc::kill(group, libc::SIGTERM) };
        let deadline = Instant::now() + STOP_GRACE;
        loop {
            match child.try_wait() {
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
                Ok(None) => {
                    // SAFETY: as above.
                    unsafe { libc::kill(group, libc::SIGKILL) };
                    break;
                }
                Ok(Some(_)) => return,
                Err(_) => break,
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Reads `r` to its end, handing each line to `on_line` as it arrives,
/// and returns everything read. `\r` ends a line too: git redraws its
/// progress with it, and so does many a hook.
fn read_lines(r: &mut impl Read, on_line: &mut dyn FnMut(String)) -> Vec<u8> {
    let mut all = Vec::new();
    let mut line_start = 0;
    let mut buf = [0u8; 4096];
    loop {
        let n = match r.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for &b in &buf[..n] {
            if b == b'\n' || b == b'\r' {
                if all.len() > line_start {
                    on_line(String::from_utf8_lossy(&all[line_start..]).into_owned());
                }
                all.push(b);
                line_start = all.len();
            } else {
                all.push(b);
            }
        }
    }
    if all.len() > line_start {
        on_line(String::from_utf8_lossy(&all[line_start..]).into_owned());
    }
    all
}

/// Runs git in a local `cwd` until it exits, `timeout` passes, or
/// `control.cancel` is set -- the last two `stop` it and are an `Err`
/// ("cancelled" for a cancel, which the op bar reads). The one local
/// runner behind `run_git` and `run_git_action`.
fn run_local(
    cwd: &str,
    args: &[&str],
    env: &[(&str, &str)],
    stdin: Option<&[u8]>,
    stdout_cap: Option<usize>,
    timeout: Duration,
    control: &OpControl,
) -> Result<GitOutput, String> {
    // A missing cwd also surfaces as ErrorKind::NotFound from spawn; check it
    // first so that case is never misreported as a missing git binary.
    if !std::path::Path::new(cwd).is_dir() {
        return Err(format!("directory not found: {cwd}"));
    }
    #[cfg(test)]
    note_git_call(args);
    let mut child = git_command(cwd)
        .args(args)
        .envs(env.iter().copied())
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(spawn_error)?;

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
        match stdout_cap {
            None => {
                let _ = stdout.read_to_end(&mut buf);
            }
            Some(cap) => {
                let _ = stdout.by_ref().take(cap as u64 + 1).read_to_end(&mut buf);
                let _ = std::io::copy(&mut stdout, &mut std::io::sink());
            }
        }
        let _ = out_tx.send(buf);
    });
    let on_line = control.on_line.clone();
    std::thread::spawn(move || {
        let bytes = match on_line {
            Some(sink) => read_lines(&mut stderr, &mut |line| sink(line)),
            None => {
                let mut buf = Vec::new();
                let _ = stderr.read_to_end(&mut buf);
                buf
            }
        };
        let _ = err_tx.send(String::from_utf8_lossy(&bytes).into_owned());
    });

    // Polled on a doubling pause from 1 ms, not a flat 20: most git reads
    // finish in a few milliseconds, and the flat tick rounded every one up
    // to 20 -- a Git-view refresh runs 14 in a row. Not a blocking `wait`
    // on a helper thread: that thread would own the child, and the kill
    // at the deadline would have to go by pid to a process it may already
    // have reaped.
    let deadline = Instant::now() + timeout;
    let mut pause = Duration::from_millis(1);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if control.cancel.load(Ordering::Relaxed) {
                    stop(&mut child);
                    return Err("cancelled".to_string());
                }
                if Instant::now() >= deadline {
                    stop(&mut child);
                    return Err(format!("git {} timed out after {}s", args.join(" "), timeout.as_secs()));
                }
                std::thread::sleep(pause);
                pause = (pause * 2).min(Duration::from_millis(20));
            }
            Err(e) => return Err(format!("failed waiting for git: {e}")),
        }
    };

    let stdout = out_rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    let stderr = err_rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    Ok(GitOutput { stdout, stderr, code: status.code().unwrap_or(-1) })
}

#[cfg(test)]
thread_local! {
    static GIT_CALLS: std::cell::RefCell<Option<Vec<String>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn note_git_call(args: &[&str]) {
    GIT_CALLS.with(|calls| {
        if let Some(calls) = calls.borrow_mut().as_mut() {
            calls.push(args.join(" "));
        }
    });
}

/// Runs `work` and returns the git command lines it ran, one string each:
/// how a test pins what a read costs in processes. Per thread, so the
/// suite's parallel tests stay out of each other's count -- which also
/// means only a git run on the calling thread is counted.
#[cfg(test)]
pub fn git_calls_of<T>(work: impl FnOnce() -> T) -> (T, Vec<String>) {
    GIT_CALLS.with(|calls| *calls.borrow_mut() = Some(Vec::new()));
    let out = work();
    (out, GIT_CALLS.with(|calls| calls.borrow_mut().take().unwrap_or_default()))
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

/// `run_git_ro` for output that is only wanted up to `max` bytes -- a
/// diff the viewer will refuse past that anyway. See `run_git_capped`.
pub fn run_git_ro_capped(cwd: &str, args: &[&str], max: usize) -> Result<GitOutput, String> {
    let mut full = Vec::with_capacity(args.len() + 1);
    full.push("--no-optional-locks");
    full.extend_from_slice(args);
    run_git_capped(cwd, &full, None, Some(max))
}

/// Streams git's stderr (its progress channel) line by line — `\r` counts
/// as a line break so progress updates arrive as they are drawn. Setting
/// `cancel` stops the child (see `stop`) and makes this return
/// `Err("cancelled")`.
///
/// Local only, unlike `run_git` and `run_git_action` above, and deliberately:
/// an op on a host is addressed by an op id (for its progress pushes and
/// its cancel) and this signature has none. `git::ops::run_op` is the
/// layer that has one, so that is where the ssh route lives — see its
/// comment.
pub fn run_git_streaming(
    cwd: &str,
    args: &[&str],
    on_line: &mut dyn FnMut(String),
    cancel: &AtomicBool,
) -> Result<(), String> {
    if !std::path::Path::new(cwd).is_dir() {
        return Err(format!("directory not found: {cwd}"));
    }
    let mut child = git_command(cwd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(spawn_error)?;
    let mut stderr = child.stderr.take().ok_or("git stderr unavailable")?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        read_lines(&mut stderr, &mut |line| {
            let _ = tx.send(line);
        });
    });

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
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                if cancel.load(Ordering::Relaxed) {
                    stop(&mut child);
                    return Err("cancelled".to_string());
                }
                if Instant::now() >= deadline {
                    stop(&mut child);
                    return Err(format!("git {} timed out after {}s", args.join(" "), GIT_OP_TIMEOUT.as_secs()));
                }
            }
            Err(e) => return Err(format!("failed waiting for git: {e}")),
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    // Drain what the reader still holds; it ends when the pipe closes.
    while let Ok(line) = rx.recv_timeout(Duration::from_millis(200)) {
        push_tail(&line);
        on_line(line);
    }
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

    /// `run_git_action` runs git with the environment for a local cwd;
    /// the routed arm is its own request (`RunGitEnv`, v42) rather than a
    /// widened `RunGit`, which the protocol crate pins.
    #[test]
    fn run_git_action_sets_the_variable_for_a_local_cwd() {
        let out = run_git_action(".", &["var", "GIT_EDITOR"], &[("GIT_EDITOR", "true")], None, &OpControl::default()).unwrap();
        assert_eq!(out.code, 0, "{}", out.stderr);
        assert_eq!(out.stdout_str().trim(), "true");
    }

    #[test]
    fn read_lines_breaks_on_cr_and_lf_and_returns_every_byte() {
        let mut lines = Vec::new();
        let all = read_lines(&mut &b"50%\r100%\ndone\n\nlast"[..], &mut |l| lines.push(l));
        assert_eq!(lines, ["50%", "100%", "done", "last"]);
        assert_eq!(all, b"50%\r100%\ndone\n\nlast");
    }

    /// A temp repo whose pre-commit hook starts a `sleep` it waits on,
    /// records whether git held `index.lock` while it ran, writes the
    /// sleep's pid, and says two lines on stderr first. `hooksPath` is
    /// set outright, so a global one on this machine cannot skip it.
    ///
    /// Committed with COMMIT_ALL, which holds `index.lock` through the
    /// hooks -- as merge, cherry-pick and the checkouts do. A commit of
    /// the index as it stands releases the lock before its hooks when the
    /// refresh changed nothing.
    #[cfg(unix)]
    fn repo_with_a_slow_pre_commit_hook() -> tempfile::TempDir {
        use crate::git::commands::testutil::{git, temp_repo};
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_repo();
        let cwd = dir.path().to_str().unwrap();
        let hooks = dir.path().join("hooks");
        std::fs::create_dir(&hooks).unwrap();
        let hook = hooks.join("pre-commit");
        std::fs::write(
            &hook,
            "#!/bin/sh\n\
             echo 'checking one' >&2\n\
             echo 'checking two' >&2\n\
             test -e .git/index.lock && touch lock-was-held\n\
             sleep 30 &\n\
             echo $! > sleep.pid\n\
             wait\n",
        )
        .unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        git(cwd, &["config", "core.hooksPath", hooks.to_str().unwrap()]);
        std::fs::write(dir.path().join("f.txt"), "changed\n").unwrap();
        dir
    }

    const COMMIT_ALL: &[&str] = &["commit", "-a", "-F", "-"];

    /// The hook's `sleep`, once it has written its pid.
    #[cfg(unix)]
    fn hook_sleep_pid(dir: &tempfile::TempDir) -> libc::pid_t {
        let path = dir.path().join("sleep.pid");
        let started = Instant::now();
        loop {
            if let Some(pid) = std::fs::read_to_string(&path).ok().and_then(|s| s.trim().parse().ok()) {
                return pid;
            }
            assert!(started.elapsed() < Duration::from_secs(10), "the hook never started its sleep");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Whether `pid` is gone. It is not ours to reap -- orphaned, it
    /// belongs to init/launchd -- so this waits a moment for that.
    #[cfg(unix)]
    fn gone(pid: libc::pid_t) -> bool {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(3) {
            // SAFETY: kill(2) with signal 0 only checks the pid.
            if unsafe { libc::kill(pid, 0) } != 0 {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    /// The card's case: a commit whose hook outlives the deadline. The
    /// action fails, and it fails CLEAN -- the hook's own child is gone
    /// rather than orphaned, and `index.lock`, which git held for the
    /// whole hook, is gone too, so the next git can use the repository.
    /// A SIGKILL to git alone left both behind.
    #[cfg(unix)]
    #[test]
    fn an_action_past_its_deadline_is_stopped_with_its_hook_and_leaves_no_index_lock() {
        let dir = repo_with_a_slow_pre_commit_hook();
        let cwd = dir.path().to_str().unwrap();
        // Long enough for the hook to be well under way however loaded
        // the machine is: a stop before it wrote its pid proves nothing.
        let started = Instant::now();
        let err = run_git_action_within(cwd, COMMIT_ALL, &[], Some(b"slow"), &OpControl::default(), Duration::from_secs(2))
            .unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
        let sleep = hook_sleep_pid(&dir);
        assert!(gone(sleep), "the hook's sleep ({sleep}) outlived the stop");
        assert!(dir.path().join("lock-was-held").exists(), "git never held index.lock, so this proves nothing");
        assert!(!dir.path().join(".git/index.lock").exists(), "index.lock left behind");
    }

    #[cfg(unix)]
    #[test]
    fn a_cancelled_action_stops_with_its_hook_says_cancelled_and_streams_until_then() {
        let dir = repo_with_a_slow_pre_commit_hook();
        let cwd = dir.path().to_str().unwrap().to_string();
        let lines = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen = lines.clone();
        let control = OpControl {
            cancel: CancelFlag::default(),
            on_line: Some(Arc::new(move |l| seen.lock().unwrap().push(l))),
        };
        let cancel = control.cancel.clone();
        let hook_dir = dir.path().to_path_buf();
        let canceller = std::thread::spawn(move || {
            // Once the hook is under way, not before.
            while !hook_dir.join("sleep.pid").exists() {
                std::thread::sleep(Duration::from_millis(20));
            }
            cancel.store(true, Ordering::Relaxed);
        });
        let started = Instant::now();
        let err = run_git_action(&cwd, COMMIT_ALL, &[], Some(b"slow"), &control).unwrap_err();
        canceller.join().unwrap();
        assert_eq!(err, "cancelled");
        assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
        assert!(gone(hook_sleep_pid(&dir)), "the hook's sleep outlived the cancel");
        assert!(dir.path().join("lock-was-held").exists(), "git never held index.lock, so this proves nothing");
        assert!(!dir.path().join(".git/index.lock").exists(), "index.lock left behind");
        let lines = lines.lock().unwrap();
        assert!(lines.iter().any(|l| l == "checking one"), "{lines:?}");
        assert!(lines.iter().any(|l| l == "checking two"), "{lines:?}");
    }

    /// A megabyte through a 100-byte cap: 101 bytes come back, and git
    /// still exits 0 -- well past a pipe buffer, so an undrained pipe
    /// would have held it until the timeout instead.
    #[test]
    fn a_capped_read_keeps_one_byte_past_the_cap_and_lets_git_finish() {
        let input = "x".repeat(1 << 20) + "\n";
        let out = run_git_capped(".", &["stripspace"], Some(input.as_bytes()), Some(100)).unwrap();
        assert_eq!(out.code, 0, "{}", out.stderr);
        assert_eq!(out.stdout.len(), 101);
        let whole = run_git(".", &["stripspace"], Some(input.as_bytes())).unwrap();
        assert_eq!(whole.stdout.len(), input.len(), "no cap reads everything");
    }

    #[test]
    fn off_main_thread_runs_the_work_on_another_thread_and_passes_its_result() {
        let caller = std::thread::current().id();
        let ran_on = tauri::async_runtime::block_on(off_main_thread(|| Ok(std::thread::current().id()))).unwrap();
        assert_ne!(ran_on, caller);
        let err = tauri::async_runtime::block_on(off_main_thread(|| Err::<(), _>("nope".to_string())));
        assert_eq!(err, Err("nope".to_string()));
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
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert!(!lines.is_empty());
        assert!(err.contains("exist") || err.contains("fatal"), "{err}");
    }

    #[test]
    fn streaming_can_be_cancelled_by_its_flag() {
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
        let cancel = CancelFlag::default();
        let flag = cancel.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            flag.store(true, Ordering::Relaxed);
        });
        let started = Instant::now();
        let err = run_git_streaming(
            cwd,
            &["-c", "protocol.ext.allow=always", "fetch", "--progress", &remote],
            &mut |_| {},
            &cancel,
        )
        .unwrap_err();
        canceller.join().unwrap();
        assert_eq!(err, "cancelled");
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
