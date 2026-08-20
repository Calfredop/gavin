# Git Tab — Sync, Branches, Stashes (SP2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch/Pull/Push with streamed progress and cancel, a refs snapshot (branches with tracking counts, remotes, stashes), branch/remote/stash actions in a sectioned sidebar, and Abort/Continue for in-progress merges/rebases — all on top of SP1's Git tab.

**Architecture:** A streaming variant of SP1's runner reads git's stderr progress line by line and is cancellable through an op registry; long ops are async Tauri commands that emit `git-op-progress`. `git_refs` returns one snapshot built from `for-each-ref`/`remote -v`/`stash list`. The frontend store gains `refs`, an op lifecycle beside SP1's `busy` gate, and a nav selection; the toolbar grows Fork's Fetch/Pull/Push/Stash/Pop, and `GitNav` becomes collapsible sections.

**Tech Stack:** as SP1 (Rust/tauri 2, Svelte 5, Vitest). Tests use a bare temp repo as an offline remote.

**Spec:** `docs/superpowers/specs/2026-08-20-git-tab-sync-worktrees-design.md` §1–2, §4–5.

## Global Constraints

- SP1's constraints hold (argv arrays, `--no-optional-locks` on reads, stderr verbatim, no timers, `run()` gate).
- Long ops: `--progress`, 10-minute ceiling (`GIT_OP_TIMEOUT`), stderr streamed as `git-op-progress { opId, line }`, cancel kills the child and yields the error string `cancelled`.
- One long op at a time and never concurrently with a `run()` mutation.
- `GIT_TERMINAL_PROMPT=0` stays; no credential prompting (G13). `GIT_EDITOR=true` on `rebase --continue`.
- No force push (G10). No auto-stash on checkout (G14).

## File structure

**Rust** — `app/src-tauri/src/git/`: `run.rs` (+ `run_git_streaming`, `SharedChild`), `ops.rs` (new: `GitOps` registry, `git_fetch/pull/push/cancel_op`), `parse.rs` (+ `parse_track`, `parse_branches`, `parse_remotes`, `parse_stashes`), `types.rs` (+ `BranchInfo`, `RemoteInfo`, `StashInfo`, `WorktreeInfo`, `RefsSnapshot`), `commands.rs` (+ refs, branch/remote/stash/abort/continue commands + tests), `mod.rs`, `lib.rs` (register).

**TS** — `git.ts` (types), `backend.ts` (wrappers), `gitState.ts` (+ tests), new `GitToolbar.svelte`, `GitOpBar.svelte`, `GitStashDialog.svelte`, `GitPromptDialog.svelte`; modified `GitHubView.svelte`, `GitNav.svelte`, `GitChanges.svelte`, `GitDiff.svelte`, `GitDiscardDialog.svelte` (gains `confirmLabel`), `workspace.ts`/`config.rs` (`gitView.navCollapsed`), `smokeChecklist.ts`.

---

### Task 1: Streaming runner, op registry, fetch/pull/push

**Files:** modify `run.rs`, create `ops.rs`, modify `mod.rs`, `lib.rs`.

**Interfaces:**
- `run::SharedChild = Arc<Mutex<Option<Child>>>`
- `run::run_git_streaming(cwd: &str, args: &[&str], on_line: &mut dyn FnMut(String), register: &mut dyn FnMut(SharedChild)) -> Result<(), String>` — `Err("cancelled")` if the child was taken by a canceller, `Err(stderr tail)` on non-zero exit, `Err("… timed out …")` after `GIT_OP_TIMEOUT`.
- `ops::GitOps(Arc<Mutex<HashMap<String, SharedChild>>>)` (Clone, Default) managed state; `ops::cancel(ops, op_id) -> bool`.
- Commands: `git_fetch(cwd, remote, op_id)`, `git_pull(cwd, op_id)`, `git_push(cwd, remote, op_id)`, `git_cancel_op(op_id)`; event `git-op-progress { opId, line }`.

- [ ] **Step 1: Tests** (in `run.rs` tests module, new `ops.rs` tests using `commands::testutil`):

```rust
// run.rs
#[test]
fn streaming_delivers_stderr_lines_and_succeeds() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let mut lines = Vec::new();
    // `git init` is quiet on stderr; `clone --progress` of a nonexistent path fails
    // fast with a stderr line — enough to prove the stream + the error tail.
    let err = run_git_streaming(cwd, &["clone", "--progress", "/definitely/missing/repo", "x"], &mut |l| lines.push(l), &mut |_| {}).unwrap_err();
    assert!(!lines.is_empty());
    assert!(err.contains("does not exist") || err.contains("not exist") || err.contains("fatal"), "{err}");
}

#[test]
fn streaming_can_be_cancelled_by_taking_the_child() {
    // `ext::` transport spawns `sh -c 'sleep 30'` as the remote and waits on it.
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let _ = run_git(cwd, &["init", "-q"], None).unwrap();
    let shared: Arc<Mutex<Option<SharedChild>>> = Arc::new(Mutex::new(None));
    let s2 = shared.clone();
    let canceller = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        loop {
            if let Some(child) = s2.lock().unwrap().clone() {
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
        &["-c", "protocol.ext.allow=always", "fetch", "--progress", "ext::sh -c 'sleep 30'"],
        &mut |_| {},
        &mut |child| *shared.lock().unwrap() = Some(child),
    )
    .unwrap_err();
    canceller.join().unwrap();
    assert_eq!(err, "cancelled");
    assert!(started.elapsed() < Duration::from_secs(10));
}
```

```rust
// ops.rs
#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::commands::testutil::*;
    use crate::git::commands::{refs, status};

    /// A bare "remote" plus a clone with one commit pushed, returning (bare, clone).
    pub(crate) fn remote_and_clone() -> (tempfile::TempDir, tempfile::TempDir) {
        let src = temp_repo();
        let bare = tempfile::tempdir().unwrap();
        git(cwd(&src), &["clone", "-q", "--bare", ".", bare.path().to_str().unwrap()]);
        let clone = tempfile::tempdir().unwrap();
        git(cwd(&src), &["clone", "-q", bare.path().to_str().unwrap(), clone.path().to_str().unwrap()]);
        git(cwd(&clone), &["config", "user.email", "t@example.com"]);
        git(cwd(&clone), &["config", "user.name", "T"]);
        git(cwd(&clone), &["config", "commit.gpgsign", "false"]);
        (bare, clone)
    }

    #[test]
    fn fetch_pull_push_round_trip_against_a_bare_remote() {
        let (bare, clone) = remote_and_clone();
        // Someone else pushes a commit.
        let other = tempfile::tempdir().unwrap();
        git(cwd(&clone), &["clone", "-q", bare.path().to_str().unwrap(), other.path().to_str().unwrap()]);
        git(cwd(&other), &["config", "user.email", "o@example.com"]);
        git(cwd(&other), &["config", "user.name", "O"]);
        git(cwd(&other), &["config", "commit.gpgsign", "false"]);
        write(&other, "o.txt", "o\n");
        git(cwd(&other), &["add", "o.txt"]);
        git(cwd(&other), &["commit", "-q", "-m", "other"]);
        git(cwd(&other), &["push", "-q"]);

        let mut lines = Vec::new();
        fetch_blocking(cwd(&clone), "origin", &mut |l| lines.push(l)).unwrap();
        let r = refs(cwd(&clone)).unwrap();
        let main = r.branches.iter().find(|b| b.current).unwrap();
        assert_eq!((main.ahead, main.behind), (0, 1));

        pull_blocking(cwd(&clone), &mut |_| {}).unwrap();
        assert!(clone.path().join("o.txt").exists());

        // Publish a new branch: no upstream → push -u.
        git(cwd(&clone), &["switch", "-q", "-c", "feature"]);
        write(&clone, "f2.txt", "f\n");
        git(cwd(&clone), &["add", "f2.txt"]);
        git(cwd(&clone), &["commit", "-q", "-m", "feature"]);
        push_blocking(cwd(&clone), "origin", &mut |_| {}).unwrap();
        let r = refs(cwd(&clone)).unwrap();
        let feature = r.branches.iter().find(|b| b.name == "feature").unwrap();
        assert_eq!(feature.upstream.as_deref(), Some("origin/feature"));
        assert!(status(cwd(&clone)).unwrap().unstaged.is_empty());
    }
}
```

- [ ] **Step 2: Run** `cargo test -p app git::run git::ops` → compile errors.
- [ ] **Step 3: Implement** in `run.rs`:

```rust
pub const GIT_OP_TIMEOUT: Duration = Duration::from_secs(600);
pub type SharedChild = Arc<Mutex<Option<Child>>>;

/// Streams git's stderr (its progress channel) line by line — `\r` counts as
/// a line break so progress updates arrive as they are drawn. The child is
/// handed to `register` so a canceller can `take()` it and kill it; a taken
/// child makes this return `Err("cancelled")`.
pub fn run_git_streaming(cwd: &str, args: &[&str], on_line: &mut dyn FnMut(String), register: &mut dyn FnMut(SharedChild)) -> Result<(), String> {
    if !std::path::Path::new(cwd).is_dir() { return Err(format!("directory not found: {cwd}")); }
    let mut child = Command::new("git").args(args).current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped())
        .spawn().map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { GIT_NOT_FOUND.to_string() } else { format!("failed to run git: {e}") })?;
    let mut stderr = child.stderr.take().ok_or("git stderr unavailable")?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut acc: Vec<u8> = Vec::new();
        loop {
            let n = match stderr.read(&mut buf) { Ok(0) | Err(_) => break, Ok(n) => n };
            for &b in &buf[..n] {
                if b == b'\n' || b == b'\r' {
                    if !acc.is_empty() { let _ = tx.send(String::from_utf8_lossy(&acc).into_owned()); acc.clear(); }
                } else { acc.push(b); }
            }
        }
        if !acc.is_empty() { let _ = tx.send(String::from_utf8_lossy(&acc).into_owned()); }
    });
    let shared: SharedChild = Arc::new(Mutex::new(Some(child)));
    register(shared.clone());
    let mut tail: Vec<String> = Vec::new();
    let deadline = Instant::now() + GIT_OP_TIMEOUT;
    let status = loop {
        while let Ok(line) = rx.try_recv() { if tail.len() >= 8 { tail.remove(0); } tail.push(line.clone()); on_line(line); }
        let mut guard = shared.lock().unwrap();
        let Some(child) = guard.as_mut() else { return Err("cancelled".to_string()) };
        match child.try_wait() {
            Ok(Some(s)) => { break s; }
            Ok(None) => {
                if Instant::now() >= deadline { let _ = child.kill(); let _ = child.wait(); return Err(format!("git {} timed out after {}s", args.join(" "), GIT_OP_TIMEOUT.as_secs())); }
            }
            Err(e) => return Err(format!("failed waiting for git: {e}")),
        }
        drop(guard);
        std::thread::sleep(Duration::from_millis(30));
    };
    // Drain what the reader still has (it ends when the pipe closes).
    while let Ok(line) = rx.recv_timeout(Duration::from_millis(200)) { if tail.len() >= 8 { tail.remove(0); } tail.push(line.clone()); on_line(line); }
    *shared.lock().unwrap() = None;
    if status.success() { Ok(()) } else {
        let msg = tail.iter().filter(|l| !l.trim().is_empty()).cloned().collect::<Vec<_>>().join("\n");
        Err(if msg.is_empty() { format!("git exited with status {}", status.code().unwrap_or(-1)) } else { msg })
    }
}
```
(add `use std::sync::{Arc, Mutex}; use std::process::Child;`)

`ops.rs`:
```rust
//! Long-running git ops (fetch/pull/push): streamed progress, cancellable.
use crate::git::run::{run_git_ro, run_git_streaming, SharedChild};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Default)]
pub struct GitOps(pub Arc<Mutex<HashMap<String, SharedChild>>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress { op_id: String, line: String }

pub fn cancel(ops: &GitOps, op_id: &str) -> bool {
    let child = ops.0.lock().unwrap().remove(op_id);
    match child {
        Some(shared) => { if let Some(mut c) = shared.lock().unwrap().take() { let _ = c.kill(); let _ = c.wait(); } true }
        None => false,
    }
}

fn current_branch(cwd: &str) -> Result<String, String> {
    let out = run_git_ro(cwd, &["symbolic-ref", "--short", "-q", "HEAD"])?;
    if out.code != 0 { return Err("detached HEAD: check out a branch first".into()); }
    Ok(out.stdout_str().trim().to_string())
}
fn has_upstream(cwd: &str) -> Result<bool, String> {
    Ok(run_git_ro(cwd, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])?.code == 0)
}

pub fn fetch_blocking(cwd: &str, remote: &str, on_line: &mut dyn FnMut(String)) -> Result<(), String> {
    run_git_streaming(cwd, &["fetch", "--progress", "--prune", remote], on_line, &mut |_| {})
}
pub fn pull_blocking(cwd: &str, on_line: &mut dyn FnMut(String)) -> Result<(), String> {
    run_git_streaming(cwd, &["pull", "--progress"], on_line, &mut |_| {})
}
pub fn push_blocking(cwd: &str, remote: &str, on_line: &mut dyn FnMut(String)) -> Result<(), String> {
    if has_upstream(cwd)? { run_git_streaming(cwd, &["push", "--progress"], on_line, &mut |_| {}) }
    else { let b = current_branch(cwd)?; run_git_streaming(cwd, &["push", "--progress", "-u", remote, &b], on_line, &mut |_| {}) }
}

fn run_op(ops: GitOps, app: AppHandle, op_id: String, cwd: String, args: Vec<String>) -> Result<(), String> {
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let emitter = app.clone();
    let id = op_id.clone();
    let registry = ops.clone();
    let reg_id = op_id.clone();
    let result = run_git_streaming(&cwd, &argv, &mut |line| { let _ = emitter.emit("git-op-progress", Progress { op_id: id.clone(), line }); },
        &mut |child| { registry.0.lock().unwrap().insert(reg_id.clone(), child); });
    ops.0.lock().unwrap().remove(&op_id);
    result
}

async fn spawn_op(ops: GitOps, app: AppHandle, op_id: String, cwd: String, args: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run_op(ops, app, op_id, cwd, args)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_fetch(cwd: String, remote: String, op_id: String, app: AppHandle, ops: State<'_, GitOps>) -> Result<(), String> {
    spawn_op(ops.inner().clone(), app, op_id, cwd, vec!["fetch".into(), "--progress".into(), "--prune".into(), remote]).await
}
#[tauri::command]
pub async fn git_pull(cwd: String, op_id: String, app: AppHandle, ops: State<'_, GitOps>) -> Result<(), String> {
    spawn_op(ops.inner().clone(), app, op_id, cwd, vec!["pull".into(), "--progress".into()]).await
}
#[tauri::command]
pub async fn git_push(cwd: String, remote: String, op_id: String, app: AppHandle, ops: State<'_, GitOps>) -> Result<(), String> {
    let args = if has_upstream(&cwd)? { vec!["push".into(), "--progress".into()] } else { let b = current_branch(&cwd)?; vec!["push".into(), "--progress".into(), "-u".into(), remote, b] };
    spawn_op(ops.inner().clone(), app, op_id, cwd, args).await
}
#[tauri::command]
pub fn git_cancel_op(op_id: String, ops: State<'_, GitOps>) -> bool { cancel(ops.inner(), &op_id) }
```
Register: `pub mod ops; pub use ops::*;` in `mod.rs`; `.manage(git::GitOps::default())` and the four commands in `lib.rs`.

- [ ] **Step 4: Run** `cargo test -p app git::` → all pass (the ops test depends on Task 2's `refs` — implement Tasks 1–2 together if compiling in isolation is awkward; commit after both are green).
- [ ] **Step 5: Commit** `feat(git): streaming runner with cancel; fetch/pull/push ops`.

---

### Task 2: Refs snapshot

**Files:** `types.rs`, `parse.rs`, `commands.rs`.

**Interfaces:** types per spec §1.2 (serde camelCase; `WorktreeInfo` defined now, `worktrees` filled by SP3 — SP2 returns `vec![]`); `parse::parse_track(&str) -> (u32, u32, bool /*gone*/)`, `parse_branches(raw)`, `parse_remotes(urls_raw, refs_raw)`, `parse_stashes(raw)`; `commands::refs(cwd) -> Result<RefsSnapshot, String>` + `git_refs`.

- [ ] **Step 1: Tests** (`parse.rs` new `refs_tests`):
```rust
#[test] fn track_parses_ahead_behind_gone_and_empty() {
    assert_eq!(parse_track("[ahead 2, behind 1]"), (2, 1, false));
    assert_eq!(parse_track("[ahead 3]"), (3, 0, false));
    assert_eq!(parse_track("[behind 4]"), (0, 4, false));
    assert_eq!(parse_track("[gone]"), (0, 0, true));
    assert_eq!(parse_track(""), (0, 0, false));
}
#[test] fn branches_parse_current_upstream_and_counts() {
    let raw = "main\0*\0origin/main\0[ahead 1]\0abc1234\0base commit\nfeature\0 \0\0\0def5678\0wip\n";
    let b = parse_branches(raw);
    assert_eq!(b.len(), 2);
    assert!(b[0].current && b[0].upstream.as_deref() == Some("origin/main") && b[0].ahead == 1 && b[0].subject == "base commit");
    assert!(!b[1].current && b[1].upstream.is_none());
}
#[test] fn remotes_group_branches_and_drop_head_pointers() {
    let urls = "origin\tgit@github.com:a/b.git (fetch)\norigin\tgit@github.com:a/b.git (push)\nupstream\thttps://x/y (fetch)\n";
    let refs = "origin/HEAD\norigin/main\norigin/feature\n";
    let r = parse_remotes(urls, refs);
    assert_eq!(r.len(), 2);
    assert_eq!((r[0].name.as_str(), r[0].branches.as_slice()), ("origin", &["main".to_string(), "feature".to_string()][..]));
    assert_eq!(r[0].url, "git@github.com:a/b.git");
    assert!(r[1].branches.is_empty());
}
#[test] fn stashes_parse_index_message_and_date() {
    let s = parse_stashes("stash@{0}\0WIP on main: abc msg\02 minutes ago\nstash@{1}\0On feature: x\03 days ago\n");
    assert_eq!(s.len(), 2);
    assert_eq!((s[1].index, s[1].message.as_str(), s[1].date.as_str()), (1, "On feature: x", "3 days ago"));
}
```
And in `commands.rs` `read_tests`:
```rust
#[test] fn refs_snapshot_from_a_real_repo_with_a_stash() {
    let dir = temp_repo();
    git(cwd(&dir), &["branch", "other"]);
    write(&dir, "f.txt", "changed\n");
    git(cwd(&dir), &["stash", "push", "-q", "-m", "my stash"]);
    let r = refs(cwd(&dir)).unwrap();
    assert_eq!(r.head_branch.as_deref(), Some("main"));
    assert_eq!(r.branches.iter().filter(|b| b.current).count(), 1);
    assert!(r.branches.iter().any(|b| b.name == "other"));
    assert!(r.remotes.is_empty());
    assert_eq!(r.stashes[0].message, "On main: my stash");
    assert!(r.worktrees.is_empty());
}
```
- [ ] **Step 2: Run** → compile errors. **Step 3: Implement** types (spec §1.2, `#[serde(rename_all = "camelCase")]`, `Default` on `RefsSnapshot`), parsers:
```rust
pub fn parse_track(s: &str) -> (u32, u32, bool) {
    let s = s.trim().trim_start_matches('[').trim_end_matches(']');
    if s == "gone" { return (0, 0, true); }
    let (mut a, mut b) = (0, 0);
    for part in s.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") { a = n.parse().unwrap_or(0); }
        if let Some(n) = part.strip_prefix("behind ") { b = n.parse().unwrap_or(0); }
    }
    (a, b, false)
}
pub fn parse_branches(raw: &str) -> Vec<BranchInfo> {
    raw.lines().filter(|l| !l.is_empty()).filter_map(|l| {
        let f: Vec<&str> = l.split('\0').collect();
        if f.len() < 6 { return None; }
        let (ahead, behind, _gone) = parse_track(f[3]);
        Some(BranchInfo { name: f[0].into(), current: f[1] == "*", upstream: (!f[2].is_empty()).then(|| f[2].to_string()), ahead, behind, sha: f[4].into(), subject: f[5].into() })
    }).collect()
}
pub fn parse_remotes(urls_raw: &str, refs_raw: &str) -> Vec<RemoteInfo> {
    let mut remotes: Vec<RemoteInfo> = Vec::new();
    for l in urls_raw.lines() {
        let mut it = l.split('\t');
        let (Some(name), Some(rest)) = (it.next(), it.next()) else { continue };
        if !rest.ends_with("(fetch)") { continue; }
        let url = rest.trim_end_matches("(fetch)").trim().to_string();
        if !remotes.iter().any(|r| r.name == name) { remotes.push(RemoteInfo { name: name.into(), url, branches: vec![] }); }
    }
    for l in refs_raw.lines() {
        let Some((remote, branch)) = l.split_once('/') else { continue };
        if branch == "HEAD" { continue; }
        if let Some(r) = remotes.iter_mut().find(|r| r.name == remote) { r.branches.push(branch.into()); }
    }
    remotes
}
pub fn parse_stashes(raw: &str) -> Vec<StashInfo> {
    raw.lines().filter_map(|l| {
        let f: Vec<&str> = l.split('\0').collect();
        if f.len() < 3 { return None; }
        let index = f[0].trim_start_matches("stash@{").trim_end_matches('}').parse().ok()?;
        Some(StashInfo { index, message: f[1].into(), date: f[2].into() })
    }).collect()
}
```
and `refs()`:
```rust
pub fn refs(cwd: &str) -> Result<RefsSnapshot, String> {
    let heads = ok(run_git_ro(cwd, &["for-each-ref", "--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)%00%(objectname:short)%00%(subject)", "refs/heads"])?)?.stdout_str();
    let remote_refs = ok(run_git_ro(cwd, &["for-each-ref", "--format=%(refname:short)", "refs/remotes"])?)?.stdout_str();
    let remote_urls = ok(run_git_ro(cwd, &["remote", "-v"])?)?.stdout_str();
    let stash_raw = ok(run_git_ro(cwd, &["stash", "list", "--format=%gd%00%gs%00%cr"])?)?.stdout_str();
    let branches = parse_branches(&heads);
    let head_branch = branches.iter().find(|b| b.current).map(|b| b.name.clone());
    Ok(RefsSnapshot { branches, remotes: parse_remotes(&remote_urls, &remote_refs), stashes: parse_stashes(&stash_raw), worktrees: vec![], head_branch })
}
#[tauri::command] pub fn git_refs(cwd: String) -> Result<RefsSnapshot, String> { refs(&cwd) }
```
- [ ] **Step 4: Run** `cargo test -p app git::` → pass. **Step 5: Commit** `feat(git): refs snapshot — branches with tracking, remotes, stashes`.

---

### Task 3: Branch, remote, stash, abort/continue commands

**Files:** `commands.rs`, `lib.rs`.

**Interfaces:** plain fns + `git_*` commands per spec §1.3: `checkout(cwd, name, track_remote: Option<&str>)`, `create_branch(cwd, name, from: Option<&str>, checkout: bool)`, `delete_branch(cwd, name, force)`, `merge(cwd, branch)`, `abort_in_progress(cwd, kind)`, `continue_rebase(cwd)`, `add_remote`, `remove_remote`, `stash_push(cwd, message, include_untracked)`, `stash_pop/apply/drop(cwd, index)`, `stash_files(cwd, index) -> Vec<FileEntry>`.

- [ ] **Step 1: Tests** (`commands.rs` new `ref_tests`):
```rust
#[test] fn create_checkout_and_delete_branches() {
    let dir = temp_repo();
    create_branch(cwd(&dir), "feature", None, true).unwrap();
    assert_eq!(repo_info(cwd(&dir)).unwrap().branch.as_deref(), Some("feature"));
    write(&dir, "x", "x\n"); stage_all(cwd(&dir)).unwrap(); commit(cwd(&dir), "x", false).unwrap();
    checkout(cwd(&dir), "main", None).unwrap();
    let err = delete_branch(cwd(&dir), "feature", false).unwrap_err();
    assert!(err.contains("not fully merged"), "{err}");
    delete_branch(cwd(&dir), "feature", true).unwrap();
    assert!(!refs(cwd(&dir)).unwrap().branches.iter().any(|b| b.name == "feature"));
}
#[test] fn checkout_of_a_remote_branch_creates_a_tracking_branch() {
    let (_bare, clone) = crate::git::ops::tests::remote_and_clone();
    git(cwd(&clone), &["switch", "-q", "-c", "topic"]); write(&clone, "t", "t\n");
    git(cwd(&clone), &["add", "t"]); git(cwd(&clone), &["commit", "-q", "-m", "t"]); git(cwd(&clone), &["push", "-q", "-u", "origin", "topic"]);
    git(cwd(&clone), &["switch", "-q", "main"]); git(cwd(&clone), &["branch", "-q", "-D", "topic"]);
    checkout(cwd(&clone), "topic", Some("origin")).unwrap();
    let r = refs(cwd(&clone)).unwrap();
    assert_eq!(r.branches.iter().find(|b| b.name == "topic").unwrap().upstream.as_deref(), Some("origin/topic"));
}
#[test] fn merge_conflict_sets_in_progress_and_abort_clears_it() {
    let dir = temp_repo();
    create_branch(cwd(&dir), "b", None, true).unwrap();
    write(&dir, "f.txt", "B\n"); stage_all(cwd(&dir)).unwrap(); commit(cwd(&dir), "b", false).unwrap();
    checkout(cwd(&dir), "main", None).unwrap();
    write(&dir, "f.txt", "A\n"); stage_all(cwd(&dir)).unwrap(); commit(cwd(&dir), "a", false).unwrap();
    assert!(merge(cwd(&dir), "b").is_err());
    assert_eq!(repo_info(cwd(&dir)).unwrap().in_progress.as_deref(), Some("merge"));
    assert_eq!(status(cwd(&dir)).unwrap().unstaged[0].status, "U");
    abort_in_progress(cwd(&dir), "merge").unwrap();
    assert_eq!(repo_info(cwd(&dir)).unwrap().in_progress, None);
    // A clean merge works.
    create_branch(cwd(&dir), "c", None, true).unwrap(); write(&dir, "c", "c\n"); stage_all(cwd(&dir)).unwrap(); commit(cwd(&dir), "c", false).unwrap();
    checkout(cwd(&dir), "main", None).unwrap(); merge(cwd(&dir), "c").unwrap();
    assert!(dir.path().join("c").exists());
}
#[test] fn remotes_add_and_remove() {
    let dir = temp_repo();
    add_remote(cwd(&dir), "upstream", "https://example.invalid/u.git").unwrap();
    assert_eq!(refs(cwd(&dir)).unwrap().remotes[0].url, "https://example.invalid/u.git");
    remove_remote(cwd(&dir), "upstream").unwrap();
    assert!(refs(cwd(&dir)).unwrap().remotes.is_empty());
}
#[test] fn stash_push_files_apply_pop_drop() {
    let dir = temp_repo();
    write(&dir, "f.txt", "changed\n"); write(&dir, "u.txt", "u\n");
    stash_push(cwd(&dir), "wip", true).unwrap();
    assert_eq!(status(cwd(&dir)).unwrap(), StatusResult::default());
    let files = stash_files(cwd(&dir), 0).unwrap();
    let mut names: Vec<_> = files.iter().map(|f| f.path.clone()).collect(); names.sort();
    assert_eq!(names, vec!["f.txt", "u.txt"]);
    stash_apply(cwd(&dir), 0).unwrap();
    assert_eq!(status(cwd(&dir)).unwrap().unstaged.len(), 2);
    assert_eq!(refs(cwd(&dir)).unwrap().stashes.len(), 1);
    discard_files(cwd(&dir), &["f.txt".into()], &["u.txt".into()]).unwrap();
    stash_pop(cwd(&dir), 0).unwrap();
    assert!(refs(cwd(&dir)).unwrap().stashes.is_empty());
    stash_push(cwd(&dir), "", false).unwrap();
    stash_drop(cwd(&dir), 0).unwrap();
    assert!(refs(cwd(&dir)).unwrap().stashes.is_empty());
}
```
- [ ] **Step 2: Run** → compile errors. **Step 3: Implement** (each `ok(run_git(...))` → `map(|_| ())`):
`checkout`: `switch <name>` or `switch -c <name> --track <remote>/<name>` when `track_remote` is Some and no local branch named `name` exists (`show-ref --verify -q refs/heads/<name>` code != 0). `create_branch`: `branch <name> [from]` then optional `switch`. `delete_branch`: `branch -d|-D`. `merge`: `merge --no-edit <branch>`. `abort_in_progress`: `merge --abort` | `rebase --abort` (else `Err("unknown kind")`). `continue_rebase`: `Command` env `GIT_EDITOR=true` — add an `env: &[(&str,&str)]` variant `run_git_env` in `run.rs` (same as `run_git` plus `.envs(env)`); `rebase --continue`. `add_remote`/`remove_remote`: `remote add|remove`. `stash_push`: `stash push [-u] [-m msg]`. `stash_pop|apply|drop`: `stash <verb> stash@{n}`. `stash_files`: `stash show --name-status --include-untracked stash@{n}`; on non-zero retry without `--include-untracked`; parse lines `X\tpath` (`A`/`M`/`D`/`R…\told\tnew`) into `FileEntry { status: first letter (R→"R" with old_path) }`, sorted by path.
Register all `git_*` wrappers in `lib.rs`.
- [ ] **Step 4: Run** `cargo test -p app` → all pass. **Step 5: Commit** `feat(git): branch, remote, stash, abort/continue commands`.

---

### Task 4: Frontend types, wrappers, store

**Files:** `git.ts`, `backend.ts`, `gitState.ts` (+ test), `workspace.ts`, `config.rs` (`nav_collapsed: Option<HashMap<String,bool>>` on `GitViewPrefs`, default) — plus the shape test unaffected (GitViewPrefs serialises only when set).

**Interfaces:**
- `git.ts`: `BranchInfo`, `RemoteInfo`, `StashInfo`, `WorktreeInfo`, `RefsSnapshot`, `NavSelection = "changes" | { stash: number }`, `InProgressKind = "merge" | "rebase"`.
- `backend.ts`: `gitRefs(cwd)`, `gitFetch(cwd, remote, opId)`, `gitPull(cwd, opId)`, `gitPush(cwd, remote, opId)`, `gitCancelOp(opId): Promise<boolean>`, `gitCheckout(cwd, name, trackRemote: string | null)`, `gitCreateBranch(cwd, name, from: string | null, checkout)`, `gitDeleteBranch(cwd, name, force)`, `gitMerge(cwd, branch)`, `gitAbortInProgress(cwd, kind)`, `gitContinueRebase(cwd)`, `gitAddRemote(cwd, name, url)`, `gitRemoveRemote(cwd, name)`, `gitStashPush(cwd, message, includeUntracked)`, `gitStashPop/Apply/Drop(cwd, index)`, `gitStashFiles(cwd, index): Promise<FileEntry[]>`.
- `gitState.ts`: state fields `refs`, `activeRemote`, `navSelection`, `stashFiles`, `op`; pure `effectiveRemote(state)`, `pushLabel(state)`, `currentBranch(state)`, `canSync(state): { fetch: boolean; pull: boolean; push: boolean; reason: string | null }`; actions `setActiveRemote`, `selectStash(workspaceId, index)`, `selectChanges`, `startOp(workspaceId, label, invoke: (cwd, opId) => Promise<void>)`, `cancelOp`, `fetch/pull/push`, `checkout(workspaceId, name, trackRemote)`, `createBranch`, `deleteBranch(… force)`, `mergeBranch`, `abortInProgress`, `continueRebase`, `addRemote`, `removeRemote`, `stashPush`, `stashPop/Apply/Drop`, `setNavCollapsed` (via `setGitViewPrefs`).
- `refresh()` loads `refs` after status; `ensureGitView` initial state includes the new fields.

- [ ] **Step 1: Tests** (append to `gitState.test.ts`; extend the backend mock with the new fns, `gitRefs` resolving a snapshot `{ branches:[{name:"main",current:true,upstream:"origin/main",ahead:2,behind:1,sha:"a",subject:"s"}], remotes:[{name:"origin",url:"u",branches:["main"]},{name:"upstream",url:"v",branches:[]}], stashes:[], worktrees:[], headBranch:"main" }`):
```ts
describe("sync helpers", () => {
  it("effectiveRemote prefers the override, then the upstream's remote, then origin", async () => {
    ensureGitView("ws", "/r"); await refresh("ws");
    const s = get(gitStore)["ws"];
    expect(effectiveRemote(s)).toBe("origin");
    setActiveRemote("ws", "upstream");
    expect(effectiveRemote(get(gitStore)["ws"])).toBe("upstream");
  });
  it("pushLabel is Publish without an upstream and canSync explains why things are disabled", async () => {
    ensureGitView("ws", "/r"); await refresh("ws");
    expect(pushLabel(get(gitStore)["ws"])).toBe("Push");
    vi.mocked(backend.gitRefs).mockResolvedValueOnce({ ...snapshot, branches: [{ ...snapshot.branches[0], upstream: null, ahead: 0, behind: 0 }] });
    await refresh("ws");
    expect(pushLabel(get(gitStore)["ws"])).toBe("Publish");
    vi.mocked(backend.gitRefs).mockResolvedValueOnce({ ...snapshot, remotes: [] });
    await refresh("ws");
    expect(canSync(get(gitStore)["ws"])).toMatchObject({ fetch: false, reason: expect.stringContaining("No remotes") });
  });
});
describe("long ops", () => {
  it("startOp sets op, records progress for its id, refreshes and clears", async () => {
    ensureGitView("ws", "/r");
    let handler!: (e: { payload: { opId: string; line: string } }) => void;
    vi.mocked(listen).mockImplementationOnce(async (_n, h) => { handler = h as never; return () => {}; });
    let finish!: () => void;
    const p = startOp("ws", "Fetch", () => new Promise<void>((res) => (finish = res)));
    await Promise.resolve(); await Promise.resolve();
    const id = get(gitStore)["ws"].op!.id;
    handler({ payload: { opId: "other", line: "nope" } });
    handler({ payload: { opId: id, line: "Receiving objects: 50%" } });
    expect(get(gitStore)["ws"].op).toMatchObject({ label: "Fetch", line: "Receiving objects: 50%" });
    expect(await startOp("ws", "Pull", async () => {})).toBe(false);   // one at a time
    finish(); await p;
    expect(get(gitStore)["ws"].op).toBeNull();
    expect(backend.gitStatus).toHaveBeenCalled();
  });
  it("a cancelled op reports 'cancelled' in the banner", async () => {
    ensureGitView("ws", "/r");
    vi.mocked(backend.gitFetch).mockRejectedValueOnce("cancelled");
    await fetch("ws");
    expect(get(gitStore)["ws"].error).toBe("Fetch cancelled");
  });
  it("run() refuses while an op is in flight", async () => {
    ensureGitView("ws", "/r");
    let finish!: () => void;
    const p = startOp("ws", "Push", () => new Promise<void>((res) => (finish = res)));
    expect(await stageAll("ws")).toBe(false);
    finish(); await p;
  });
});
describe("nav selection", () => {
  it("selectStash loads its files and selectChanges restores", async () => {
    ensureGitView("ws", "/r");
    vi.mocked(backend.gitStashFiles).mockResolvedValueOnce([{ path: "a", status: "M" }]);
    await selectStash("ws", 0);
    expect(get(gitStore)["ws"].navSelection).toEqual({ stash: 0 });
    expect(get(gitStore)["ws"].stashFiles).toEqual([{ path: "a", status: "M" }]);
    selectChanges("ws");
    expect(get(gitStore)["ws"].navSelection).toBe("changes");
    expect(get(gitStore)["ws"].stashFiles).toBeNull();
  });
});
```
- [ ] **Step 2: Run** → fail. **Step 3: Implement** per the Interfaces block. Key code:
```ts
export function effectiveRemote(s: GitViewState): string | null {
  if (s.activeRemote && s.refs?.remotes.some((r) => r.name === s.activeRemote)) return s.activeRemote;
  const cur = s.refs?.branches.find((b) => b.current);
  const fromUpstream = cur?.upstream?.split("/")[0];
  if (fromUpstream && s.refs?.remotes.some((r) => r.name === fromUpstream)) return fromUpstream;
  if (s.refs?.remotes.some((r) => r.name === "origin")) return "origin";
  return s.refs?.remotes[0]?.name ?? null;
}
export function canSync(s: GitViewState) {
  if (!s.refs || s.refs.remotes.length === 0) return { fetch: false, pull: false, push: false, reason: "No remotes — add one in the sidebar" };
  if (s.repo?.detached) return { fetch: true, pull: false, push: false, reason: "detached HEAD" };
  if (s.repo?.unborn) return { fetch: true, pull: false, push: false, reason: "no commits yet" };
  return { fetch: true, pull: true, push: true, reason: null };
}
export async function startOp(workspaceId, label, invoke): Promise<boolean> {
  const s = current(workspaceId);
  if (!s || s.busy || s.op) return false;
  const id = crypto.randomUUID();
  update(workspaceId, (st) => ({ ...st, op: { id, label, line: null }, error: null }));
  const unlisten = await listen<{ opId: string; line: string }>("git-op-progress", (e) => {
    if (e.payload.opId === id) update(workspaceId, (st) => (st.op?.id === id ? { ...st, op: { ...st.op, line: e.payload.line } } : st));
  });
  let okResult = true;
  try { await invoke(s.cwd, id); }
  catch (e) { okResult = false; const t = errorText(e); update(workspaceId, (st) => ({ ...st, error: t === "cancelled" ? `${label} cancelled` : `${label} failed: ${t}` })); }
  unlisten();
  update(workspaceId, (st) => ({ ...st, op: null }));
  await refresh(workspaceId);
  return okResult;
}
```
`run()` gains `|| s.op` in its refusal check. `fetch = (ws) => startOp(ws, "Fetch", (cwd, id) => backend.gitFetch(cwd, effectiveRemote(current(ws)!) ?? "origin", id))`, similar for pull/push. `refresh()`: after status, `const refs = await backend.gitRefs(s.cwd)` inside the same try, merged into the same token-guarded update (a failing `gitRefs` falls into the catch → "Refresh failed: …"). `deleteBranch(ws, name, force)` → `run(ws, "Delete branch", …)`; the UI inspects `error` for "not fully merged". `stashPop` etc. → `run`. `selectStash` sets `navSelection`, loads files with a token guard; `selectChanges` resets.
- [ ] **Step 4: Run** `npm test && npm run check` → green. **Step 5: Commit** `feat(git): refs, long-op lifecycle and nav selection in the store`.

---

### Task 5: Toolbar trio, op bar, stash dialog, banner buttons

**Files:** create `GitToolbar.svelte`, `GitOpBar.svelte`, `GitStashDialog.svelte`, `GitPromptDialog.svelte`; modify `GitHubView.svelte`.

- `GitPromptDialog` props `{ title: string; fields: { key: string; label: string; value: string; placeholder?: string; options?: string[] }[]; checkbox?: { label: string; checked: boolean }; primary: string; onSubmit: (values: Record<string,string>, checked: boolean) => void; onCancel }` — one generic small-form modal (text inputs or `<select>` when `options` given), used by New branch / Add remote / Stash (Stash uses the checkbox for "Include untracked").
- `GitToolbar` props `{ workspaceId }`: reads the store; renders branch pill, Fetch/Pull/Push (lucide `Download`, `ArrowDown`, `ArrowUp`) with badges `↓behind`/`↑ahead` from `currentBranch(state)`, label "Publish" via `pushLabel`, `disabled={busy || op || !canSync.x}` with `use:tooltip={reason ?? label}`; remote `<select>` when ≥2 remotes (`setActiveRemote`); Stash (opens prompt dialog → `stashPush`), Pop (`stashPop(ws, 0)`, disabled when no stashes), Refresh. `GitHubView` replaces its inline toolbar with `<GitToolbar {workspaceId} />` and keeps the splitters/panes; the worktree switcher slot is added in SP3.
- `GitOpBar` renders when `view.op`: `{op.label}… {op.line ?? ""}` + **Cancel** → `cancelOp`.
- Banner: `merge` → **Abort merge** (`abortInProgress(ws, "merge")`); `rebase` → **Abort rebase**, **Continue** (`continueRebase`, disabled while `status.unstaged.some(e => e.status === "U")`).
- [ ] Implement, `npm run check` clean, commit `feat(git): toolbar fetch/pull/push with progress + cancel, stash/pop, abort/continue`.

---

### Task 6: Sidebar sections, dialogs, stash view

**Files:** modify `GitNav.svelte`, `GitChanges.svelte`, `GitDiff.svelte`, `GitDiscardDialog.svelte` (add `confirmLabel?: string` default "Discard" and `danger?: boolean` default true), `GitHubView.svelte`; `workspace.ts`/`config.rs` `navCollapsed`.

- `GitNav` props: `{ workspaceId }` (reads store directly now). Sections with headers (`ChevronDown/Right` toggle persisted via `setGitViewPrefs(ws, { navCollapsed: {...} })`): Local Changes (count, `selectChanges`), Branches (`+` → prompt "New branch" {name, checkbox "Checkout after creating"} → `createBranch(ws, name, null, checked)`; rows with `↑a ↓b`, hover ⤵/⑂/🗑 per spec §2.4; double-click → `checkout`), Remotes (`+` → prompt {name, url} → `addRemote`; remote rows with 🗑 confirm → `removeRemote`; remote branches ⤵ → `checkout(ws, name, remote)`), Stashes (rows → `selectStash`; hover Pop/Apply/🗑 confirm → drop).
- Delete-branch refusal: after `deleteBranch(ws, name, false)` returns false and `error` contains `not fully merged` → clear error, open confirm dialog "Branch `name` isn't fully merged. Force delete?" with `confirmLabel="Force delete"` → `deleteBranch(ws, name, true)`.
- `GitChanges`: when `navSelection` is `{ stash }`, render the read-only stash list (`GitFileRow` without `onDiscard`, `onToggle` no-op, `disabled`) titled `stash@{n} — message`, footer **Pop** / **Apply**, no commit box. `GitDiff`: in stash mode show the message *"Stash contents — pop or apply to edit"*.
- [ ] Implement, `npm run check && npm test` clean, commit `feat(git): sidebar branches/remotes/stashes with actions and stash view`.

---

### Task 7: Smoke entries + card

- Append a **"Sync & branches"** section to `SMOKE_SECTIONS` (fetch via SSH remote, pull conflict → Abort, Publish new branch, stash/pop, add/remove remote, delete unmerged branch → force, cancel a push mid-way). Tick the SP2 card's steps; note deviations in the brainstorm log.
- [ ] `cargo test -p app && npm test && npm run check && npm run build` green; commit `feat(git): SP2 smoke entries`.
