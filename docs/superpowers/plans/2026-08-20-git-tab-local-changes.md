# Git Tab — Local Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Fork-style Git tab in the workspace hub whose Local Changes screen shows unstaged/staged files, a unified or split diff, stages/unstages/discards at file, hunk and line level, and commits or amends — refreshing live from a filesystem watcher.

**Architecture:** A Tauri-side Rust module `app/src-tauri/src/git/` shells out to the system `git` (argv arrays, 10 s timeout, `--no-optional-locks` on reads) and exposes `#[tauri::command]`s plus a debounced `notify` watcher that emits `git-changed`. The frontend keeps one `GitViewState` per workspace in a Svelte store (`gitState.ts`), renders it with a handful of focused Svelte components, and builds partial-staging patches in pure TypeScript (`patch.ts`) that `git apply --cached` consumes. Shared JSON fixtures prove the TS patch builder and real git agree.

**Tech Stack:** Rust (tauri 2, serde, notify 8 + notify-debouncer-mini 0.7, tempfile in tests), Svelte 5 runes + TypeScript, Vitest, `@lucide/svelte` icons, system `git` ≥ 2.25.

**Spec:** `docs/superpowers/specs/2026-08-20-git-tab-local-changes-design.md` (decisions: `docs/superpowers/brainstorms/2026-08-20-git-tab-brainstorm.md`, G1–G9)

## Global Constraints

- Every git invocation: `Command::new("git")` with an **argv array**, `-C <cwd>` is NOT used — `current_dir(cwd)` is (matches `git_status.rs`); **10 s timeout**, child killed on expiry.
- Read-only commands pass the top-level option `--no-optional-locks` **before** the subcommand.
- Environment: the user's, plus `GIT_TERMINAL_PROMPT=0`. Hooks run as-is (G8).
- **No timer polling, ever.** Refresh = watcher event, tab activation, post-mutation, manual button (G9). Watcher debounce **300 ms**; inside `.git/` only `HEAD`, `ORIG_HEAD`, `MERGE_HEAD`, `index`, `packed-refs`, `refs/**`, `rebase-merge/**`, `rebase-apply/**` count.
- Errors: commands return `Result<T, String>`; the `Err` string is git's stderr, trimmed. `git` missing from PATH → the exact string `git was not found on PATH`.
- Display caps: 1 000 rows per file list; hunks > 500 lines render collapsed; files > 2 MB → `tooLarge`.
- Frontend conventions: pure logic in `.ts` modules with Vitest tests; `.svelte` files have **no component tests** (project convention); use `use:tooltip={"…"}` instead of `title=`; monospace dark palette matching `HomeHubView.svelte` (`#1a1a1a` panels, `#2f2f2f` borders, `#ccc` text, `#8bc98b` green).
- Commit after every task with the repo's `Co-Authored-By` trailer convention (see `git log`).
- Run Rust tests with `cargo test -p app` from the repo root; TS tests with `npm test` from `app/`; type-check with `npm run check` from `app/`.

## File structure

**Rust — `app/src-tauri/src/git/`** (new; `mod git;` in `lib.rs`)
- `mod.rs` — re-exports; `pub use commands::*; pub use watch::*;`
- `types.rs` — serde structs crossing to the frontend (`FileEntry`, `StatusResult`, `Line`, `Hunk`, `FileDiff`, `Author`, `RepoInfo`).
- `run.rs` — `run_git()` subprocess runner with timeout + stdin; `GitOutput`; `GIT_NOT_FOUND`.
- `parse.rs` — `parse_status()` (porcelain v2 `-z`) and `parse_diff()` (unified diff) — pure.
- `commands.rs` — every `#[tauri::command]` except the watcher; integration tests on temp repos.
- `watch.rs` — `GitWatchers` state, `is_relevant()`, `git_watch` / `git_unwatch`.

**Rust — modified**
- `app/src-tauri/src/lib.rs` — `mod git;`, `.manage(git::GitWatchers::default())`, command registrations.
- `app/src-tauri/src/config.rs` — `GitViewPrefs`, `Workspace.git_view`.
- `app/src-tauri/src/session.rs` — five `Workspace` literal sites gain `git_view: None`.

**TypeScript — `app/src/lib/`** (new)
- `git.ts` — TS mirrors of the Rust types + `FileStatus`, `lineId()` helper.
- `diffRows.ts` (+ `.test.ts`) — `toUnifiedRows`, `toSplitRows`.
- `patch.ts` (+ `.test.ts`) — `buildPatch`.
- `fixtures/patch-fixtures.json` — shared fixtures (read by `patch.test.ts` and by Rust `commands.rs` tests via `include_str!`).
- `gitState.ts` (+ `.test.ts`) — `GitViewState`, pure reducers, `gitStore`, async actions.
- `GitHubView.svelte` — the hub view: toolbar, empty states, banner, splitters, watcher lifecycle.
- `GitNav.svelte`, `GitChanges.svelte`, `GitFileRow.svelte`, `GitCommitBox.svelte`, `GitDiff.svelte`, `GitDiffUnified.svelte`, `GitDiffSplit.svelte`, `GitDiscardDialog.svelte`.

**TypeScript — modified**
- `backend.ts` — `git*` invoke wrappers.
- `workspace.ts` — `GitViewPrefs`, `Workspace.gitView?`.
- `layoutState.ts` (+ test) — `setGitViewPrefs()`.
- `workspaceViews.ts` — register the `git` view.
- `HomeHubView.svelte` — Git tile.
- `smokeChecklist.ts` (+ test count if asserted) — Git section.

---

### Task 1: Subprocess runner `run.rs` + types `types.rs`

**Files:**
- Create: `app/src-tauri/src/git/mod.rs`
- Create: `app/src-tauri/src/git/types.rs`
- Create: `app/src-tauri/src/git/run.rs`
- Modify: `app/src-tauri/src/lib.rs:1-7` (add `mod git;`)

**Interfaces:**
- Produces: `run::run_git(cwd: &str, args: &[&str], stdin: Option<&[u8]>) -> Result<GitOutput, String>` where `GitOutput { stdout: Vec<u8>, stderr: String, code: i32 }`; `run::ok(out: GitOutput) -> Result<GitOutput, String>` (maps non-zero exit to `Err(stderr.trim())`); `run::GIT_NOT_FOUND: &str = "git was not found on PATH"`; all types in `types.rs` (below).

- [ ] **Step 1: Create the module skeleton and types**

`app/src-tauri/src/git/mod.rs`:
```rust
//! The Git tab's backend: shells out to the system `git` (spec
//! docs/superpowers/specs/2026-08-20-git-tab-local-changes-design.md §2).
pub mod commands;
pub mod parse;
pub mod run;
pub mod types;
pub mod watch;

pub use commands::*;
pub use watch::*;
```

(`commands`, `parse`, `watch` are created in later tasks; to keep the crate compiling after this task, create them as empty files now: `app/src-tauri/src/git/commands.rs`, `parse.rs`, `watch.rs` each containing only `//! filled in by a later task`.)

`app/src-tauri/src/git/types.rs`:
```rust
use serde::{Deserialize, Serialize};

/// One changed path in one list. `status` is a single letter:
/// M A D R C ? U (T — type change — is folded into M).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    pub unstaged: Vec<FileEntry>,
    pub staged: Vec<FileEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    /// "context" | "add" | "del"
    pub kind: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_no: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_no: Option<u32>,
    #[serde(default)]
    pub no_newline: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    /// The raw `@@ … @@` line, verbatim.
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<Line>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    #[serde(default)]
    pub binary: bool,
    #[serde(default)]
    pub too_large: bool,
    #[serde(default)]
    pub hunks: Vec<Hunk>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Author {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub not_a_repo: bool,
    pub root: Option<String>,
    /// Branch name, or the short SHA when `detached`.
    pub branch: Option<String>,
    pub detached: bool,
    pub unborn: bool,
    pub author: Option<Author>,
    pub head_message: Option<String>,
    /// "merge" | "rebase" | null
    pub in_progress: Option<String>,
}
```

Add `mod git;` to `app/src-tauri/src/lib.rs` after `mod fileviewer;`.

- [ ] **Step 2: Write the failing runner tests**

`app/src-tauri/src/git/run.rs`:
```rust
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p app git::run`
Expected: compile error — `run_git` and `ok` not found.

- [ ] **Step 4: Implement the runner**

Append to `run.rs` above the tests module:
```rust
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p app git::run`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/src/git app/src-tauri/src/lib.rs
git commit -m "feat(git): subprocess runner and wire types for the Git tab backend"
```

---

### Task 2: `parse_status` — porcelain v2 `-z` → `StatusResult`

**Files:**
- Modify: `app/src-tauri/src/git/parse.rs`

**Interfaces:**
- Consumes: `types::{FileEntry, StatusResult}`.
- Produces: `parse::parse_status(raw: &[u8]) -> StatusResult`.

Porcelain v2 with `-z`: records are NUL-terminated; record kinds by first char — `1` ordinary (`1 XY sub mH mI mW hH hI path`), `2` rename/copy (`2 XY sub mH mI mW hH hI Xscore path` then the **next NUL token is the original path**), `u` unmerged, `?` untracked, `!` ignored, `#` headers. `X` = index status, `Y` = worktree status, `.` = unchanged.

- [ ] **Step 1: Write the failing tests**

`app/src-tauri/src/git/parse.rs`:
```rust
//! Pure parsers for git's machine-readable output (spec §2). Both are
//! exact by necessity: the frontend patch builder reverses `parse_diff`.

use crate::git::types::{FileDiff, FileEntry, Hunk, Line, StatusResult};

#[cfg(test)]
mod status_tests {
    use super::*;

    fn z(records: &[&str]) -> Vec<u8> {
        let mut v = Vec::new();
        for r in records {
            v.extend_from_slice(r.as_bytes());
            v.push(0);
        }
        v
    }

    #[test]
    fn a_file_modified_in_both_index_and_worktree_appears_in_both_lists() {
        let raw = z(&["1 MM N... 100644 100644 100644 600d48a d2099bb f.txt"]);
        let s = parse_status(&raw);
        assert_eq!(s.staged, vec![FileEntry { path: "f.txt".into(), old_path: None, status: "M".into() }]);
        assert_eq!(s.unstaged, vec![FileEntry { path: "f.txt".into(), old_path: None, status: "M".into() }]);
    }

    #[test]
    fn index_only_and_worktree_only_changes_land_in_one_list_each() {
        let raw = z(&[
            "1 A. N... 000000 100644 100644 0000000 7898192 new.ts",
            "1 .D N... 100644 100644 000000 abc1234 abc1234 gone.md",
            "1 .T N... 100644 100644 120000 abc1234 abc1234 link",
        ]);
        let s = parse_status(&raw);
        assert_eq!(s.staged.iter().map(|e| (e.path.as_str(), e.status.as_str())).collect::<Vec<_>>(), vec![("new.ts", "A")]);
        assert_eq!(
            s.unstaged.iter().map(|e| (e.path.as_str(), e.status.as_str())).collect::<Vec<_>>(),
            vec![("gone.md", "D"), ("link", "M")]
        );
    }

    #[test]
    fn rename_records_take_the_original_path_from_the_next_token() {
        let raw = z(&["2 RM N... 100644 100644 100644 600d48a d2099bb R64 g.txt", "f.txt"]);
        let s = parse_status(&raw);
        assert_eq!(s.staged, vec![FileEntry { path: "g.txt".into(), old_path: Some("f.txt".into()), status: "R".into() }]);
        assert_eq!(s.unstaged, vec![FileEntry { path: "g.txt".into(), old_path: None, status: "M".into() }]);
    }

    #[test]
    fn untracked_and_unmerged_go_to_unstaged_and_sort_conflicts_first() {
        let raw = z(&[
            "? zzz.txt",
            "u UU N... 100644 100644 100644 100644 a b c d conflict.rs",
            "! ignored.log",
        ]);
        let s = parse_status(&raw);
        assert_eq!(
            s.unstaged.iter().map(|e| (e.path.as_str(), e.status.as_str())).collect::<Vec<_>>(),
            vec![("conflict.rs", "U"), ("zzz.txt", "?")]
        );
        assert!(s.staged.is_empty());
    }

    #[test]
    fn lists_are_sorted_by_path_and_paths_with_spaces_survive() {
        let raw = z(&[
            "1 .M N... 100644 100644 100644 a b src/zeta.ts",
            "1 .M N... 100644 100644 100644 a b my file.txt",
        ]);
        let s = parse_status(&raw);
        assert_eq!(s.unstaged.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), vec!["my file.txt", "src/zeta.ts"]);
    }

    #[test]
    fn headers_and_empty_input_yield_empty_lists() {
        assert_eq!(parse_status(&z(&["# branch.oid abc", "# branch.head main"])), StatusResult::default());
        assert_eq!(parse_status(b""), StatusResult::default());
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p app git::parse::status_tests`
Expected: compile error — `parse_status` not found.

- [ ] **Step 3: Implement `parse_status`**

Insert above the tests module in `parse.rs`:
```rust
fn letter(c: char) -> Option<&'static str> {
    match c {
        'M' | 'T' => Some("M"),
        'A' => Some("A"),
        'D' => Some("D"),
        'R' => Some("R"),
        'C' => Some("C"),
        _ => None,
    }
}

fn sort_entries(list: &mut Vec<FileEntry>) {
    // Conflicts first (spec §1), then by path.
    list.sort_by(|a, b| (a.status != "U").cmp(&(b.status != "U")).then_with(|| a.path.cmp(&b.path)));
}

/// Parses `git status --porcelain=v2 -z --untracked-files=all` output.
/// A path changed in both the index and the worktree yields an entry in
/// BOTH lists; unmerged (`u`) and untracked (`?`) records go to `unstaged`.
pub fn parse_status(raw: &[u8]) -> StatusResult {
    let text = String::from_utf8_lossy(raw);
    let mut tokens = text.split('\0').filter(|t| !t.is_empty());
    let mut out = StatusResult::default();

    while let Some(rec) = tokens.next() {
        let mut chars = rec.chars();
        let kind = chars.next().unwrap_or('#');
        match kind {
            '1' | '2' => {
                // "<kind> XY sub mH mI mW hH hI [Xscore] path"
                let fields: Vec<&str> = rec.splitn(if kind == '1' { 9 } else { 10 }, ' ').collect();
                let (xy, path) = match (fields.get(1), fields.last()) {
                    (Some(xy), Some(path)) if fields.len() >= 9 => (*xy, (*path).to_string()),
                    _ => continue,
                };
                let old_path = if kind == '2' { tokens.next().map(|s| s.to_string()) } else { None };
                let mut xy = xy.chars();
                let x = xy.next().unwrap_or('.');
                let y = xy.next().unwrap_or('.');
                if let Some(s) = letter(x) {
                    out.staged.push(FileEntry { path: path.clone(), old_path: old_path.clone(), status: s.to_string() });
                }
                if let Some(s) = letter(y) {
                    out.unstaged.push(FileEntry { path, old_path: None, status: s.to_string() });
                }
            }
            'u' => {
                if let Some(path) = rec.splitn(11, ' ').last() {
                    out.unstaged.push(FileEntry { path: path.to_string(), old_path: None, status: "U".into() });
                }
            }
            '?' => {
                if let Some(path) = rec.strip_prefix("? ") {
                    out.unstaged.push(FileEntry { path: path.to_string(), old_path: None, status: "?".into() });
                }
            }
            _ => {} // '!' ignored entries and '#' headers
        }
    }
    sort_entries(&mut out.staged);
    sort_entries(&mut out.unstaged);
    out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p app git::parse::status_tests`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/git/parse.rs
git commit -m "feat(git): porcelain-v2 status parser"
```

---

### Task 3: `parse_diff` — unified diff → `FileDiff`

**Files:**
- Modify: `app/src-tauri/src/git/parse.rs`

**Interfaces:**
- Produces: `parse::parse_diff(path: &str, old_path: Option<&str>, raw: &str) -> FileDiff` — `path`/`old_path` are passed in by the caller (the status entry already knows them; diff headers are not re-derived).

- [ ] **Step 1: Write the failing tests**

Append to `parse.rs`:
```rust
#[cfg(test)]
mod diff_tests {
    use super::*;

    const SAMPLE: &str = "diff --git a/f.txt b/f.txt\nindex 600d48a..e12a1b5 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,5 +1,6 @@\n alpha\n-beta\n+BETA\n gamma\n-delta\n+new1\n+new2\n epsilon\n";

    fn l(kind: &str, text: &str, old_no: Option<u32>, new_no: Option<u32>) -> Line {
        Line { kind: kind.into(), text: text.into(), old_no, new_no, no_newline: false }
    }

    #[test]
    fn parses_one_hunk_with_running_line_numbers() {
        let d = parse_diff("f.txt", None, SAMPLE);
        assert_eq!(d.path, "f.txt");
        assert_eq!(d.old_path, None);
        assert!(!d.binary && !d.too_large);
        assert_eq!(d.hunks.len(), 1);
        let h = &d.hunks[0];
        assert_eq!((h.header.as_str(), h.old_start, h.old_lines, h.new_start, h.new_lines), ("@@ -1,5 +1,6 @@", 1, 5, 1, 6));
        assert_eq!(
            h.lines,
            vec![
                l("context", "alpha", Some(1), Some(1)),
                l("del", "beta", Some(2), None),
                l("add", "BETA", None, Some(2)),
                l("context", "gamma", Some(3), Some(3)),
                l("del", "delta", Some(4), None),
                l("add", "new1", None, Some(4)),
                l("add", "new2", None, Some(5)),
                l("context", "epsilon", Some(5), Some(6)),
            ]
        );
    }

    #[test]
    fn header_without_counts_means_one_line_and_no_newline_marker_attaches_to_previous_line() {
        let raw = "diff --git a/n.txt b/n.txt\nindex c1b0730..e25f181 100644\n--- a/n.txt\n+++ b/n.txt\n@@ -1 +1 @@\n-x\n\\ No newline at end of file\n+y\n\\ No newline at end of file\n";
        let d = parse_diff("n.txt", None, raw);
        let h = &d.hunks[0];
        assert_eq!((h.header.as_str(), h.old_start, h.old_lines, h.new_start, h.new_lines), ("@@ -1 +1 @@", 1, 1, 1, 1));
        assert_eq!(h.lines.len(), 2);
        assert!(h.lines[0].no_newline && h.lines[1].no_newline);
        assert_eq!(h.lines[0].text, "x");
        assert_eq!(h.lines[1].text, "y");
    }

    #[test]
    fn multiple_hunks_and_function_context_in_header_are_kept() {
        let raw = "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@ fn main() {\n a\n-b\n+B\n@@ -10,2 +10,3 @@\n j\n+K\n k\n";
        let d = parse_diff("x", None, raw);
        assert_eq!(d.hunks.len(), 2);
        assert_eq!(d.hunks[0].header, "@@ -1,2 +1,2 @@ fn main() {");
        assert_eq!(d.hunks[1].old_start, 10);
        assert_eq!(d.hunks[1].lines[1], l("add", "K", None, Some(11)));
    }

    #[test]
    fn new_file_and_rename_preambles_are_skipped_and_old_path_is_passed_through() {
        let raw = "diff --git a/u.txt b/u.txt\nnew file mode 100644\nindex 0000000..ce01362\n--- /dev/null\n+++ b/u.txt\n@@ -0,0 +1 @@\n+hello\n";
        let d = parse_diff("u.txt", None, raw);
        assert_eq!(d.hunks[0].lines, vec![l("add", "hello", None, Some(1))]);
        let renamed = parse_diff("g.txt", Some("f.txt"), "diff --git a/f.txt b/g.txt\nsimilarity index 64%\nrename from f.txt\nrename to g.txt\n");
        assert_eq!(renamed.old_path.as_deref(), Some("f.txt"));
        assert!(renamed.hunks.is_empty());
    }

    #[test]
    fn empty_output_is_an_empty_diff() {
        assert!(parse_diff("x", None, "").hunks.is_empty());
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p app git::parse::diff_tests`
Expected: compile error — `parse_diff` not found.

- [ ] **Step 3: Implement `parse_diff`**

Insert above `mod status_tests`:
```rust
/// Parses a `@@ -a[,b] +c[,d] @@…` header into (a, b, c, d); a missing
/// count means 1 (unified-diff convention).
fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32)> {
    let rest = line.strip_prefix("@@ -")?;
    let end = rest.find(" @@")?;
    let ranges = &rest[..end];
    let (old, new) = ranges.split_once(" +")?;
    fn range(s: &str) -> Option<(u32, u32)> {
        match s.split_once(',') {
            Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
            None => Some((s.parse().ok()?, 1)),
        }
    }
    let (os, ol) = range(old)?;
    let (ns, nl) = range(new)?;
    Some((os, ol, ns, nl))
}

/// Parses `git diff` unified output for ONE file. Preamble lines
/// (`diff --git`, `index`, `new file mode`, `rename from/to`, `---`,
/// `+++`) are skipped; only hunk headers and `+`/`-`/` `/`\` lines matter.
pub fn parse_diff(path: &str, old_path: Option<&str>, raw: &str) -> FileDiff {
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut old_no = 0u32;
    let mut new_no = 0u32;

    for line in raw.split_inclusive('\n') {
        let line = line.strip_suffix('\n').unwrap_or(line);
        if let Some((os, ol, ns, nl)) = line.starts_with("@@").then(|| parse_hunk_header(line)).flatten() {
            hunks.push(Hunk { header: line.to_string(), old_start: os, old_lines: ol, new_start: ns, new_lines: nl, lines: Vec::new() });
            old_no = os;
            new_no = ns;
            continue;
        }
        let Some(hunk) = hunks.last_mut() else { continue };
        if let Some(text) = line.strip_prefix('+') {
            hunk.lines.push(Line { kind: "add".into(), text: text.into(), old_no: None, new_no: Some(new_no), no_newline: false });
            new_no += 1;
        } else if let Some(text) = line.strip_prefix('-') {
            hunk.lines.push(Line { kind: "del".into(), text: text.into(), old_no: Some(old_no), new_no: None, no_newline: false });
            old_no += 1;
        } else if let Some(text) = line.strip_prefix(' ') {
            hunk.lines.push(Line { kind: "context".into(), text: text.into(), old_no: Some(old_no), new_no: Some(new_no), no_newline: false });
            old_no += 1;
            new_no += 1;
        } else if line.starts_with('\\') {
            if let Some(prev) = hunk.lines.last_mut() {
                prev.no_newline = true;
            }
        } else if line.is_empty() {
            // A blank context line whose leading space was trimmed by a
            // pager/editor; treat as context to stay robust.
            hunk.lines.push(Line { kind: "context".into(), text: String::new(), old_no: Some(old_no), new_no: Some(new_no), no_newline: false });
            old_no += 1;
            new_no += 1;
        }
    }

    FileDiff { path: path.to_string(), old_path: old_path.map(str::to_string), binary: false, too_large: false, hunks }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p app git::parse`
Expected: 11 passed (6 status + 5 diff).

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/git/parse.rs
git commit -m "feat(git): unified diff parser"
```

---

### Task 4: Read commands — `git_repo_info`, `git_status`, `git_diff`

**Files:**
- Modify: `app/src-tauri/src/git/commands.rs`

**Interfaces:**
- Consumes: `run::{run_git, run_git_ro, ok, GitOutput}`, `parse::{parse_status, parse_diff}`, `types::*`.
- Produces (plain fns, each wrapped by a same-named `#[tauri::command]` taking `String`s):
  - `repo_info(cwd: &str) -> Result<RepoInfo, String>`
  - `status(cwd: &str) -> Result<StatusResult, String>`
  - `diff(cwd: &str, path: &str, old_path: Option<&str>, staged: bool, untracked: bool) -> Result<FileDiff, String>`
  - test helper module `testutil` (`temp_repo()`, `git()`, `write()`, `cwd()`) under `#[cfg(test)]`, used by Tasks 5–6.

- [ ] **Step 1: Write the failing integration tests**

Replace the placeholder in `app/src-tauri/src/git/commands.rs` with:
```rust
//! Tauri commands for the Git tab (spec §2). Each `#[tauri::command]` is a
//! thin wrapper over a plain function so the temp-repo tests below call the
//! real code path without a Tauri runtime.

use crate::git::parse::{parse_diff, parse_status};
use crate::git::run::{ok, run_git, run_git_ro};
use crate::git::types::{Author, FileDiff, RepoInfo, StatusResult};
use std::path::Path;

/// Diffs larger than this are not rendered (spec §1: "Diff too large").
pub const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;

#[cfg(test)]
pub(crate) mod testutil {
    use super::*;
    use std::fs;

    /// A fresh repo with identity + signing configured so commits work on
    /// any machine, and ONE commit of `f.txt` = "alpha..epsilon".
    pub fn temp_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        git(cwd, &["init", "-q", "-b", "main"]);
        git(cwd, &["config", "user.email", "t@example.com"]);
        git(cwd, &["config", "user.name", "Test User"]);
        git(cwd, &["config", "commit.gpgsign", "false"]);
        fs::write(dir.path().join("f.txt"), "alpha\nbeta\ngamma\ndelta\nepsilon\n").unwrap();
        git(cwd, &["add", "f.txt"]);
        git(cwd, &["commit", "-q", "-m", "base"]);
        dir
    }

    pub fn git(cwd: &str, args: &[&str]) -> String {
        let out = ok(run_git(cwd, args, None).unwrap()).unwrap_or_else(|e| panic!("git {args:?}: {e}"));
        out.stdout_str()
    }

    pub fn write(dir: &tempfile::TempDir, name: &str, content: &str) {
        fs::write(dir.path().join(name), content).unwrap();
    }

    pub fn cwd(dir: &tempfile::TempDir) -> &str {
        dir.path().to_str().unwrap()
    }
}

#[cfg(test)]
mod read_tests {
    use super::testutil::*;
    use super::*;

    #[test]
    fn repo_info_on_a_normal_repo() {
        let dir = temp_repo();
        let info = repo_info(cwd(&dir)).unwrap();
        assert!(!info.not_a_repo);
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert!(!info.detached && !info.unborn);
        assert_eq!(info.author, Some(Author { name: "Test User".into(), email: "t@example.com".into() }));
        assert_eq!(info.head_message.as_deref(), Some("base"));
        assert_eq!(info.in_progress, None);
        assert_eq!(info.root.as_deref().map(Path::new).and_then(Path::file_name), dir.path().file_name());
    }

    #[test]
    fn repo_info_reports_not_a_repo_for_a_plain_directory() {
        let dir = tempfile::tempdir().unwrap();
        // Guard against an enclosing repo (e.g. a tmpdir inside a checkout):
        // only assert when git agrees the dir is outside one.
        if run_git(cwd(&dir), &["rev-parse", "--show-toplevel"], None).unwrap().code != 0 {
            let info = repo_info(cwd(&dir)).unwrap();
            assert!(info.not_a_repo);
        }
    }

    #[test]
    fn repo_info_detects_unborn_and_detached_heads() {
        let dir = tempfile::tempdir().unwrap();
        git(cwd(&dir), &["init", "-q", "-b", "main"]);
        let info = repo_info(cwd(&dir)).unwrap();
        assert!(info.unborn, "fresh init must be unborn");
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert_eq!(info.head_message, None);

        let dir = temp_repo();
        git(cwd(&dir), &["checkout", "-q", "--detach"]);
        let info = repo_info(cwd(&dir)).unwrap();
        assert!(info.detached);
        assert_eq!(info.branch.as_deref().map(str::len), Some(7));
    }

    #[test]
    fn status_lists_staged_unstaged_and_untracked() {
        let dir = temp_repo();
        write(&dir, "f.txt", "alpha\nBETA\ngamma\ndelta\nepsilon\n");
        write(&dir, "new.ts", "x\n");
        write(&dir, "u.txt", "hello\n");
        git(cwd(&dir), &["add", "new.ts"]);
        let s = status(cwd(&dir)).unwrap();
        assert_eq!(s.staged.iter().map(|e| (e.path.as_str(), e.status.as_str())).collect::<Vec<_>>(), vec![("new.ts", "A")]);
        assert_eq!(
            s.unstaged.iter().map(|e| (e.path.as_str(), e.status.as_str())).collect::<Vec<_>>(),
            vec![("f.txt", "M"), ("u.txt", "?")]
        );
    }

    #[test]
    fn diff_unstaged_staged_and_untracked() {
        let dir = temp_repo();
        write(&dir, "f.txt", "alpha\nBETA\ngamma\nnew1\nnew2\nepsilon\n");
        let d = diff(cwd(&dir), "f.txt", None, false, false).unwrap();
        assert_eq!(d.hunks.len(), 1);
        assert_eq!(d.hunks[0].header, "@@ -1,5 +1,6 @@");
        assert_eq!(d.hunks[0].lines.iter().filter(|l| l.kind == "add").count(), 3);

        git(cwd(&dir), &["add", "f.txt"]);
        let staged = diff(cwd(&dir), "f.txt", None, true, false).unwrap();
        assert_eq!(staged.hunks[0].header, "@@ -1,5 +1,6 @@");
        let unstaged_now = diff(cwd(&dir), "f.txt", None, false, false).unwrap();
        assert!(unstaged_now.hunks.is_empty());

        write(&dir, "u.txt", "hello\n");
        let u = diff(cwd(&dir), "u.txt", None, false, true).unwrap();
        assert_eq!(u.hunks[0].lines.len(), 1);
        assert_eq!(u.hunks[0].lines[0].kind, "add");
        assert_eq!(u.hunks[0].lines[0].text, "hello");
    }

    #[test]
    fn diff_flags_binary_and_too_large() {
        let dir = temp_repo();
        write(&dir, "blob.bin", "\u{0}\u{1}\u{2}binary\u{0}\n");
        let b = diff(cwd(&dir), "blob.bin", None, false, true).unwrap();
        assert!(b.binary);
        assert!(b.hunks.is_empty());

        let big = "line\n".repeat(MAX_DIFF_BYTES / 5 + 10);
        write(&dir, "big.txt", &big);
        let t = diff(cwd(&dir), "big.txt", None, false, true).unwrap();
        assert!(t.too_large);
        assert!(t.hunks.is_empty());
    }

    #[test]
    fn diff_of_a_staged_rename_uses_both_paths() {
        let dir = temp_repo();
        git(cwd(&dir), &["mv", "f.txt", "g.txt"]);
        let d = diff(cwd(&dir), "g.txt", Some("f.txt"), true, false).unwrap();
        assert_eq!(d.old_path.as_deref(), Some("f.txt"));
        assert!(d.hunks.is_empty(), "a pure rename has no hunks");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p app git::commands::read_tests`
Expected: compile errors — `repo_info`, `status`, `diff` not found.

- [ ] **Step 3: Implement the read commands**

Insert between `MAX_DIFF_BYTES` and `mod testutil`:
```rust
fn config_value(cwd: &str, key: &str) -> Result<Option<String>, String> {
    let out = run_git_ro(cwd, &["config", "--get", key])?;
    // Exit 1 = unset; anything else non-zero is a real error.
    match out.code {
        0 => Ok(Some(out.stdout_str().trim().to_string()).filter(|s| !s.is_empty())),
        1 => Ok(None),
        _ => Err(out.stderr.trim().to_string()),
    }
}

pub fn repo_info(cwd: &str) -> Result<RepoInfo, String> {
    let top = run_git_ro(cwd, &["rev-parse", "--show-toplevel"])?;
    if top.code != 0 {
        return Ok(RepoInfo { not_a_repo: true, ..Default::default() });
    }
    let root = top.stdout_str().trim().to_string();
    let unborn = run_git_ro(cwd, &["rev-parse", "--verify", "-q", "HEAD"])?.code != 0;
    let sym = run_git_ro(cwd, &["symbolic-ref", "--short", "-q", "HEAD"])?;
    let (branch, detached) = if sym.code == 0 {
        (Some(sym.stdout_str().trim().to_string()), false)
    } else {
        let sha = ok(run_git_ro(cwd, &["rev-parse", "--short", "HEAD"])?)?;
        (Some(sha.stdout_str().trim().to_string()), true)
    };
    let author = match (config_value(cwd, "user.name")?, config_value(cwd, "user.email")?) {
        (Some(name), Some(email)) => Some(Author { name, email }),
        _ => None,
    };
    let head_message = if unborn {
        None
    } else {
        Some(ok(run_git_ro(cwd, &["log", "-1", "--format=%B"])?)?.stdout_str().trim_end().to_string())
    };
    let git_dir = ok(run_git_ro(cwd, &["rev-parse", "--absolute-git-dir"])?)?.stdout_str().trim().to_string();
    let git_dir = Path::new(&git_dir);
    let in_progress = if git_dir.join("MERGE_HEAD").exists() {
        Some("merge".to_string())
    } else if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        Some("rebase".to_string())
    } else {
        None
    };
    Ok(RepoInfo { not_a_repo: false, root: Some(root), branch, detached, unborn, author, head_message, in_progress })
}

pub fn status(cwd: &str) -> Result<StatusResult, String> {
    let out = ok(run_git_ro(cwd, &["status", "--porcelain=v2", "-z", "--untracked-files=all"])?)?;
    Ok(parse_status(&out.stdout))
}

pub fn diff(cwd: &str, path: &str, old_path: Option<&str>, staged: bool, untracked: bool) -> Result<FileDiff, String> {
    let mut args: Vec<&str> = vec!["diff", "--no-color", "--no-ext-diff", "-U3"];
    if untracked {
        args.extend(["--no-index", "--", "/dev/null", path]);
    } else {
        if staged {
            args.extend(["--cached", "-M"]);
        }
        args.push("--");
        if let Some(old) = old_path {
            args.push(old);
        }
        args.push(path);
    }
    let out = run_git_ro(cwd, &args)?;
    // `diff` exits 1 for "differences found" under --no-index; both 0 and 1
    // are success here.
    if out.code != 0 && out.code != 1 {
        return Err(out.stderr.trim().to_string());
    }
    let mut result = FileDiff { path: path.to_string(), old_path: old_path.map(str::to_string), binary: false, too_large: false, hunks: vec![] };
    if out.stdout.len() > MAX_DIFF_BYTES {
        result.too_large = true;
        return Ok(result);
    }
    let text = out.stdout_str();
    if text.lines().any(|l| l.starts_with("Binary files ")) {
        result.binary = true;
        return Ok(result);
    }
    result.hunks = parse_diff(path, old_path, &text).hunks;
    Ok(result)
}

#[tauri::command]
pub fn git_repo_info(cwd: String) -> Result<RepoInfo, String> {
    repo_info(&cwd)
}

#[tauri::command]
pub fn git_status(cwd: String) -> Result<StatusResult, String> {
    status(&cwd)
}

#[tauri::command]
pub fn git_diff(cwd: String, path: String, old_path: Option<String>, staged: bool, untracked: bool) -> Result<FileDiff, String> {
    diff(&cwd, &path, old_path.as_deref(), staged, untracked)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p app git::commands::read_tests`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/git/commands.rs
git commit -m "feat(git): repo info, status and diff commands with temp-repo tests"
```

---

### Task 5: Write commands + shared patch fixtures

**Files:**
- Modify: `app/src-tauri/src/git/commands.rs`
- Create: `app/src/lib/fixtures/patch-fixtures.json`

**Interfaces:**
- Produces plain fns + commands: `stage_files(cwd, paths: &[String])`, `unstage_files(cwd, paths)`, `stage_all(cwd)`, `unstage_all(cwd)`, `apply_patch(cwd, patch: &str, mode: &str)` with `mode ∈ {"stage","unstage","discard"}`, `discard_files(cwd, tracked: &[String], untracked: &[String])`, `commit(cwd, message: &str, amend: bool)`, `init(cwd)` — all `Result<(), String>`. Tauri names: `git_stage_files`, `git_unstage_files`, `git_stage_all`, `git_unstage_all`, `git_apply_patch`, `git_discard_files`, `git_commit`, `git_init`.
- Produces the fixture file consumed by Task 10's `patch.test.ts`:
  `{ "fixtures": [{ name, file, base, modified, diff: FileDiff, hunkIndex, selected: string[] | null, expectedPatch }] }` where `selected` holds `lineId`s `"<hunkIndex>:<lineIndex>"`.

- [ ] **Step 1: Create the shared fixtures**

`app/src/lib/fixtures/patch-fixtures.json` (every `expectedPatch` below was verified against `git apply --cached --unidiff-zero --whitespace=nowarn --check`; keep the bytes exact):
```json
{
  "fixtures": [
    {
      "name": "whole-hunk",
      "file": "f.txt",
      "base": "alpha\nbeta\ngamma\ndelta\nepsilon\n",
      "modified": "alpha\nBETA\ngamma\nnew1\nnew2\nepsilon\n",
      "diff": {
        "path": "f.txt",
        "binary": false,
        "tooLarge": false,
        "hunks": [
          {
            "header": "@@ -1,5 +1,6 @@",
            "oldStart": 1, "oldLines": 5, "newStart": 1, "newLines": 6,
            "lines": [
              { "kind": "context", "text": "alpha", "oldNo": 1, "newNo": 1, "noNewline": false },
              { "kind": "del", "text": "beta", "oldNo": 2, "noNewline": false },
              { "kind": "add", "text": "BETA", "newNo": 2, "noNewline": false },
              { "kind": "context", "text": "gamma", "oldNo": 3, "newNo": 3, "noNewline": false },
              { "kind": "del", "text": "delta", "oldNo": 4, "noNewline": false },
              { "kind": "add", "text": "new1", "newNo": 4, "noNewline": false },
              { "kind": "add", "text": "new2", "newNo": 5, "noNewline": false },
              { "kind": "context", "text": "epsilon", "oldNo": 5, "newNo": 6, "noNewline": false }
            ]
          }
        ]
      },
      "hunkIndex": 0,
      "selected": null,
      "expectedPatch": "--- a/f.txt\n+++ b/f.txt\n@@ -1,5 +1,6 @@\n alpha\n-beta\n+BETA\n gamma\n-delta\n+new1\n+new2\n epsilon\n"
    },
    {
      "name": "subset-of-adds",
      "file": "f.txt",
      "base": "alpha\nbeta\ngamma\ndelta\nepsilon\n",
      "modified": "alpha\nBETA\ngamma\nnew1\nnew2\nepsilon\n",
      "diff": {
        "path": "f.txt",
        "binary": false,
        "tooLarge": false,
        "hunks": [
          {
            "header": "@@ -1,5 +1,6 @@",
            "oldStart": 1, "oldLines": 5, "newStart": 1, "newLines": 6,
            "lines": [
              { "kind": "context", "text": "alpha", "oldNo": 1, "newNo": 1, "noNewline": false },
              { "kind": "del", "text": "beta", "oldNo": 2, "noNewline": false },
              { "kind": "add", "text": "BETA", "newNo": 2, "noNewline": false },
              { "kind": "context", "text": "gamma", "oldNo": 3, "newNo": 3, "noNewline": false },
              { "kind": "del", "text": "delta", "oldNo": 4, "noNewline": false },
              { "kind": "add", "text": "new1", "newNo": 4, "noNewline": false },
              { "kind": "add", "text": "new2", "newNo": 5, "noNewline": false },
              { "kind": "context", "text": "epsilon", "oldNo": 5, "newNo": 6, "noNewline": false }
            ]
          }
        ]
      },
      "hunkIndex": 0,
      "selected": ["0:5"],
      "expectedPatch": "--- a/f.txt\n+++ b/f.txt\n@@ -1,5 +1,6 @@\n alpha\n beta\n gamma\n delta\n+new1\n epsilon\n"
    },
    {
      "name": "mixed-dels-and-adds",
      "file": "f.txt",
      "base": "alpha\nbeta\ngamma\ndelta\nepsilon\n",
      "modified": "alpha\nBETA\ngamma\nnew1\nnew2\nepsilon\n",
      "diff": {
        "path": "f.txt",
        "binary": false,
        "tooLarge": false,
        "hunks": [
          {
            "header": "@@ -1,5 +1,6 @@",
            "oldStart": 1, "oldLines": 5, "newStart": 1, "newLines": 6,
            "lines": [
              { "kind": "context", "text": "alpha", "oldNo": 1, "newNo": 1, "noNewline": false },
              { "kind": "del", "text": "beta", "oldNo": 2, "noNewline": false },
              { "kind": "add", "text": "BETA", "newNo": 2, "noNewline": false },
              { "kind": "context", "text": "gamma", "oldNo": 3, "newNo": 3, "noNewline": false },
              { "kind": "del", "text": "delta", "oldNo": 4, "noNewline": false },
              { "kind": "add", "text": "new1", "newNo": 4, "noNewline": false },
              { "kind": "add", "text": "new2", "newNo": 5, "noNewline": false },
              { "kind": "context", "text": "epsilon", "oldNo": 5, "newNo": 6, "noNewline": false }
            ]
          }
        ]
      },
      "hunkIndex": 0,
      "selected": ["0:1", "0:2", "0:4"],
      "expectedPatch": "--- a/f.txt\n+++ b/f.txt\n@@ -1,5 +1,4 @@\n alpha\n-beta\n+BETA\n gamma\n-delta\n epsilon\n"
    },
    {
      "name": "no-newline-at-eof",
      "file": "n.txt",
      "base": "x",
      "modified": "y",
      "diff": {
        "path": "n.txt",
        "binary": false,
        "tooLarge": false,
        "hunks": [
          {
            "header": "@@ -1 +1 @@",
            "oldStart": 1, "oldLines": 1, "newStart": 1, "newLines": 1,
            "lines": [
              { "kind": "del", "text": "x", "oldNo": 1, "noNewline": true },
              { "kind": "add", "text": "y", "newNo": 1, "noNewline": true }
            ]
          }
        ]
      },
      "hunkIndex": 0,
      "selected": null,
      "expectedPatch": "--- a/n.txt\n+++ b/n.txt\n@@ -1,1 +1,1 @@\n-x\n\\ No newline at end of file\n+y\n\\ No newline at end of file\n"
    }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

Append to `commands.rs`:
```rust
#[cfg(test)]
mod write_tests {
    use super::testutil::*;
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        name: String,
        file: String,
        base: String,
        modified: String,
        diff: FileDiff,
        #[allow(dead_code)]
        hunk_index: usize,
        #[allow(dead_code)]
        selected: Option<Vec<String>>,
        expected_patch: String,
    }

    #[derive(Deserialize)]
    struct Fixtures {
        fixtures: Vec<Fixture>,
    }

    const FIXTURES: &str = include_str!("../../../src/lib/fixtures/patch-fixtures.json");

    fn paths(entries: &[crate::git::types::FileEntry]) -> Vec<String> {
        entries.iter().map(|e| format!("{}{}", e.status, e.path)).collect()
    }

    #[test]
    fn stage_and_unstage_files_move_entries_between_lists() {
        let dir = temp_repo();
        write(&dir, "f.txt", "changed\n");
        write(&dir, "u.txt", "new\n");
        stage_files(cwd(&dir), &["f.txt".into(), "u.txt".into()]).unwrap();
        let s = status(cwd(&dir)).unwrap();
        assert_eq!(paths(&s.staged), vec!["Mf.txt", "Au.txt"]);
        assert!(s.unstaged.is_empty());

        unstage_files(cwd(&dir), &["u.txt".into()]).unwrap();
        let s = status(cwd(&dir)).unwrap();
        assert_eq!(paths(&s.staged), vec!["Mf.txt"]);
        assert_eq!(paths(&s.unstaged), vec!["?u.txt"]);
    }

    #[test]
    fn stage_all_and_unstage_all_including_on_an_unborn_head() {
        let dir = temp_repo();
        write(&dir, "f.txt", "changed\n");
        write(&dir, "u.txt", "new\n");
        stage_all(cwd(&dir)).unwrap();
        assert_eq!(status(cwd(&dir)).unwrap().staged.len(), 2);
        unstage_all(cwd(&dir)).unwrap();
        assert!(status(cwd(&dir)).unwrap().staged.is_empty());

        let fresh = tempfile::tempdir().unwrap();
        git(cwd(&fresh), &["init", "-q", "-b", "main"]);
        write(&fresh, "a", "a\n");
        stage_all(cwd(&fresh)).unwrap();
        assert_eq!(paths(&status(cwd(&fresh)).unwrap().staged), vec!["Aa"]);
        unstage_all(cwd(&fresh)).unwrap();
        assert_eq!(paths(&status(cwd(&fresh)).unwrap().unstaged), vec!["?a"]);
    }

    #[test]
    fn fixtures_parse_identically_and_their_patches_apply() {
        let fx: Fixtures = serde_json::from_str(FIXTURES).unwrap();
        assert!(fx.fixtures.len() >= 4);
        for f in &fx.fixtures {
            let dir = tempfile::tempdir().unwrap();
            let c = cwd(&dir);
            git(c, &["init", "-q", "-b", "main"]);
            git(c, &["config", "user.email", "t@example.com"]);
            git(c, &["config", "user.name", "T"]);
            git(c, &["config", "commit.gpgsign", "false"]);
            write(&dir, &f.file, &f.base);
            git(c, &["add", &f.file]);
            git(c, &["commit", "-q", "-m", "base"]);
            write(&dir, &f.file, &f.modified);

            let parsed = diff(c, &f.file, None, false, false).unwrap();
            assert_eq!(parsed, f.diff, "fixture {} diff JSON drifted from the parser", f.name);

            // The builder's expected output must be accepted by git…
            let check = run_git(c, &["apply", "--cached", "--unidiff-zero", "--whitespace=nowarn", "--check"], Some(f.expected_patch.as_bytes())).unwrap();
            assert_eq!(check.code, 0, "fixture {}: {}", f.name, check.stderr);
            // …and actually stage something.
            apply_patch(c, &f.expected_patch, "stage").unwrap();
            assert_eq!(paths(&status(c).unwrap().staged), vec![format!("M{}", f.file)], "fixture {}", f.name);
            // Unstage reverses it exactly.
            apply_patch(c, &f.expected_patch, "unstage").unwrap();
            assert!(status(c).unwrap().staged.is_empty(), "fixture {}", f.name);
        }
    }

    #[test]
    fn discard_mode_reverts_the_worktree_and_discard_files_handles_both_kinds() {
        let dir = temp_repo();
        write(&dir, "f.txt", "alpha\nBETA\ngamma\nnew1\nnew2\nepsilon\n");
        let fx: Fixtures = serde_json::from_str(FIXTURES).unwrap();
        let whole = &fx.fixtures[0];
        apply_patch(cwd(&dir), &whole.expected_patch, "discard").unwrap();
        assert!(status(cwd(&dir)).unwrap().unstaged.is_empty());

        write(&dir, "f.txt", "changed\n");
        write(&dir, "u.txt", "new\n");
        discard_files(cwd(&dir), &["f.txt".into()], &["u.txt".into()]).unwrap();
        assert_eq!(status(cwd(&dir)).unwrap(), StatusResult::default());
        assert!(!dir.path().join("u.txt").exists());
    }

    #[test]
    fn commit_then_amend_rewrites_head_message() {
        let dir = temp_repo();
        write(&dir, "f.txt", "changed\n");
        stage_all(cwd(&dir)).unwrap();
        commit(cwd(&dir), "feat: change\n\nbody line", false).unwrap();
        assert_eq!(repo_info(cwd(&dir)).unwrap().head_message.as_deref(), Some("feat: change\n\nbody line"));
        assert_eq!(git(cwd(&dir), &["rev-list", "--count", "HEAD"]).trim(), "2");

        commit(cwd(&dir), "feat: amended", true).unwrap();
        assert_eq!(repo_info(cwd(&dir)).unwrap().head_message.as_deref(), Some("feat: amended"));
        assert_eq!(git(cwd(&dir), &["rev-list", "--count", "HEAD"]).trim(), "2");
    }

    #[test]
    fn commit_with_nothing_staged_surfaces_gits_message() {
        let dir = temp_repo();
        let err = commit(cwd(&dir), "empty", false).unwrap_err();
        assert!(!err.is_empty());
    }

    #[test]
    fn init_turns_a_plain_directory_into_a_repo() {
        let dir = tempfile::tempdir().unwrap();
        init(cwd(&dir)).unwrap();
        assert!(dir.path().join(".git").is_dir());
        assert!(repo_info(cwd(&dir)).unwrap().unborn);
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p app git::commands::write_tests`
Expected: compile errors — `stage_files` etc. not found.

- [ ] **Step 4: Implement the write commands**

Insert after `diff()` and before the `#[tauri::command]` block:
```rust
fn with_paths<'a>(head: &[&'a str], paths: &'a [String]) -> Vec<&'a str> {
    let mut args: Vec<&str> = head.to_vec();
    args.push("--");
    args.extend(paths.iter().map(String::as_str));
    args
}

fn head_is_unborn(cwd: &str) -> Result<bool, String> {
    Ok(run_git_ro(cwd, &["rev-parse", "--verify", "-q", "HEAD"])?.code != 0)
}

pub fn stage_files(cwd: &str, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    ok(run_git(cwd, &with_paths(&["add", "-A"], paths), None)?).map(|_| ())
}

pub fn unstage_files(cwd: &str, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let head: &[&str] = if head_is_unborn(cwd)? { &["rm", "--cached", "-r", "-q"] } else { &["restore", "--staged"] };
    ok(run_git(cwd, &with_paths(head, paths), None)?).map(|_| ())
}

pub fn stage_all(cwd: &str) -> Result<(), String> {
    ok(run_git(cwd, &["add", "-A"], None)?).map(|_| ())
}

pub fn unstage_all(cwd: &str) -> Result<(), String> {
    let args: &[&str] = if head_is_unborn(cwd)? { &["rm", "--cached", "-r", "-q", "."] } else { &["reset", "-q"] };
    ok(run_git(cwd, args, None)?).map(|_| ())
}

/// `mode`: "stage" (→ index), "unstage" (reverse, index), "discard"
/// (reverse, worktree). The patch is built by the frontend (patch.ts).
pub fn apply_patch(cwd: &str, patch: &str, mode: &str) -> Result<(), String> {
    let mut args = vec!["apply", "--unidiff-zero", "--whitespace=nowarn"];
    match mode {
        "stage" => args.push("--cached"),
        "unstage" => args.extend(["--cached", "-R"]),
        "discard" => args.push("-R"),
        other => return Err(format!("unknown apply mode: {other}")),
    }
    ok(run_git(cwd, &args, Some(patch.as_bytes()))?).map(|_| ())
}

/// Tracked paths are restored from the index (`checkout --`); untracked
/// ones are deleted from disk (`clean -f`). Always confirmed in the UI.
pub fn discard_files(cwd: &str, tracked: &[String], untracked: &[String]) -> Result<(), String> {
    if !tracked.is_empty() {
        ok(run_git(cwd, &with_paths(&["checkout"], tracked), None)?)?;
    }
    if !untracked.is_empty() {
        ok(run_git(cwd, &with_paths(&["clean", "-f"], untracked), None)?)?;
    }
    Ok(())
}

pub fn commit(cwd: &str, message: &str, amend: bool) -> Result<(), String> {
    let mut args = vec!["commit", "-F", "-"];
    if amend {
        args.push("--amend");
    }
    ok(run_git(cwd, &args, Some(message.as_bytes()))?).map(|_| ())
}

pub fn init(cwd: &str) -> Result<(), String> {
    ok(run_git(cwd, &["init", "-q"], None)?).map(|_| ())
}

#[tauri::command]
pub fn git_stage_files(cwd: String, paths: Vec<String>) -> Result<(), String> {
    stage_files(&cwd, &paths)
}

#[tauri::command]
pub fn git_unstage_files(cwd: String, paths: Vec<String>) -> Result<(), String> {
    unstage_files(&cwd, &paths)
}

#[tauri::command]
pub fn git_stage_all(cwd: String) -> Result<(), String> {
    stage_all(&cwd)
}

#[tauri::command]
pub fn git_unstage_all(cwd: String) -> Result<(), String> {
    unstage_all(&cwd)
}

#[tauri::command]
pub fn git_apply_patch(cwd: String, patch: String, mode: String) -> Result<(), String> {
    apply_patch(&cwd, &patch, &mode)
}

#[tauri::command]
pub fn git_discard_files(cwd: String, tracked: Vec<String>, untracked: Vec<String>) -> Result<(), String> {
    discard_files(&cwd, &tracked, &untracked)
}

#[tauri::command]
pub fn git_commit(cwd: String, message: String, amend: bool) -> Result<(), String> {
    commit(&cwd, &message, amend)
}

#[tauri::command]
pub fn git_init(cwd: String) -> Result<(), String> {
    init(&cwd)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p app git::commands`
Expected: 14 passed (7 read + 7 write).

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/src/git/commands.rs app/src/lib/fixtures/patch-fixtures.json
git commit -m "feat(git): stage/unstage/apply/discard/commit/init commands + shared patch fixtures"
```

---

### Task 6: Watcher `watch.rs` + Tauri registration

**Files:**
- Modify: `app/src-tauri/src/git/watch.rs`
- Modify: `app/src-tauri/src/lib.rs` (`.manage(...)` and the `generate_handler!` list — **append** to the existing list; other work lands in this file concurrently, so never replace it wholesale)

**Interfaces:**
- Produces: `watch::is_relevant(rel: &Path) -> bool`; `watch::GitWatchers` (Tauri managed state); commands `git_watch(cwd)` / `git_unwatch(cwd)`; Tauri event `git-changed` with payload `{ "cwd": string }`.

- [ ] **Step 1: Write the failing filter tests**

Replace the placeholder in `watch.rs` with:
```rust
//! Watcher-driven refresh for the Git tab (spec §2, decision G9): a
//! recursive, debounced `notify` watch on the worktree that emits
//! `git-changed`. NEVER a timer — see crates/daemon/src/git_status.rs for
//! the index.lock history behind that rule.

use notify_debouncer_mini::Debouncer;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

pub const GIT_WATCH_DEBOUNCE: Duration = Duration::from_millis(300);

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(p: &str) -> bool {
        is_relevant(Path::new(p))
    }

    #[test]
    fn worktree_paths_are_relevant() {
        assert!(rel("src/lib/foo.ts"));
        assert!(rel("README.md"));
        assert!(rel("nested/.gitignore"));
    }

    #[test]
    fn only_state_files_inside_dot_git_are_relevant() {
        for p in ["HEAD", "ORIG_HEAD", "MERGE_HEAD", "index", "packed-refs", "refs/heads/main", "rebase-merge/done", "rebase-apply/next"] {
            assert!(rel(&format!(".git/{p}")), "{p} should be relevant");
        }
        for p in ["index.lock", "refs/heads/main.lock", "objects/ab/cdef", "logs/HEAD", "FETCH_HEAD", "COMMIT_EDITMSG", "hooks/pre-commit"] {
            assert!(!rel(&format!(".git/{p}")), "{p} should be ignored");
        }
    }

    #[test]
    fn lock_files_anywhere_under_dot_git_are_ignored() {
        assert!(!rel(".git/HEAD.lock"));
        assert!(!rel(".git/packed-refs.lock"));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p app git::watch`
Expected: compile error — `is_relevant` not found.

- [ ] **Step 3: Implement the filter, the state and the commands**

Insert above `mod tests`:
```rust
/// Which paths (relative to the worktree root) should trigger a refresh.
/// Everything outside `.git/` counts; inside it only the state files the
/// tab actually renders from. `*.lock` never counts — `index.lock` is
/// created by every writing git command including our own, and reacting
/// to it would make the watcher chase its own tail.
pub fn is_relevant(rel: &Path) -> bool {
    let mut comps = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned());
    let Some(first) = comps.next() else { return false };
    if first != ".git" {
        return true;
    }
    if rel.to_string_lossy().ends_with(".lock") {
        return false;
    }
    let Some(second) = comps.next() else { return false };
    matches!(
        second.as_str(),
        "HEAD" | "ORIG_HEAD" | "MERGE_HEAD" | "index" | "packed-refs" | "refs" | "rebase-merge" | "rebase-apply"
    )
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChanged {
    pub cwd: String,
}

/// Active worktree watchers keyed by worktree path, refcounted so two
/// callers (e.g. the tab and the Home tile) share one OS watch.
pub struct GitWatchers(pub Mutex<HashMap<String, (Debouncer<notify::RecommendedWatcher>, usize)>>);

impl Default for GitWatchers {
    fn default() -> Self {
        GitWatchers(Mutex::new(HashMap::new()))
    }
}

fn spawn_worktree_watcher<F>(root: &str, on_change: F) -> anyhow::Result<Debouncer<notify::RecommendedWatcher>>
where
    F: Fn() + Send + 'static,
{
    let root_path = PathBuf::from(root);
    let filter_root = root_path.clone();
    let mut debouncer = notify_debouncer_mini::new_debouncer(
        GIT_WATCH_DEBOUNCE,
        move |res: notify_debouncer_mini::DebounceEventResult| {
            let Ok(events) = res else { return };
            let hit = events.iter().any(|e| match e.path.strip_prefix(&filter_root) {
                Ok(rel) => is_relevant(rel),
                Err(_) => true,
            });
            if hit {
                on_change();
            }
        },
    )?;
    debouncer.watcher().watch(&root_path, notify::RecursiveMode::Recursive)?;
    Ok(debouncer)
}

#[tauri::command]
pub fn git_watch(cwd: String, app_handle: AppHandle, state: State<GitWatchers>) -> Result<(), String> {
    let mut watchers = state.0.lock().unwrap();
    if let Some(entry) = watchers.get_mut(&cwd) {
        entry.1 += 1;
        return Ok(());
    }
    let emitter = app_handle.clone();
    let payload = GitChanged { cwd: cwd.clone() };
    let debouncer = spawn_worktree_watcher(&cwd, move || {
        let _ = emitter.emit("git-changed", payload.clone());
    })
    .map_err(|e| e.to_string())?;
    watchers.insert(cwd, (debouncer, 1));
    Ok(())
}

#[tauri::command]
pub fn git_unwatch(cwd: String, state: State<GitWatchers>) -> Result<(), String> {
    let mut watchers = state.0.lock().unwrap();
    let remove = match watchers.get_mut(&cwd) {
        Some(entry) => {
            entry.1 = entry.1.saturating_sub(1);
            entry.1 == 0
        }
        None => false,
    };
    if remove {
        watchers.remove(&cwd);
    }
    Ok(())
}
```

- [ ] **Step 4: Register state and commands in `lib.rs`**

After `.manage(fileviewer::FileWatchers::default())` add:
```rust
        .manage(git::GitWatchers::default())
```
Inside `tauri::generate_handler![ … ]`, append after the current last entry (add a trailing comma to it first):
```rust
            git::git_repo_info,
            git::git_status,
            git::git_diff,
            git::git_stage_files,
            git::git_unstage_files,
            git::git_stage_all,
            git::git_unstage_all,
            git::git_apply_patch,
            git::git_discard_files,
            git::git_commit,
            git::git_init,
            git::git_watch,
            git::git_unwatch
```

- [ ] **Step 5: Run the tests and a full build check**

Run: `cargo test -p app git::` then `cargo check -p app`
Expected: all `git::` tests pass (3 watch + 14 commands + 11 parse + 4 run = 32); `cargo check` clean.

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/src/git/watch.rs app/src-tauri/src/lib.rs
git commit -m "feat(git): debounced worktree watcher emitting git-changed; register Git commands"
```

---

### Task 7: Persisted `gitView` prefs on `Workspace` (Rust + TS)

**Files:**
- Modify: `app/src-tauri/src/config.rs` (struct at ~`:37-56`, literal at ~`:154`, shape test at ~`:290-312`, tests block)
- Modify: `app/src-tauri/src/session.rs` — every `Workspace { … }` literal (`grep -n "agent_command: None" app/src-tauri/src/*.rs` lists them all)
- Modify: `app/src/lib/workspace.ts:11-24`
- Modify: `app/src/lib/layoutState.ts` (after `setAgentCommand`, ~`:386`)
- Test: `app/src/lib/layoutState.test.ts`

**Interfaces:**
- Produces: Rust `GitViewPrefs { nav_width: Option<u32>, list_width: Option<u32>, diff_layout: Option<String>, skip_hunk_discard_confirm: bool }`, `Workspace.git_view: Option<GitViewPrefs>`; TS `GitViewPrefs { navWidth?: number; listWidth?: number; diffLayout?: "unified" | "split"; skipHunkDiscardConfirm?: boolean }`, `Workspace.gitView?: GitViewPrefs`, `setGitViewPrefs(workspaceId: string, patch: Partial<GitViewPrefs>): Promise<void>`.

- [ ] **Step 1: Write the failing Rust tests**

In `config.rs`'s tests module, extend the expected JSON in `workspace_serializes_to_the_camel_case_shape_the_frontend_expects` with `"gitView": null` after `"agentCommand": null`, and add:
```rust
    #[test]
    fn git_view_prefs_roundtrip_and_default_to_none_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = sample_workspace();
        ws.git_view = Some(GitViewPrefs {
            nav_width: Some(180),
            list_width: None,
            diff_layout: Some("split".to_string()),
            skip_hunk_discard_confirm: true,
        });
        let config = AppConfig {
            workspaces: vec![ws],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
            file_tabs: HashMap::new(),
            board_tabs: HashMap::new(),
        };
        save(dir.path(), &config).unwrap();
        assert_eq!(load(dir.path()).unwrap(), config);

        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces": [{"id": "ws-1", "name": "A", "pages": [], "activePageId": null}]}"#,
        )
        .unwrap();
        assert_eq!(load(dir.path()).unwrap().workspaces[0].git_view, None);
    }
```
(If `AppConfig` has gained fields since this plan was written, mirror whatever `main_session_and_agent_command_roundtrip` constructs.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p app config::`
Expected: compile error — no field `git_view`.

- [ ] **Step 3: Implement the Rust side**

In `config.rs`, above `pub struct Workspace`:
```rust
/// Per-workspace Git tab preferences (spec §1: splitter widths, diff
/// layout, the hunk/line discard confirm opt-out). Crosses to the frontend
/// inside Workspace, hence camelCase.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitViewPrefs {
    #[serde(default)]
    pub nav_width: Option<u32>,
    #[serde(default)]
    pub list_width: Option<u32>,
    /// "unified" | "split"
    #[serde(default)]
    pub diff_layout: Option<String>,
    #[serde(default)]
    pub skip_hunk_discard_confirm: bool,
}
```
In `Workspace`, after `agent_command`:
```rust
    /// Git tab preferences; None until the user changes something.
    #[serde(default)]
    pub git_view: Option<GitViewPrefs>,
```
Add `git_view: None,` to every `Workspace { … }` literal in `config.rs` and `session.rs`.

- [ ] **Step 4: Run Rust tests**

Run: `cargo test -p app`
Expected: all pass, including the updated shape test.

- [ ] **Step 5: Write the failing TS test**

In `layoutState.test.ts`, add `setGitViewPrefs` to the import list from `./layoutState`, and a describe block:
```ts
describe("setGitViewPrefs", () => {
  it("merges the patch into the workspace's gitView and persists", async () => {
    setState([{ ...ws("ws-1", []), gitView: { diffLayout: "unified", navWidth: 160 } }], "ws-1", null);

    await setGitViewPrefs("ws-1", { diffLayout: "split" });

    expect(get(layoutState).workspaces[0].gitView).toEqual({ diffLayout: "split", navWidth: 160 });
    const persisted = vi.mocked(backend.setWorkspacesState).mock.calls.at(-1)![0];
    expect(persisted.find((w: Workspace) => w.id === "ws-1")?.gitView).toEqual({ diffLayout: "split", navWidth: 160 });
  });

  it("creates gitView when the workspace has none and leaves other workspaces alone", async () => {
    setState([ws("ws-1", []), ws("ws-2", [])], "ws-1", null);

    await setGitViewPrefs("ws-2", { skipHunkDiscardConfirm: true });

    expect(get(layoutState).workspaces[0].gitView).toBeUndefined();
    expect(get(layoutState).workspaces[1].gitView).toEqual({ skipHunkDiscardConfirm: true });
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `cd app && npx vitest run src/lib/layoutState.test.ts -t setGitViewPrefs`
Expected: FAIL — `setGitViewPrefs` is not exported.

- [ ] **Step 7: Implement the TS side**

`workspace.ts`, above `export interface Workspace`:
```ts
export interface GitViewPrefs {
  navWidth?: number;
  listWidth?: number;
  diffLayout?: "unified" | "split";
  skipHunkDiscardConfirm?: boolean;
}
```
and inside `Workspace`, after `agentCommand?: string;`:
```ts
  /// Git tab preferences (splitters, diff layout, discard-confirm opt-out).
  gitView?: GitViewPrefs;
```
`layoutState.ts`: add `GitViewPrefs` to the `import type { Workspace, WorkspacesData, GitStatus } from "./workspace";` line, then after `setAgentCommand`:
```ts
export async function setGitViewPrefs(workspaceId: string, patch: Partial<GitViewPrefs>): Promise<void> {
  const state = get(layoutState);
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, gitView: { ...(w.gitView ?? {}), ...patch } } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}
```

- [ ] **Step 8: Run TS tests and type-check**

Run: `cd app && npm test && npm run check`
Expected: all pass; no type errors.

- [ ] **Step 9: Commit**

```bash
git add app/src-tauri/src/config.rs app/src-tauri/src/session.rs app/src/lib/workspace.ts app/src/lib/layoutState.ts app/src/lib/layoutState.test.ts
git commit -m "feat(git): persisted per-workspace gitView prefs"
```

---

### Task 8: TS types `git.ts` + `backend.ts` wrappers

**Files:**
- Create: `app/src/lib/git.ts`
- Test: `app/src/lib/git.test.ts`
- Modify: `app/src/lib/backend.ts` (append)

**Interfaces:**
- Produces the TS mirrors of Task 1's Rust types (field names are the serde camelCase forms) plus helpers: `lineId(h, i)`, `parseLineId(id)`, `splitPath(path)`, `branchLabel(repo)`, `changedCount(status)`; and `backend.git*` functions listed in Step 4.

- [ ] **Step 1: Write the failing tests**

`app/src/lib/git.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { lineId, parseLineId, splitPath, branchLabel, changedCount, type RepoInfo } from "./git";

const repo: RepoInfo = {
  notARepo: false, root: "/r", branch: "main", detached: false, unborn: false,
  author: { name: "A", email: "a@b" }, headMessage: "m", inProgress: null,
};

describe("lineId", () => {
  it("round-trips hunk and line indexes", () => {
    expect(lineId(2, 17)).toBe("2:17");
    expect(parseLineId("2:17")).toEqual({ hunk: 2, line: 17 });
  });
});

describe("splitPath", () => {
  it("splits directory (with trailing slash) from file name", () => {
    expect(splitPath("src/lib/foo.ts")).toEqual({ dir: "src/lib/", name: "foo.ts" });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});

describe("branchLabel", () => {
  it("renders normal, unborn and detached heads (spec §1 toolbar)", () => {
    expect(branchLabel(repo)).toBe("main");
    expect(branchLabel({ ...repo, unborn: true })).toBe("main (no commits)");
    expect(branchLabel({ ...repo, detached: true, branch: "abc1234" })).toBe("abc1234 · detached");
  });
});

describe("changedCount", () => {
  it("counts unique paths across both lists", () => {
    expect(
      changedCount({
        unstaged: [{ path: "a", status: "M" }, { path: "b", status: "?" }],
        staged: [{ path: "a", status: "M" }, { path: "c", status: "A" }],
      })
    ).toBe(3);
    expect(changedCount(null)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app && npx vitest run src/lib/git.test.ts`
Expected: FAIL — cannot resolve `./git`.

- [ ] **Step 3: Implement `git.ts`**

```ts
// Types crossing from app/src-tauri/src/git/types.rs (serde camelCase) and
// the small pure helpers the Git tab's components share.

export type FileStatus = "M" | "A" | "D" | "R" | "C" | "?" | "U";
export type Area = "unstaged" | "staged";
export type LineKind = "context" | "add" | "del";
export type DiffLayout = "unified" | "split";
export type ApplyMode = "stage" | "unstage" | "discard";

export interface FileEntry {
  path: string;
  oldPath?: string;
  status: FileStatus;
}

export interface StatusResult {
  unstaged: FileEntry[];
  staged: FileEntry[];
}

export interface Line {
  kind: LineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
  noNewline?: boolean;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: Line[];
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  binary: boolean;
  tooLarge: boolean;
  hunks: Hunk[];
}

export interface Author {
  name: string;
  email: string;
}

export interface RepoInfo {
  notARepo: boolean;
  root: string | null;
  branch: string | null;
  detached: boolean;
  unborn: boolean;
  author: Author | null;
  headMessage: string | null;
  inProgress: "merge" | "rebase" | null;
}

/// Hunks longer than this render collapsed (spec §3).
export const LARGE_HUNK_LINES = 500;
/// Per-list display cap (spec §1).
export const LIST_DISPLAY_CAP = 1000;

// Selection ids are "<hunkIndex>:<lineIndex>" — layout-independent, so a
// selection survives switching unified <-> split (spec §3).
export function lineId(hunkIndex: number, lineIndex: number): string {
  return `${hunkIndex}:${lineIndex}`;
}

export function parseLineId(id: string): { hunk: number; line: number } {
  const [h, l] = id.split(":");
  return { hunk: Number(h), line: Number(l) };
}

export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

export function branchLabel(repo: RepoInfo): string {
  const name = repo.branch ?? "HEAD";
  if (repo.detached) return `${name} · detached`;
  if (repo.unborn) return `${name} (no commits)`;
  return name;
}

export function changedCount(status: StatusResult | null): number {
  if (!status) return 0;
  const paths = new Set<string>();
  for (const e of status.unstaged) paths.add(e.path);
  for (const e of status.staged) paths.add(e.path);
  return paths.size;
}
```

- [ ] **Step 4: Add the backend wrappers**

Append to `app/src/lib/backend.ts` (and add `import type { ApplyMode, FileDiff, RepoInfo, StatusResult } from "./git";` at the top):
```ts
// --- Git tab (app/src-tauri/src/git) ---------------------------------------

export function gitRepoInfo(cwd: string): Promise<RepoInfo> {
  return invoke("git_repo_info", { cwd });
}

export function gitStatus(cwd: string): Promise<StatusResult> {
  return invoke("git_status", { cwd });
}

export function gitDiff(
  cwd: string,
  path: string,
  oldPath: string | null,
  staged: boolean,
  untracked: boolean
): Promise<FileDiff> {
  return invoke("git_diff", { cwd, path, oldPath, staged, untracked });
}

export function gitStageFiles(cwd: string, paths: string[]): Promise<void> {
  return invoke("git_stage_files", { cwd, paths });
}

export function gitUnstageFiles(cwd: string, paths: string[]): Promise<void> {
  return invoke("git_unstage_files", { cwd, paths });
}

export function gitStageAll(cwd: string): Promise<void> {
  return invoke("git_stage_all", { cwd });
}

export function gitUnstageAll(cwd: string): Promise<void> {
  return invoke("git_unstage_all", { cwd });
}

export function gitApplyPatch(cwd: string, patch: string, mode: ApplyMode): Promise<void> {
  return invoke("git_apply_patch", { cwd, patch, mode });
}

export function gitDiscardFiles(cwd: string, tracked: string[], untracked: string[]): Promise<void> {
  return invoke("git_discard_files", { cwd, tracked, untracked });
}

export function gitCommit(cwd: string, message: string, amend: boolean): Promise<void> {
  return invoke("git_commit", { cwd, message, amend });
}

export function gitInit(cwd: string): Promise<void> {
  return invoke("git_init", { cwd });
}

export function gitWatch(cwd: string): Promise<void> {
  return invoke("git_watch", { cwd });
}

export function gitUnwatch(cwd: string): Promise<void> {
  return invoke("git_unwatch", { cwd });
}
```

- [ ] **Step 5: Run tests + type-check**

Run: `cd app && npx vitest run src/lib/git.test.ts && npm run check`
Expected: 5 passed; no type errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/git.ts app/src/lib/git.test.ts app/src/lib/backend.ts
git commit -m "feat(git): frontend types, helpers and backend wrappers"
```

---

### Task 9: `diffRows.ts` — one model, two layouts

**Files:**
- Create: `app/src/lib/diffRows.ts`
- Test: `app/src/lib/diffRows.test.ts`

**Interfaces:**
- Consumes: `Hunk`, `Line`, `lineId` from `./git`.
- Produces:
  ```ts
  type HunkRow = { kind: "hunk"; hunkIndex: number; header: string; lineCount: number };
  type UnifiedLineRow = { kind: "line"; hunkIndex: number; lineIndex: number; id: string; line: Line };
  type UnifiedRow = HunkRow | UnifiedLineRow;
  interface SplitCell { id: string; lineIndex: number; kind: LineKind; text: string; no?: number }
  type SplitPairRow = { kind: "pair"; hunkIndex: number; left: SplitCell | null; right: SplitCell | null };
  type SplitRow = HunkRow | SplitPairRow;
  toUnifiedRows(hunks: Hunk[]): UnifiedRow[]
  toSplitRows(hunks: Hunk[]): SplitRow[]
  ```

- [ ] **Step 1: Write the failing tests**

`app/src/lib/diffRows.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { toUnifiedRows, toSplitRows } from "./diffRows";
import type { Hunk, Line } from "./git";

const l = (kind: Line["kind"], text: string, oldNo?: number, newNo?: number): Line => ({ kind, text, oldNo, newNo });

const hunk: Hunk = {
  header: "@@ -1,5 +1,6 @@",
  oldStart: 1, oldLines: 5, newStart: 1, newLines: 6,
  lines: [
    l("context", "alpha", 1, 1),
    l("del", "beta", 2),
    l("add", "BETA", undefined, 2),
    l("context", "gamma", 3, 3),
    l("del", "delta", 4),
    l("add", "new1", undefined, 4),
    l("add", "new2", undefined, 5),
    l("context", "epsilon", 5, 6),
  ],
};

describe("toUnifiedRows", () => {
  it("emits a hunk row then one row per line with layout-independent ids", () => {
    const rows = toUnifiedRows([hunk]);
    expect(rows[0]).toEqual({ kind: "hunk", hunkIndex: 0, header: "@@ -1,5 +1,6 @@", lineCount: 8 });
    expect(rows).toHaveLength(9);
    expect(rows[2]).toMatchObject({ kind: "line", hunkIndex: 0, lineIndex: 1, id: "0:1", line: l("del", "beta", 2) });
  });

  it("numbers hunks independently", () => {
    const rows = toUnifiedRows([hunk, { ...hunk, header: "@@ -20,1 +21,1 @@" }]);
    expect(rows.filter((r) => r.kind === "hunk").map((r) => r.hunkIndex)).toEqual([0, 1]);
    expect(rows.at(-1)).toMatchObject({ id: "1:7" });
  });
});

describe("toSplitRows", () => {
  it("pairs the k-th deletion with the k-th addition and pads leftovers", () => {
    const rows = toSplitRows([hunk]);
    expect(rows[0]).toMatchObject({ kind: "hunk", hunkIndex: 0 });
    const pairs = rows.slice(1).map((r) => (r.kind === "pair" ? [r.left?.text ?? null, r.right?.text ?? null] : r));
    expect(pairs).toEqual([
      ["alpha", "alpha"],
      ["beta", "BETA"],
      ["gamma", "gamma"],
      ["delta", "new1"],
      [null, "new2"],
      ["epsilon", "epsilon"],
    ]);
  });

  it("keeps the same ids as the unified layout so selection survives a toggle", () => {
    const rows = toSplitRows([hunk]);
    const deltaRow = rows.find((r) => r.kind === "pair" && r.left?.text === "delta");
    expect(deltaRow).toMatchObject({ left: { id: "0:4", lineIndex: 4, no: 4 }, right: { id: "0:5", lineIndex: 5, no: 4 } });
  });

  it("flushes a deletion run that is followed by context, not additions", () => {
    const h: Hunk = { ...hunk, lines: [l("del", "a", 1), l("context", "b", 2, 1), l("add", "c", undefined, 2)] };
    const pairs = toSplitRows([h]).slice(1).map((r) => (r.kind === "pair" ? [r.left?.text ?? null, r.right?.text ?? null] : r));
    expect(pairs).toEqual([["a", null], ["b", "b"], [null, "c"]]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app && npx vitest run src/lib/diffRows.test.ts`
Expected: FAIL — cannot resolve `./diffRows`.

- [ ] **Step 3: Implement**

`app/src/lib/diffRows.ts`:
```ts
// Projects parsed hunks into render rows for the two diff layouts
// (spec §3). Both carry the same "<hunk>:<line>" ids so the line selection
// is shared between them.

import { lineId, type Hunk, type Line, type LineKind } from "./git";

export type HunkRow = { kind: "hunk"; hunkIndex: number; header: string; lineCount: number };
export type UnifiedLineRow = { kind: "line"; hunkIndex: number; lineIndex: number; id: string; line: Line };
export type UnifiedRow = HunkRow | UnifiedLineRow;

export interface SplitCell {
  id: string;
  lineIndex: number;
  kind: LineKind;
  text: string;
  no?: number;
}
export type SplitPairRow = { kind: "pair"; hunkIndex: number; left: SplitCell | null; right: SplitCell | null };
export type SplitRow = HunkRow | SplitPairRow;

function hunkRow(hunkIndex: number, hunk: Hunk): HunkRow {
  return { kind: "hunk", hunkIndex, header: hunk.header, lineCount: hunk.lines.length };
}

export function toUnifiedRows(hunks: Hunk[]): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  hunks.forEach((hunk, hunkIndex) => {
    rows.push(hunkRow(hunkIndex, hunk));
    hunk.lines.forEach((line, lineIndex) => {
      rows.push({ kind: "line", hunkIndex, lineIndex, id: lineId(hunkIndex, lineIndex), line });
    });
  });
  return rows;
}

export function toSplitRows(hunks: Hunk[]): SplitRow[] {
  const rows: SplitRow[] = [];
  hunks.forEach((hunk, hunkIndex) => {
    rows.push(hunkRow(hunkIndex, hunk));
    let dels: SplitCell[] = [];
    let adds: SplitCell[] = [];
    const flush = (): void => {
      const n = Math.max(dels.length, adds.length);
      for (let i = 0; i < n; i++) {
        rows.push({ kind: "pair", hunkIndex, left: dels[i] ?? null, right: adds[i] ?? null });
      }
      dels = [];
      adds = [];
    };
    hunk.lines.forEach((line, lineIndex) => {
      const id = lineId(hunkIndex, lineIndex);
      if (line.kind === "del") {
        // A new deletion run after additions starts a fresh pairing block.
        if (adds.length > 0) flush();
        dels.push({ id, lineIndex, kind: "del", text: line.text, no: line.oldNo });
      } else if (line.kind === "add") {
        adds.push({ id, lineIndex, kind: "add", text: line.text, no: line.newNo });
      } else {
        flush();
        rows.push({
          kind: "pair",
          hunkIndex,
          left: { id, lineIndex, kind: "context", text: line.text, no: line.oldNo },
          right: { id, lineIndex, kind: "context", text: line.text, no: line.newNo },
        });
      }
    });
    flush();
  });
  return rows;
}
```

- [ ] **Step 4: Run tests**

Run: `cd app && npx vitest run src/lib/diffRows.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/diffRows.ts app/src/lib/diffRows.test.ts
git commit -m "feat(git): unified and split diff row projections"
```

---

### Task 10: `patch.ts` — the partial-staging patch builder

**Files:**
- Create: `app/src/lib/patch.ts`
- Test: `app/src/lib/patch.test.ts`
- Consumes: `app/src/lib/fixtures/patch-fixtures.json` (Task 5)

**Interfaces:**
- Produces: `buildPatch(diff: FileDiff, hunkIndex: number, selected: ReadonlySet<string> | null): string | null` — `null` when the hunk doesn't exist or the selection yields no `+`/`-` line.

- [ ] **Step 1: Write the failing tests**

`app/src/lib/patch.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildPatch } from "./patch";
import fixtures from "./fixtures/patch-fixtures.json";
import type { FileDiff } from "./git";

interface Fixture {
  name: string;
  diff: FileDiff;
  hunkIndex: number;
  selected: string[] | null;
  expectedPatch: string;
}

describe("buildPatch against the shared fixtures (also applied by the Rust tests)", () => {
  for (const f of fixtures.fixtures as Fixture[]) {
    it(f.name, () => {
      const selected = f.selected === null ? null : new Set(f.selected);
      expect(buildPatch(f.diff, f.hunkIndex, selected)).toBe(f.expectedPatch);
    });
  }
});

describe("buildPatch edge cases", () => {
  const base = (fixtures.fixtures as Fixture[])[0].diff;

  it("returns null when the selection has no change lines", () => {
    expect(buildPatch(base, 0, new Set(["0:0"]))).toBeNull(); // a context line only
    expect(buildPatch(base, 0, new Set())).toBeNull();
    expect(buildPatch(base, 5, null)).toBeNull();
  });

  it("uses oldPath in the --- header for renames and /dev/null for untracked adds", () => {
    const renamed: FileDiff = { ...base, path: "g.txt", oldPath: "f.txt" };
    expect(buildPatch(renamed, 0, null)!.startsWith("--- a/f.txt\n+++ b/g.txt\n")).toBe(true);
    const added: FileDiff = {
      path: "u.txt", binary: false, tooLarge: false,
      hunks: [{ header: "@@ -0,0 +1 @@", oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: [{ kind: "add", text: "hello", newNo: 1 }] }],
    };
    expect(buildPatch(added, 0, null)).toBe("--- /dev/null\n+++ b/u.txt\n@@ -0,0 +1,1 @@\n+hello\n");
  });

  it("recounts the header when only some deletions are selected", () => {
    // Select only "-beta": BETA/new1/new2 dropped, "-delta" becomes context.
    expect(buildPatch(base, 0, new Set(["0:1"]))).toBe(
      "--- a/f.txt\n+++ b/f.txt\n@@ -1,5 +1,4 @@\n alpha\n-beta\n gamma\n delta\n epsilon\n"
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app && npx vitest run src/lib/patch.test.ts`
Expected: FAIL — cannot resolve `./patch`. (If TypeScript complains about importing JSON, confirm `"resolveJsonModule": true` is set in `app/tsconfig.json`; SvelteKit's generated base config enables it — add it under `compilerOptions` if not.)

- [ ] **Step 3: Implement**

`app/src/lib/patch.ts`:
```ts
// Builds the single-hunk patch that `git apply` consumes for hunk and line
// staging (spec §3). The rules, for each line of the chosen hunk:
//   context            -> kept as context
//   add, selected      -> kept as "+"
//   add, unselected    -> dropped (it doesn't exist in the patch's target)
//   del, selected      -> kept as "-"
//   del, unselected    -> emitted as context (the line still exists)
// `selected === null` means the whole hunk. Lines keep their original
// order, matching `git add -p`'s edit semantics. The same patch serves
// stage (--cached), unstage (--cached -R) and discard (-R) because it is
// always expressed against the diff's own base.

import { lineId, type FileDiff } from "./git";

export function buildPatch(diff: FileDiff, hunkIndex: number, selected: ReadonlySet<string> | null): string | null {
  const hunk = diff.hunks[hunkIndex];
  if (!hunk) return null;

  const body: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  let changes = 0;

  hunk.lines.forEach((line, i) => {
    const picked = selected === null || selected.has(lineId(hunkIndex, i));
    let prefix: " " | "+" | "-" | null;
    if (line.kind === "context") prefix = " ";
    else if (line.kind === "add") prefix = picked ? "+" : null;
    else prefix = picked ? "-" : " ";
    if (prefix === null) return;
    if (prefix !== "+") oldCount++;
    if (prefix !== "-") newCount++;
    if (prefix !== " ") changes++;
    body.push(prefix + line.text);
    if (line.noNewline) body.push("\\ No newline at end of file");
  });

  if (changes === 0) return null;

  const isNewFile = hunk.oldStart === 0 && hunk.oldLines === 0 && !diff.oldPath;
  const oldHeader = isNewFile ? "--- /dev/null" : `--- a/${diff.oldPath ?? diff.path}`;
  const header = `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`;
  return [oldHeader, `+++ b/${diff.path}`, header, ...body].join("\n") + "\n";
}
```

- [ ] **Step 4: Run tests**

Run: `cd app && npx vitest run src/lib/patch.test.ts`
Expected: 7 passed (4 fixtures + 3 edge cases).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/patch.ts app/src/lib/patch.test.ts
git commit -m "feat(git): partial-staging patch builder verified against shared fixtures"
```

---

### Task 11: `gitState.ts` — store, reducers, refresh, mutations

**Files:**
- Create: `app/src/lib/gitState.ts`
- Test: `app/src/lib/gitState.test.ts`

**Interfaces:**
- Consumes: `backend.git*` (Task 8), types from `./git`, `listen` from `@tauri-apps/api/event`.
- Produces (all exported):
  ```ts
  interface Selection { path: string; area: Area }
  interface CommitDraft { summary: string; description: string; amend: boolean }
  interface GitViewState {
    cwd: string; repo: RepoInfo | null; status: StatusResult | null;
    selected: Selection | null; diff: FileDiff | null; lineSelection: Set<string>;
    commit: CommitDraft; preAmend: { summary: string; description: string } | null;
    busy: string | null; error: string | null; gitMissing: boolean;
    refreshToken: number; diffToken: number;
  }
  const gitStore: Writable<Record<string, GitViewState>>
  initialState(cwd): GitViewState
  // pure
  findEntry(status, sel): FileEntry | null
  followSelection(status, sel): Selection | null
  applyStatus(state, status): GitViewState
  splitMessage(message): { summary; description }
  joinMessage(draft): string
  canCommit(state): boolean
  // store actions
  ensureGitView(workspaceId, cwd): void
  refresh(workspaceId): Promise<void>
  select(workspaceId, sel: Selection | null): Promise<void>
  setLineSelection(workspaceId, ids: Set<string>): void
  setCommitDraft(workspaceId, patch: Partial<CommitDraft>): void
  dismissError(workspaceId): void
  run(workspaceId, label, op: (cwd: string) => Promise<void>): Promise<boolean>
  stageFiles / unstageFiles (workspaceId, paths: string[]), stageAll / unstageAll (workspaceId),
  applyPatch(workspaceId, patch, mode), discardFiles(workspaceId, tracked, untracked),
  commit(workspaceId), initRepo(workspaceId)
  startWatching(workspaceId): Promise<() => void>
  ```

- [ ] **Step 1: Write the failing tests**

`app/src/lib/gitState.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("./backend", () => ({
  gitRepoInfo: vi.fn(),
  gitStatus: vi.fn(),
  gitDiff: vi.fn(),
  gitStageFiles: vi.fn().mockResolvedValue(undefined),
  gitUnstageFiles: vi.fn().mockResolvedValue(undefined),
  gitStageAll: vi.fn().mockResolvedValue(undefined),
  gitUnstageAll: vi.fn().mockResolvedValue(undefined),
  gitApplyPatch: vi.fn().mockResolvedValue(undefined),
  gitDiscardFiles: vi.fn().mockResolvedValue(undefined),
  gitCommit: vi.fn().mockResolvedValue(undefined),
  gitInit: vi.fn().mockResolvedValue(undefined),
  gitWatch: vi.fn().mockResolvedValue(undefined),
  gitUnwatch: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import * as backend from "./backend";
import {
  gitStore, initialState, applyStatus, followSelection, splitMessage, joinMessage, canCommit,
  ensureGitView, refresh, select, run, stageFiles, commit, setCommitDraft, setLineSelection,
} from "./gitState";
import type { RepoInfo, StatusResult } from "./git";

const repo: RepoInfo = {
  notARepo: false, root: "/r", branch: "main", detached: false, unborn: false,
  author: { name: "A", email: "a@b" }, headMessage: "old subject\n\nold body", inProgress: null,
};
const status: StatusResult = {
  unstaged: [{ path: "a.ts", status: "M" }, { path: "u.txt", status: "?" }],
  staged: [{ path: "a.ts", status: "M" }, { path: "n.ts", status: "A" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  gitStore.set({});
  vi.mocked(backend.gitRepoInfo).mockResolvedValue(repo);
  vi.mocked(backend.gitStatus).mockResolvedValue(status);
  vi.mocked(backend.gitDiff).mockResolvedValue({ path: "a.ts", binary: false, tooLarge: false, hunks: [] });
});

describe("followSelection", () => {
  it("keeps a selection that still exists", () => {
    expect(followSelection(status, { path: "a.ts", area: "unstaged" })).toEqual({ path: "a.ts", area: "unstaged" });
  });
  it("jumps to the counterpart list when the file left its list", () => {
    const after: StatusResult = { unstaged: [], staged: [{ path: "u.txt", status: "A" }] };
    expect(followSelection(after, { path: "u.txt", area: "unstaged" })).toEqual({ path: "u.txt", area: "staged" });
  });
  it("clears when the file has no changes anywhere", () => {
    expect(followSelection({ unstaged: [], staged: [] }, { path: "a.ts", area: "staged" })).toBeNull();
  });
});

describe("applyStatus", () => {
  it("drops the stale diff and line selection when the selection moves", () => {
    const s = { ...initialState("/r"), selected: { path: "u.txt", area: "unstaged" as const }, diff: { path: "u.txt", binary: false, tooLarge: false, hunks: [] }, lineSelection: new Set(["0:0"]) };
    const next = applyStatus(s, { unstaged: [], staged: [{ path: "u.txt", status: "A" }] });
    expect(next.selected).toEqual({ path: "u.txt", area: "staged" });
    expect(next.diff).toBeNull();
    expect(next.lineSelection.size).toBe(0);
  });
});

describe("commit message helpers", () => {
  it("splits on the first blank line and joins back", () => {
    expect(splitMessage("subject\n\nbody\nmore")).toEqual({ summary: "subject", description: "body\nmore" });
    expect(splitMessage("only subject")).toEqual({ summary: "only subject", description: "" });
    expect(joinMessage({ summary: "s", description: "d", amend: false })).toBe("s\n\nd");
    expect(joinMessage({ summary: "s", description: "", amend: false })).toBe("s");
  });
  it("canCommit needs author, summary, staged files (or amend), and no busy op", () => {
    const base = { ...initialState("/r"), repo, status, commit: { summary: "x", description: "", amend: false } };
    expect(canCommit(base)).toBe(true);
    expect(canCommit({ ...base, repo: { ...repo, author: null } })).toBe(false);
    expect(canCommit({ ...base, commit: { ...base.commit, summary: "  " } })).toBe(false);
    expect(canCommit({ ...base, status: { unstaged: [], staged: [] } })).toBe(false);
    expect(canCommit({ ...base, status: { unstaged: [], staged: [] }, commit: { ...base.commit, amend: true } })).toBe(true);
    expect(canCommit({ ...base, busy: "Commit" })).toBe(false);
  });
});

describe("refresh", () => {
  it("loads repo + status and re-diffs the selection", async () => {
    ensureGitView("ws", "/r");
    await select("ws", { path: "a.ts", area: "staged" });
    await refresh("ws");
    const s = get(gitStore)["ws"];
    expect(s.repo).toEqual(repo);
    expect(s.status).toEqual(status);
    expect(backend.gitDiff).toHaveBeenLastCalledWith("/r", "a.ts", null, true, false);
  });

  it("drops a superseded result", async () => {
    ensureGitView("ws", "/r");
    let resolveFirst!: (v: StatusResult) => void;
    vi.mocked(backend.gitStatus)
      .mockImplementationOnce(() => new Promise((res) => (resolveFirst = res)))
      .mockResolvedValueOnce({ unstaged: [], staged: [] });
    const first = refresh("ws");
    await refresh("ws");
    resolveFirst(status);
    await first;
    expect(get(gitStore)["ws"].status).toEqual({ unstaged: [], staged: [] });
  });

  it("flags a missing git binary instead of erroring", async () => {
    ensureGitView("ws", "/r");
    vi.mocked(backend.gitRepoInfo).mockRejectedValueOnce("git was not found on PATH");
    await refresh("ws");
    expect(get(gitStore)["ws"].gitMissing).toBe(true);
    expect(get(gitStore)["ws"].error).toBeNull();
  });
});

describe("run / mutations", () => {
  it("serialises: a second action while busy is refused", async () => {
    ensureGitView("ws", "/r");
    let release!: () => void;
    const slow = run("ws", "Stage", () => new Promise<void>((res) => (release = res)));
    expect(await run("ws", "Stage all", async () => {})).toBe(false);
    release();
    expect(await slow).toBe(true);
    expect(get(gitStore)["ws"].busy).toBeNull();
  });

  it("clears the line selection after a successful mutation but keeps it on failure", async () => {
    ensureGitView("ws", "/r");
    setLineSelection("ws", new Set(["0:1"]));
    vi.mocked(backend.gitStageFiles).mockRejectedValueOnce("boom");
    await stageFiles("ws", ["a.ts"]);
    expect(get(gitStore)["ws"].lineSelection.size).toBe(1);
    await stageFiles("ws", ["a.ts"]);
    expect(get(gitStore)["ws"].lineSelection.size).toBe(0);
  });

  it("records '<label> failed: <stderr>' and still refreshes on failure", async () => {
    ensureGitView("ws", "/r");
    vi.mocked(backend.gitStageFiles).mockRejectedValueOnce("fatal: pathspec 'x' did not match");
    expect(await stageFiles("ws", ["x"])).toBe(false);
    expect(get(gitStore)["ws"].error).toBe("Stage failed: fatal: pathspec 'x' did not match");
    expect(backend.gitStatus).toHaveBeenCalled();
  });

  it("commit joins the draft, clears it on success", async () => {
    ensureGitView("ws", "/r");
    await refresh("ws");
    setCommitDraft("ws", { summary: "feat: x", description: "body" });
    expect(await commit("ws")).toBe(true);
    expect(backend.gitCommit).toHaveBeenCalledWith("/r", "feat: x\n\nbody", false);
    expect(get(gitStore)["ws"].commit).toEqual({ summary: "", description: "", amend: false });
  });

  it("amend pre-fills from HEAD only when the draft is empty, and unticking restores it", async () => {
    ensureGitView("ws", "/r");
    await refresh("ws");
    setCommitDraft("ws", { amend: true });
    expect(get(gitStore)["ws"].commit).toEqual({ summary: "old subject", description: "old body", amend: true });
    setCommitDraft("ws", { amend: false });
    expect(get(gitStore)["ws"].commit).toEqual({ summary: "", description: "", amend: false });

    setCommitDraft("ws", { summary: "mine" });
    setCommitDraft("ws", { amend: true });
    expect(get(gitStore)["ws"].commit.summary).toBe("mine");
  });

  it("ensureGitView resets state when the cwd changes and keeps it otherwise", () => {
    ensureGitView("ws", "/r");
    setLineSelection("ws", new Set(["0:1"]));
    ensureGitView("ws", "/r");
    expect(get(gitStore)["ws"].lineSelection.size).toBe(1);
    ensureGitView("ws", "/other");
    expect(get(gitStore)["ws"].cwd).toBe("/other");
    expect(get(gitStore)["ws"].lineSelection.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app && npx vitest run src/lib/gitState.test.ts`
Expected: FAIL — cannot resolve `./gitState`.

- [ ] **Step 3: Implement**

`app/src/lib/gitState.ts`:
```ts
// The Git tab's state: one GitViewState per workspace (spec §4). Pure
// reducers up top (tested directly), store actions below. Refresh is
// watcher/activation/mutation-driven — never a timer (G9).

import { writable, get } from "svelte/store";
import { listen } from "@tauri-apps/api/event";
import * as backend from "./backend";
import type { ApplyMode, Area, FileDiff, FileEntry, RepoInfo, StatusResult } from "./git";

export interface Selection {
  path: string;
  area: Area;
}

export interface CommitDraft {
  summary: string;
  description: string;
  amend: boolean;
}

export interface GitViewState {
  cwd: string;
  repo: RepoInfo | null;
  status: StatusResult | null;
  selected: Selection | null;
  diff: FileDiff | null;
  lineSelection: Set<string>;
  commit: CommitDraft;
  /// The draft as it was before Amend was ticked, restored on untick.
  preAmend: { summary: string; description: string } | null;
  busy: string | null;
  error: string | null;
  gitMissing: boolean;
  refreshToken: number;
  diffToken: number;
}

export const GIT_NOT_FOUND = "git was not found on PATH";

export const gitStore = writable<Record<string, GitViewState>>({});

export function initialState(cwd: string): GitViewState {
  return {
    cwd,
    repo: null,
    status: null,
    selected: null,
    diff: null,
    lineSelection: new Set(),
    commit: { summary: "", description: "", amend: false },
    preAmend: null,
    busy: null,
    error: null,
    gitMissing: false,
    refreshToken: 0,
    diffToken: 0,
  };
}

// ---- pure ------------------------------------------------------------------

export function findEntry(status: StatusResult | null, sel: Selection | null): FileEntry | null {
  if (!status || !sel) return null;
  return status[sel.area].find((e) => e.path === sel.path) ?? null;
}

/// Spec §1 selection follow rule: stay if still present, else the
/// counterpart list, else nothing.
export function followSelection(status: StatusResult, sel: Selection | null): Selection | null {
  if (!sel) return null;
  if (findEntry(status, sel)) return sel;
  const other: Area = sel.area === "unstaged" ? "staged" : "unstaged";
  if (findEntry(status, { path: sel.path, area: other })) return { path: sel.path, area: other };
  return null;
}

export function applyStatus(state: GitViewState, status: StatusResult): GitViewState {
  const selected = followSelection(status, state.selected);
  const moved = selected?.path !== state.selected?.path || selected?.area !== state.selected?.area;
  return {
    ...state,
    status,
    selected,
    diff: moved ? null : state.diff,
    lineSelection: moved ? new Set() : state.lineSelection,
  };
}

export function splitMessage(message: string): { summary: string; description: string } {
  const idx = message.indexOf("\n\n");
  if (idx < 0) return { summary: message.split("\n")[0] ?? "", description: "" };
  return { summary: message.slice(0, idx), description: message.slice(idx + 2) };
}

export function joinMessage(draft: CommitDraft): string {
  const summary = draft.summary.trim();
  const description = draft.description.trim();
  return description ? `${summary}\n\n${description}` : summary;
}

export function canCommit(state: GitViewState): boolean {
  if (state.busy || !state.repo?.author) return false;
  if (!state.commit.summary.trim()) return false;
  const staged = state.status?.staged.length ?? 0;
  return staged > 0 || state.commit.amend;
}

// ---- store plumbing --------------------------------------------------------

function current(workspaceId: string): GitViewState | null {
  return get(gitStore)[workspaceId] ?? null;
}

function update(workspaceId: string, fn: (s: GitViewState) => GitViewState): void {
  gitStore.update((all) => {
    const s = all[workspaceId];
    return s ? { ...all, [workspaceId]: fn(s) } : all;
  });
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function ensureGitView(workspaceId: string, cwd: string): void {
  gitStore.update((all) => {
    const existing = all[workspaceId];
    if (existing && existing.cwd === cwd) return all;
    return { ...all, [workspaceId]: initialState(cwd) };
  });
}

async function loadDiff(workspaceId: string): Promise<void> {
  const s = current(workspaceId);
  if (!s) return;
  const entry = findEntry(s.status, s.selected);
  if (!s.selected || !entry) {
    update(workspaceId, (st) => ({ ...st, diff: null }));
    return;
  }
  const token = s.diffToken + 1;
  update(workspaceId, (st) => ({ ...st, diffToken: token }));
  const sel = s.selected;
  try {
    const diff = await backend.gitDiff(s.cwd, sel.path, entry.oldPath ?? null, sel.area === "staged", entry.status === "?");
    update(workspaceId, (st) => (st.diffToken === token ? { ...st, diff } : st));
  } catch (e) {
    update(workspaceId, (st) => (st.diffToken === token ? { ...st, diff: null, error: `Diff failed: ${errorText(e)}` } : st));
  }
}

export async function refresh(workspaceId: string): Promise<void> {
  const s = current(workspaceId);
  if (!s) return;
  const token = s.refreshToken + 1;
  update(workspaceId, (st) => ({ ...st, refreshToken: token }));
  try {
    const repo = await backend.gitRepoInfo(s.cwd);
    const status = repo.notARepo ? { unstaged: [], staged: [] } : await backend.gitStatus(s.cwd);
    let stale = false;
    update(workspaceId, (st) => {
      if (st.refreshToken !== token) {
        stale = true;
        return st;
      }
      return { ...applyStatus(st, status), repo, gitMissing: false };
    });
    if (!stale) await loadDiff(workspaceId);
  } catch (e) {
    const text = errorText(e);
    update(workspaceId, (st) => {
      if (st.refreshToken !== token) return st;
      return text === GIT_NOT_FOUND ? { ...st, gitMissing: true } : { ...st, error: `Refresh failed: ${text}` };
    });
  }
}

export async function select(workspaceId: string, sel: Selection | null): Promise<void> {
  update(workspaceId, (st) => ({ ...st, selected: sel, diff: null, lineSelection: new Set() }));
  await loadDiff(workspaceId);
}

export function setLineSelection(workspaceId: string, ids: Set<string>): void {
  update(workspaceId, (st) => ({ ...st, lineSelection: ids }));
}

export function setCommitDraft(workspaceId: string, patch: Partial<CommitDraft>): void {
  update(workspaceId, (st) => {
    let commit = { ...st.commit, ...patch };
    let preAmend = st.preAmend;
    if (patch.amend === true && !st.commit.amend) {
      preAmend = { summary: st.commit.summary, description: st.commit.description };
      const empty = !st.commit.summary.trim() && !st.commit.description.trim();
      if (empty && st.repo?.headMessage) commit = { ...commit, ...splitMessage(st.repo.headMessage) };
    } else if (patch.amend === false && st.commit.amend) {
      commit = { ...commit, summary: preAmend?.summary ?? "", description: preAmend?.description ?? "" };
      preAmend = null;
    }
    return { ...st, commit, preAmend };
  });
}

export function dismissError(workspaceId: string): void {
  update(workspaceId, (st) => ({ ...st, error: null }));
}

/// Every mutation goes through here: refuse while busy, mark busy, run,
/// refresh, record "<label> failed: <stderr>" on error (spec §4).
export async function run(workspaceId: string, label: string, op: (cwd: string) => Promise<void>): Promise<boolean> {
  const s = current(workspaceId);
  if (!s || s.busy) return false;
  update(workspaceId, (st) => ({ ...st, busy: label, error: null }));
  let okResult = true;
  try {
    await op(s.cwd);
  } catch (e) {
    okResult = false;
    update(workspaceId, (st) => ({ ...st, error: `${label} failed: ${errorText(e)}` }));
  }
  // A successful mutation invalidates any line selection (spec §3: the diff
  // is refetched and the selection cleared); a failed one keeps it so the
  // user can retry.
  update(workspaceId, (st) => ({ ...st, busy: null, lineSelection: okResult ? new Set() : st.lineSelection }));
  await refresh(workspaceId);
  return okResult;
}

export function stageFiles(workspaceId: string, paths: string[]): Promise<boolean> {
  return run(workspaceId, "Stage", (cwd) => backend.gitStageFiles(cwd, paths));
}

export function unstageFiles(workspaceId: string, paths: string[]): Promise<boolean> {
  return run(workspaceId, "Unstage", (cwd) => backend.gitUnstageFiles(cwd, paths));
}

export function stageAll(workspaceId: string): Promise<boolean> {
  return run(workspaceId, "Stage all", (cwd) => backend.gitStageAll(cwd));
}

export function unstageAll(workspaceId: string): Promise<boolean> {
  return run(workspaceId, "Unstage all", (cwd) => backend.gitUnstageAll(cwd));
}

const APPLY_LABEL: Record<ApplyMode, string> = { stage: "Stage hunk", unstage: "Unstage hunk", discard: "Discard hunk" };

export function applyPatch(workspaceId: string, patch: string, mode: ApplyMode): Promise<boolean> {
  return run(workspaceId, APPLY_LABEL[mode], (cwd) => backend.gitApplyPatch(cwd, patch, mode));
}

export function discardFiles(workspaceId: string, tracked: string[], untracked: string[]): Promise<boolean> {
  return run(workspaceId, "Discard", (cwd) => backend.gitDiscardFiles(cwd, tracked, untracked));
}

export async function commit(workspaceId: string): Promise<boolean> {
  const s = current(workspaceId);
  if (!s || !canCommit(s)) return false;
  const message = joinMessage(s.commit);
  const amend = s.commit.amend;
  const done = await run(workspaceId, "Commit", (cwd) => backend.gitCommit(cwd, message, amend));
  if (done) {
    update(workspaceId, (st) => ({ ...st, commit: { summary: "", description: "", amend: false }, preAmend: null }));
  }
  return done;
}

export function initRepo(workspaceId: string): Promise<boolean> {
  return run(workspaceId, "Initialize repository", (cwd) => backend.gitInit(cwd));
}

/// Starts the worktree watcher for this workspace's cwd and subscribes to
/// `git-changed`; returns the teardown to call on unmount.
export async function startWatching(workspaceId: string): Promise<() => void> {
  const s = current(workspaceId);
  if (!s) return () => {};
  const cwd = s.cwd;
  await backend.gitWatch(cwd).catch(() => {});
  const unlisten = await listen<{ cwd: string }>("git-changed", (event) => {
    if (event.payload.cwd === cwd) void refresh(workspaceId);
  });
  return () => {
    unlisten();
    void backend.gitUnwatch(cwd).catch(() => {});
  };
}
```

- [ ] **Step 4: Run tests + type-check**

Run: `cd app && npx vitest run src/lib/gitState.test.ts && npm run check`
Expected: 15 passed; no type errors.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/gitState.ts app/src/lib/gitState.test.ts
git commit -m "feat(git): per-workspace git view store with refresh, mutations and commit draft"
```

---

### Task 12: Tab registration + `GitHubView.svelte` shell + `GitNav.svelte`

**Files:**
- Modify: `app/src/lib/workspaceViews.ts:1-22`
- Create: `app/src/lib/GitHubView.svelte`
- Create: `app/src/lib/GitNav.svelte`
- Create (stubs, replaced by Tasks 13/14): `app/src/lib/GitChanges.svelte`, `app/src/lib/GitDiff.svelte`

**Interfaces:**
- Consumes: `gitStore`, `ensureGitView`, `refresh`, `startWatching`, `dismissError`, `initRepo` (Task 11); `branchLabel`, `changedCount` (Task 8); `setGitViewPrefs` (Task 7); `tooltip` action.
- Produces: hub view `id: "git"`; `GitNav` props `{ count: number }`; `GitChanges`/`GitDiff` props `{ workspaceId: string }`.

- [ ] **Step 1: Register the view**

In `workspaceViews.ts`: add `GitBranch` to the lucide import, `import GitHubView from "./GitHubView.svelte";`, and insert directly after the `home` entry in `HUB_VIEWS`:
```ts
  { id: "git", label: "Git", icon: GitBranch, component: GitHubView, requiresRoot: true },
```

- [ ] **Step 2: Create the stubs**

`app/src/lib/GitChanges.svelte` and `app/src/lib/GitDiff.svelte`, identical for now:
```svelte
<script lang="ts">
  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();
</script>

<div class="stub" data-workspace={workspaceId}></div>

<style>
  .stub {
    height: 100%;
  }
</style>
```

- [ ] **Step 3: Create `GitNav.svelte`**

```svelte
<script lang="ts">
  import { FileDiff } from "@lucide/svelte";

  interface Props {
    count: number;
  }
  let { count }: Props = $props();
</script>

<!-- Fork's left rail. SP1 has one entry; SP2/SP3 append Branches, Remotes,
     Stashes and Worktrees sections here. -->
<nav class="nav">
  <button type="button" class="item active">
    <FileDiff size={13} />
    <span class="label">Local Changes</span>
    {#if count > 0}<span class="count">{count}</span>{/if}
  </button>
</nav>

<style>
  .nav {
    height: 100%;
    padding: 8px 6px;
    box-sizing: border-box;
    background: #161616;
    border-right: 1px solid #2f2f2f;
    font-family: monospace;
    font-size: 0.78em;
  }
  .item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    background: transparent;
    border: 0;
    border-radius: 6px;
    color: #bbb;
    cursor: pointer;
    text-align: left;
  }
  .item.active {
    background: #252525;
    color: #eee;
  }
  .label {
    flex: 1 1 auto;
  }
  .count {
    color: #8bc98b;
  }
</style>
```

- [ ] **Step 4: Create `GitHubView.svelte`**

```svelte
<script lang="ts">
  import { GitBranch, RefreshCw } from "@lucide/svelte";
  import { layoutState, setGitViewPrefs } from "./layoutState";
  import { gitStore, ensureGitView, refresh, startWatching, dismissError, initRepo } from "./gitState";
  import { branchLabel, changedCount } from "./git";
  import { tooltip } from "./tooltip";
  import GitNav from "./GitNav.svelte";
  import GitChanges from "./GitChanges.svelte";
  import GitDiff from "./GitDiff.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const NAV_DEFAULT = 160;
  const LIST_DEFAULT = 340;
  const MIN_WIDTH = 120;

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const root = $derived(ws?.rootPath ?? null);
  const view = $derived($gitStore[workspaceId] ?? null);
  const busy = $derived(view?.busy != null);
  const repoName = $derived((view?.repo?.root ?? root ?? "").split("/").filter(Boolean).pop() ?? "");

  let navWidth = $state(NAV_DEFAULT);
  let listWidth = $state(LIST_DEFAULT);
  $effect(() => {
    navWidth = ws?.gitView?.navWidth ?? NAV_DEFAULT;
    listWidth = ws?.gitView?.listWidth ?? LIST_DEFAULT;
  });

  // Mount, workspace switch, or root rebinding: (re)create the view state,
  // refresh once, and hold the worktree watcher for as long as the tab is
  // on screen (spec §4). The effect's cleanup is the unmount path.
  $effect(() => {
    const r = root;
    const id = workspaceId;
    if (!r) return;
    ensureGitView(id, r);
    void refresh(id);
    let stop: (() => void) | null = null;
    let cancelled = false;
    void startWatching(id).then((teardown) => {
      if (cancelled) teardown();
      else stop = teardown;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  });

  // Splitters: window-level listeners with a buttons===0 bail-out, because
  // WKWebView drops pointerup when the pointerdown target leaves the DOM.
  function startDrag(which: "nav" | "list", e: PointerEvent): void {
    e.preventDefault();
    const startX = e.clientX;
    const startW = which === "nav" ? navWidth : listWidth;
    const move = (ev: PointerEvent): void => {
      if (ev.buttons === 0) {
        up();
        return;
      }
      const w = Math.max(MIN_WIDTH, startW + ev.clientX - startX);
      if (which === "nav") navWidth = w;
      else listWidth = w;
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      void setGitViewPrefs(workspaceId, which === "nav" ? { navWidth } : { listWidth });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }
</script>

{#if !root}
  <div class="empty">No root folder set for this workspace.</div>
{:else if !view || (!view.repo && !view.gitMissing && !view.error)}
  <div class="empty">Loading…</div>
{:else if view.gitMissing}
  <div class="empty">
    <b>git was not found on PATH</b>
    <span>Install git (on macOS: <code>xcode-select --install</code>), then reopen this tab.</span>
  </div>
{:else if view.repo?.notARepo}
  <div class="empty">
    <span>Not a git repository</span>
    <button type="button" class="primary" onclick={() => initRepo(workspaceId)} disabled={busy}>Initialize repository</button>
  </div>
{:else}
  <div class="git">
    <div class="toolbar">
      <span class="repo">{repoName}</span>
      {#if view.repo}
        <span class="branch" class:detached={view.repo.detached}>
          <GitBranch size={12} />
          {branchLabel(view.repo)}
        </span>
      {/if}
      <span class="spacer"></span>
      <button type="button" class="icon" use:tooltip={"Refresh"} onclick={() => refresh(workspaceId)} disabled={busy}>
        <RefreshCw size={13} />
      </button>
    </div>
    {#if view.repo?.inProgress}
      <div class="banner info">
        {view.repo.inProgress === "merge" ? "Merge" : "Rebase"} in progress — resolve conflicts and commit
      </div>
    {/if}
    {#if view.error}
      <div class="banner error">
        <span>{view.error}</span>
        <button type="button" use:tooltip={"Dismiss"} onclick={() => dismissError(workspaceId)}>✕</button>
      </div>
    {/if}
    <div class="panes" style:grid-template-columns="{navWidth}px 4px {listWidth}px 4px minmax(0, 1fr)">
      <div class="pane"><GitNav count={changedCount(view.status)} /></div>
      <div class="splitter" role="separator" aria-orientation="vertical" onpointerdown={(e) => startDrag("nav", e)}></div>
      <div class="pane"><GitChanges {workspaceId} /></div>
      <div class="splitter" role="separator" aria-orientation="vertical" onpointerdown={(e) => startDrag("list", e)}></div>
      <div class="pane"><GitDiff {workspaceId} /></div>
    </div>
  </div>
{/if}

<style>
  .git {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    font-family: monospace;
    color: #ccc;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-bottom: 1px solid #2f2f2f;
    font-size: 0.8em;
  }
  .repo {
    color: #eee;
    font-weight: 600;
  }
  .branch {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 7px;
    border: 1px solid #3a3a3a;
    border-radius: 10px;
    color: #bbb;
  }
  .branch.detached {
    border-color: #8a6d2b;
    color: #d9b45c;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .icon {
    display: inline-flex;
    align-items: center;
    background: transparent;
    border: 1px solid #3a3a3a;
    border-radius: 6px;
    color: #bbb;
    padding: 3px 6px;
    cursor: pointer;
  }
  .icon:hover:not(:disabled) {
    border-color: #555;
    color: #eee;
  }
  .icon:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 10px;
    font-size: 0.75em;
  }
  .banner.info {
    background: #2a2417;
    color: #d9b45c;
    border-bottom: 1px solid #4a3d1f;
  }
  .banner.error {
    background: #2b1a1a;
    color: #e08a8a;
    border-bottom: 1px solid #4a2727;
  }
  .banner span {
    flex: 1 1 auto;
    white-space: pre-wrap;
  }
  .banner button {
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
  }
  .panes {
    display: grid;
    flex: 1 1 auto;
    min-height: 0;
  }
  .pane {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .splitter {
    cursor: col-resize;
    background: #2f2f2f;
  }
  .splitter:hover {
    background: #4a4a4a;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    height: 100%;
    color: #888;
    font-family: monospace;
    font-size: 0.85em;
  }
  .empty code {
    color: #bbb;
  }
  .primary {
    background: #2d4a2d;
    border: 1px solid #3f6b3f;
    border-radius: 6px;
    color: #cfe8cf;
    padding: 5px 12px;
    font-family: monospace;
    cursor: pointer;
  }
  .primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
```

- [ ] **Step 5: Type-check and run the app**

Run: `cd app && npm run check` then `npm run tauri dev` (from `app/`).
Expected: no errors; the hub tab row shows **Git** after Home for rooted workspaces; the tab shows toolbar with repo name + branch, the nav with "Local Changes (N)", two empty panes; dragging the splitters resizes and the widths survive an app restart; in a non-repo root the *Initialize repository* button appears and works.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/workspaceViews.ts app/src/lib/GitHubView.svelte app/src/lib/GitNav.svelte app/src/lib/GitChanges.svelte app/src/lib/GitDiff.svelte
git commit -m "feat(git): Git hub tab shell — toolbar, nav, splitters, watcher lifecycle, empty states"
```

---

### Task 13: Unstaged/Staged lists, file rows, keyboard, commit box

**Files:**
- Replace: `app/src/lib/GitChanges.svelte`
- Create: `app/src/lib/GitFileRow.svelte`
- Create: `app/src/lib/GitCommitBox.svelte`

**Interfaces:**
- Consumes: `gitStore`, `select`, `stageFiles`, `unstageFiles`, `stageAll`, `unstageAll`, `setCommitDraft`, `commit`, `canCommit` (Task 11); `LIST_DISPLAY_CAP`, `splitPath` (Task 8).
- Produces: `GitFileRow` props `{ entry: FileEntry; area: Area; selected: boolean; disabled: boolean; onSelect: () => void; onToggle: () => void }` (Task 17 adds `onDiscard`); `GitCommitBox` props `{ workspaceId: string }`.

- [ ] **Step 1: Create `GitFileRow.svelte`**

```svelte
<script lang="ts">
  import { splitPath, type Area, type FileEntry } from "./git";
  import { tooltip } from "./tooltip";

  interface Props {
    entry: FileEntry;
    area: Area;
    selected: boolean;
    disabled: boolean;
    onSelect: () => void;
    onToggle: () => void;
  }
  let { entry, area, selected, disabled, onSelect, onToggle }: Props = $props();

  const parts = $derived(splitPath(entry.path));
  const toggleLabel = $derived(area === "unstaged" ? "Stage" : "Unstage");
</script>

<div class="row" class:selected role="option" aria-selected={selected} tabindex="-1" onclick={onSelect} ondblclick={onToggle}>
  <span class="badge s-{entry.status === '?' ? 'untracked' : entry.status}">{entry.status}</span>
  <span class="path">
    {#if entry.oldPath}<span class="dir">{entry.oldPath} → </span>{/if}
    <span class="dir">{parts.dir}</span><span class="name">{parts.name}</span>
  </span>
  <span class="actions">
    <button type="button" use:tooltip={toggleLabel + " file"} {disabled} onclick={(e) => { e.stopPropagation(); onToggle(); }}>
      {area === "unstaged" ? "+" : "−"}
    </button>
  </span>
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 8px;
    font-size: 0.78em;
    cursor: default;
    user-select: none;
  }
  .row:hover {
    background: #222;
  }
  .row.selected {
    background: #2a3a4a;
  }
  .badge {
    width: 14px;
    text-align: center;
    font-weight: 700;
    flex: 0 0 auto;
  }
  .s-M { color: #d9b45c; }
  .s-A { color: #8bc98b; }
  .s-D { color: #e08a8a; }
  .s-R, .s-C { color: #8ab4e0; }
  .s-untracked { color: #8bc98b; }
  .s-U { color: #ff6b6b; }
  .path {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dir {
    color: #777;
  }
  .name {
    color: #ddd;
  }
  .actions {
    display: none;
    gap: 4px;
  }
  .row:hover .actions,
  .row.selected .actions {
    display: flex;
  }
  .actions button {
    background: transparent;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #bbb;
    width: 20px;
    height: 18px;
    line-height: 1;
    cursor: pointer;
    font-family: monospace;
  }
  .actions button:hover:not(:disabled) {
    border-color: #666;
    color: #eee;
  }
  .actions button:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
```

- [ ] **Step 2: Create `GitCommitBox.svelte`**

```svelte
<script lang="ts">
  import { gitStore, setCommitDraft, commit, canCommit } from "./gitState";
  import { tooltip } from "./tooltip";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const view = $derived($gitStore[workspaceId]);
  const stagedCount = $derived(view?.status?.staged.length ?? 0);
  const author = $derived(view?.repo?.author ?? null);
  const unborn = $derived(view?.repo?.unborn ?? false);
  const draft = $derived(view?.commit ?? { summary: "", description: "", amend: false });
  const enabled = $derived(view ? canCommit(view) : false);

  function onKeydown(e: KeyboardEvent): void {
    if (e.metaKey && e.key === "Enter" && enabled) {
      e.preventDefault();
      void commit(workspaceId);
    }
  }
</script>

<div class="box">
  <input
    class="summary"
    type="text"
    placeholder="Summary"
    value={draft.summary}
    oninput={(e) => setCommitDraft(workspaceId, { summary: e.currentTarget.value })}
    onkeydown={onKeydown}
  />
  <textarea
    class="description"
    placeholder="Description"
    rows="3"
    value={draft.description}
    oninput={(e) => setCommitDraft(workspaceId, { description: e.currentTarget.value })}
    onkeydown={onKeydown}
  ></textarea>
  <div class="foot">
    {#if !unborn}
      <label class="amend" use:tooltip={"Replace the last commit with the staged changes and this message"}>
        <input type="checkbox" checked={draft.amend} onchange={(e) => setCommitDraft(workspaceId, { amend: e.currentTarget.checked })} />
        Amend
      </label>
    {/if}
    <span class="spacer"></span>
    <button type="button" class="commit" disabled={!enabled} use:tooltip={"⌘Enter"} onclick={() => commit(workspaceId)}>
      {draft.amend ? "Amend" : `Commit (${stagedCount})`}
    </button>
  </div>
  <div class="author">
    {#if author}
      {author.name} &lt;{author.email}&gt;
    {:else}
      <span class="warn">Set user.name and user.email in git config</span>
    {/if}
  </div>
</div>

<style>
  .box {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border-top: 1px solid #2f2f2f;
    background: #161616;
    font-size: 0.78em;
  }
  .summary,
  .description {
    width: 100%;
    box-sizing: border-box;
    background: #1e1e1e;
    border: 1px solid #333;
    border-radius: 6px;
    color: #ddd;
    font-family: monospace;
    font-size: 1em;
    padding: 5px 8px;
    resize: vertical;
  }
  .summary:focus,
  .description:focus {
    outline: none;
    border-color: #4a6a8a;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .amend {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: #bbb;
    cursor: pointer;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .commit {
    background: #2d4a2d;
    border: 1px solid #3f6b3f;
    border-radius: 6px;
    color: #cfe8cf;
    padding: 4px 12px;
    font-family: monospace;
    cursor: pointer;
  }
  .commit:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .author {
    color: #777;
    font-size: 0.92em;
  }
  .warn {
    color: #d9b45c;
  }
</style>
```

- [ ] **Step 3: Replace `GitChanges.svelte`**

```svelte
<script lang="ts">
  import { gitStore, select, stageFiles, unstageFiles, stageAll, unstageAll } from "./gitState";
  import { LIST_DISPLAY_CAP, type Area, type FileEntry } from "./git";
  import GitFileRow from "./GitFileRow.svelte";
  import GitCommitBox from "./GitCommitBox.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const view = $derived($gitStore[workspaceId]);
  const unstaged = $derived(view?.status?.unstaged ?? []);
  const staged = $derived(view?.status?.staged ?? []);
  const selected = $derived(view?.selected ?? null);
  const busy = $derived(view?.busy != null);
  const sections = $derived([
    { area: "unstaged" as Area, items: unstaged },
    { area: "staged" as Area, items: staged },
  ]);

  function list(area: Area): FileEntry[] {
    return area === "unstaged" ? unstaged : staged;
  }

  function toggle(entry: FileEntry, area: Area): void {
    if (busy) return;
    void (area === "unstaged" ? stageFiles(workspaceId, [entry.path]) : unstageFiles(workspaceId, [entry.path]));
  }

  // ↑/↓ within a list, Tab between lists, Space stages/unstages (spec §4).
  function onKeydown(e: KeyboardEvent): void {
    if (!selected) {
      if (e.key === "ArrowDown" && unstaged.length > 0) {
        e.preventDefault();
        void select(workspaceId, { path: unstaged[0].path, area: "unstaged" });
      }
      return;
    }
    const items = list(selected.area);
    const idx = items.findIndex((i) => i.path === selected.path);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = items[idx + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) void select(workspaceId, { path: next.path, area: selected.area });
    } else if (e.key === "Tab") {
      const other: Area = selected.area === "unstaged" ? "staged" : "unstaged";
      const target = list(other);
      if (target.length > 0) {
        e.preventDefault();
        void select(workspaceId, { path: target[0].path, area: other });
      }
    } else if (e.key === " ") {
      e.preventDefault();
      const entry = items[idx];
      if (entry) toggle(entry, selected.area);
    }
  }
</script>

<div class="changes" tabindex="0" role="listbox" aria-label="Changed files" onkeydown={onKeydown}>
  {#each sections as { area, items } (area)}
    <section class="list">
      <header>
        <span class="title">{area === "unstaged" ? "Unstaged" : "Staged"}</span>
        <span class="count">{items.length}</span>
        <span class="spacer"></span>
        {#if items.length > 0}
          <button
            type="button"
            class="all"
            disabled={busy}
            onclick={() => (area === "unstaged" ? stageAll(workspaceId) : unstageAll(workspaceId))}
          >
            {area === "unstaged" ? "Stage all" : "Unstage all"}
          </button>
        {/if}
      </header>
      <div class="rows">
        {#each items.slice(0, LIST_DISPLAY_CAP) as entry (area + ":" + entry.path)}
          <GitFileRow
            {entry}
            {area}
            selected={selected?.area === area && selected.path === entry.path}
            disabled={busy}
            onSelect={() => select(workspaceId, { path: entry.path, area })}
            onToggle={() => toggle(entry, area)}
          />
        {/each}
        {#if items.length > LIST_DISPLAY_CAP}
          <div class="more">… and {items.length - LIST_DISPLAY_CAP} more</div>
        {/if}
        {#if items.length === 0}
          <div class="none">{area === "unstaged" ? "No unstaged changes" : "Nothing staged"}</div>
        {/if}
      </div>
    </section>
  {/each}
  <GitCommitBox {workspaceId} />
</div>

<style>
  .changes {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    outline: none;
    background: #1a1a1a;
  }
  .changes:focus-visible {
    box-shadow: inset 0 0 0 1px #4a6a8a;
  }
  .list {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border-bottom: 1px solid #2f2f2f;
  }
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    font-size: 0.72em;
    color: #999;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .count {
    color: #8bc98b;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .all {
    text-transform: none;
    letter-spacing: 0;
    background: transparent;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #bbb;
    font-family: monospace;
    font-size: 1em;
    padding: 1px 6px;
    cursor: pointer;
  }
  .all:hover:not(:disabled) {
    border-color: #666;
    color: #eee;
  }
  .all:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .rows {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .more,
  .none {
    padding: 6px 8px;
    color: #666;
    font-size: 0.75em;
  }
</style>
```

- [ ] **Step 4: Type-check and exercise in the app**

Run: `cd app && npm run check`, then `npm run tauri dev`.
Expected: both lists populate for the workspace repo; clicking a row highlights it; the `+`/`−` row buttons and *Stage all*/*Unstage all* move files and the selection follows (§1 rule); ↑/↓/Tab/Space work once the list container has focus; the commit box commits with ⌘Enter and clears; Amend pre-fills and restores; edits in another terminal (e.g. `touch x`) refresh the list within ~300 ms; `Commit` stays disabled with the author hint when `user.name` is unset (try `git -c user.name= …` in a scratch repo).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/GitChanges.svelte app/src/lib/GitFileRow.svelte app/src/lib/GitCommitBox.svelte
git commit -m "feat(git): unstaged/staged lists, row actions, keyboard nav and commit box"
```

---

### Task 14: Diff viewer — `GitDiff.svelte` + `GitDiffUnified.svelte` with whole-hunk actions

**Files:**
- Replace: `app/src/lib/GitDiff.svelte`
- Create: `app/src/lib/GitDiffUnified.svelte`

**Interfaces:**
- Consumes: `gitStore`, `findEntry`, `applyPatch` (Task 11); `toUnifiedRows` (Task 9); `buildPatch` (Task 10); `LARGE_HUNK_LINES` (Task 8).
- Produces: `GitDiffUnified` props
  ```ts
  { rows: UnifiedRow[]; isCollapsed: (hunkIndex: number, lineCount: number) => boolean;
    canAct: boolean; actionLabel: string; onHunkAction: (hunkIndex: number) => void; onExpand: (hunkIndex: number) => void }
  ```
  (Tasks 15–17 add more props; each task lists its additions.)

- [ ] **Step 1: Create `GitDiffUnified.svelte`**

```svelte
<script lang="ts">
  import type { UnifiedRow } from "./diffRows";

  interface Props {
    rows: UnifiedRow[];
    isCollapsed: (hunkIndex: number, lineCount: number) => boolean;
    canAct: boolean;
    actionLabel: string;
    onHunkAction: (hunkIndex: number) => void;
    onExpand: (hunkIndex: number) => void;
  }
  let { rows, isCollapsed, canAct, actionLabel, onHunkAction, onExpand }: Props = $props();

  // Rows of a collapsed hunk are skipped; the hunk header stays and offers Expand.
  const lineCounts = $derived(new Map(rows.filter((r) => r.kind === "hunk").map((r) => [r.hunkIndex, r.lineCount])));
  function hidden(hunkIndex: number): boolean {
    return isCollapsed(hunkIndex, lineCounts.get(hunkIndex) ?? 0);
  }
</script>

<div class="unified">
  {#each rows as row (row.kind === "hunk" ? "h" + row.hunkIndex : row.id)}
    {#if row.kind === "hunk"}
      <div class="hunk">
        <span class="header">{row.header}</span>
        <span class="spacer"></span>
        {#if hidden(row.hunkIndex)}
          <button type="button" class="act" onclick={() => onExpand(row.hunkIndex)}>Expand ({row.lineCount} lines)</button>
        {/if}
        {#if canAct}
          <button type="button" class="act" onclick={() => onHunkAction(row.hunkIndex)}>{actionLabel}</button>
        {/if}
      </div>
    {:else if !hidden(row.hunkIndex)}
      <div class="line {row.line.kind}">
        <span class="no">{row.line.oldNo ?? ""}</span>
        <span class="no">{row.line.newNo ?? ""}</span>
        <span class="sign">{row.line.kind === "add" ? "+" : row.line.kind === "del" ? "−" : " "}</span>
        <span class="text">{row.line.text}{#if row.line.noNewline}<span class="eof" title="No newline at end of file">⏎̸</span>{/if}</span>
      </div>
    {/if}
  {/each}
</div>

<style>
  .unified {
    font-size: 0.76em;
    line-height: 1.45;
  }
  .hunk {
    position: sticky;
    top: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    background: #20242a;
    color: #8ab4e0;
    border-top: 1px solid #2f2f2f;
    border-bottom: 1px solid #2f2f2f;
    z-index: 1;
  }
  .header {
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .act {
    background: transparent;
    border: 1px solid #3a4a5a;
    border-radius: 4px;
    color: #bcd;
    font-family: monospace;
    font-size: 0.95em;
    padding: 1px 7px;
    cursor: pointer;
    white-space: nowrap;
  }
  .act:hover {
    border-color: #6a8aaa;
    color: #eee;
  }
  .line {
    display: grid;
    grid-template-columns: 3.5em 3.5em 1.2em minmax(0, 1fr);
    white-space: pre;
  }
  .no {
    text-align: right;
    padding-right: 6px;
    color: #666;
    user-select: none;
  }
  .sign {
    color: #888;
    user-select: none;
  }
  .text {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .add {
    background: #17301a;
    color: #b6e3b6;
  }
  .del {
    background: #3a1a1a;
    color: #e8b4b4;
  }
  .context {
    color: #bbb;
  }
  .eof {
    color: #d9b45c;
    margin-left: 4px;
  }
</style>
```

- [ ] **Step 2: Replace `GitDiff.svelte`**

```svelte
<script lang="ts">
  import { gitStore, findEntry, applyPatch } from "./gitState";
  import { toUnifiedRows } from "./diffRows";
  import { buildPatch } from "./patch";
  import { LARGE_HUNK_LINES } from "./git";
  import GitDiffUnified from "./GitDiffUnified.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const view = $derived($gitStore[workspaceId]);
  const selected = $derived(view?.selected ?? null);
  const entry = $derived(view ? findEntry(view.status, view.selected) : null);
  const diff = $derived(view?.diff ?? null);
  const busy = $derived(view?.busy != null);
  // Untracked files have no index entry to patch against: file-level only (spec §1).
  const canAct = $derived(entry !== null && entry.status !== "?" && !busy);
  const actionLabel = $derived(selected?.area === "staged" ? "Unstage" : "Stage");
  const unifiedRows = $derived(diff ? toUnifiedRows(diff.hunks) : []);

  let expanded = $state<Set<number>>(new Set());
  $effect(() => {
    void diff; // a new diff starts with every large hunk collapsed again
    expanded = new Set();
  });
  function isCollapsed(hunkIndex: number, lineCount: number): boolean {
    return lineCount > LARGE_HUNK_LINES && !expanded.has(hunkIndex);
  }
  function expand(hunkIndex: number): void {
    expanded = new Set([...expanded, hunkIndex]);
  }

  function hunkAction(hunkIndex: number): void {
    if (!diff || !selected || !canAct) return;
    const patch = buildPatch(diff, hunkIndex, null);
    if (!patch) return;
    void applyPatch(workspaceId, patch, selected.area === "staged" ? "unstage" : "stage");
  }
</script>

<div class="diff">
  {#if selected && entry}
    <div class="head">
      <span class="badge">{entry.status}</span>
      <span class="path">{#if entry.oldPath}{entry.oldPath} → {/if}{entry.path}</span>
      <span class="area">{selected.area}</span>
    </div>
  {/if}
  <div class="body">
    {#if !selected}
      <div class="msg">Select a file to see its diff</div>
    {:else if !diff}
      <div class="msg">Loading…</div>
    {:else if diff.binary}
      <div class="msg">Binary file — no text diff</div>
    {:else if diff.tooLarge}
      <div class="msg">Diff too large (&gt; 2 MB)</div>
    {:else if diff.hunks.length === 0}
      <div class="msg">No changes</div>
    {:else}
      <GitDiffUnified rows={unifiedRows} {isCollapsed} {canAct} {actionLabel} onHunkAction={hunkAction} onExpand={expand} />
    {/if}
  </div>
</div>

<style>
  .diff {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: #151515;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    border-bottom: 1px solid #2f2f2f;
    font-size: 0.78em;
  }
  .badge {
    font-weight: 700;
    color: #d9b45c;
  }
  .path {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #ddd;
  }
  .area {
    color: #777;
    text-transform: uppercase;
    font-size: 0.85em;
    letter-spacing: 0.05em;
  }
  .body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }
  .msg {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #777;
    font-size: 0.8em;
  }
</style>
```

- [ ] **Step 3: Type-check and exercise**

Run: `cd app && npm run check`, then `npm run tauri dev`.
Expected: selecting an unstaged file shows its hunks with green/red lines and a **Stage** button per hunk; clicking it moves exactly that hunk to the index (the file appears in both lists; the staged row's diff shows only that hunk, with **Unstage**); untracked files show the whole file as added with no hunk button; a hunk over 500 lines shows collapsed with **Expand**; binary/too-large states render their messages.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/GitDiff.svelte app/src/lib/GitDiffUnified.svelte
git commit -m "feat(git): unified diff viewer with per-hunk stage/unstage"
```

---

### Task 15: Split layout + Unified/Split toggle

**Files:**
- Create: `app/src/lib/GitDiffSplit.svelte`
- Modify: `app/src/lib/GitDiff.svelte`

**Interfaces:**
- Consumes: `toSplitRows` (Task 9), `setGitViewPrefs` (Task 7), `layoutState`.
- Produces: `GitDiffSplit` with the same props as `GitDiffUnified` but `rows: SplitRow[]`.

- [ ] **Step 1: Create `GitDiffSplit.svelte`**

```svelte
<script lang="ts">
  import type { SplitRow } from "./diffRows";

  interface Props {
    rows: SplitRow[];
    isCollapsed: (hunkIndex: number, lineCount: number) => boolean;
    canAct: boolean;
    actionLabel: string;
    onHunkAction: (hunkIndex: number) => void;
    onExpand: (hunkIndex: number) => void;
  }
  let { rows, isCollapsed, canAct, actionLabel, onHunkAction, onExpand }: Props = $props();

  const lineCounts = $derived(new Map(rows.filter((r) => r.kind === "hunk").map((r) => [r.hunkIndex, r.lineCount])));
  function hidden(hunkIndex: number): boolean {
    return isCollapsed(hunkIndex, lineCounts.get(hunkIndex) ?? 0);
  }
</script>

<div class="split">
  {#each rows as row, i (row.kind === "hunk" ? "h" + row.hunkIndex : "p" + i)}
    {#if row.kind === "hunk"}
      <div class="hunk">
        <span class="header">{row.header}</span>
        <span class="spacer"></span>
        {#if hidden(row.hunkIndex)}
          <button type="button" class="act" onclick={() => onExpand(row.hunkIndex)}>Expand ({row.lineCount} lines)</button>
        {/if}
        {#if canAct}
          <button type="button" class="act" onclick={() => onHunkAction(row.hunkIndex)}>{actionLabel}</button>
        {/if}
      </div>
    {:else if !hidden(row.hunkIndex)}
      <div class="pair">
        <div class="cell {row.left?.kind ?? 'blank'}">
          <span class="no">{row.left?.no ?? ""}</span>
          <span class="text">{row.left?.text ?? ""}</span>
        </div>
        <div class="cell {row.right?.kind ?? 'blank'}">
          <span class="no">{row.right?.no ?? ""}</span>
          <span class="text">{row.right?.text ?? ""}</span>
        </div>
      </div>
    {/if}
  {/each}
</div>

<style>
  .split {
    font-size: 0.76em;
    line-height: 1.45;
  }
  .hunk {
    position: sticky;
    top: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    background: #20242a;
    color: #8ab4e0;
    border-top: 1px solid #2f2f2f;
    border-bottom: 1px solid #2f2f2f;
    z-index: 1;
  }
  .header {
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .act {
    background: transparent;
    border: 1px solid #3a4a5a;
    border-radius: 4px;
    color: #bcd;
    font-family: monospace;
    font-size: 0.95em;
    padding: 1px 7px;
    cursor: pointer;
    white-space: nowrap;
  }
  .act:hover {
    border-color: #6a8aaa;
    color: #eee;
  }
  .pair {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .cell {
    display: grid;
    grid-template-columns: 3.5em minmax(0, 1fr);
    white-space: pre;
    border-right: 1px solid #2a2a2a;
  }
  .no {
    text-align: right;
    padding-right: 6px;
    color: #666;
    user-select: none;
  }
  .text {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .add {
    background: #17301a;
    color: #b6e3b6;
  }
  .del {
    background: #3a1a1a;
    color: #e8b4b4;
  }
  .context {
    color: #bbb;
  }
  .blank {
    background: #1b1b1b;
  }
</style>
```

- [ ] **Step 2: Add the toggle and layout switch to `GitDiff.svelte`**

In the script: add imports `import { toSplitRows } from "./diffRows";` (merge with the existing import), `import { layoutState, setGitViewPrefs } from "./layoutState";`, `import GitDiffSplit from "./GitDiffSplit.svelte";`, `import type { DiffLayout } from "./git";`, and:
```ts
  const layout = $derived<DiffLayout>(
    $layoutState.workspaces.find((w) => w.id === workspaceId)?.gitView?.diffLayout ?? "unified"
  );
  const splitRows = $derived(diff ? toSplitRows(diff.hunks) : []);
  function setLayout(next: DiffLayout): void {
    if (next !== layout) void setGitViewPrefs(workspaceId, { diffLayout: next });
  }
```
In the header (`.head`), after `<span class="area">…</span>`:
```svelte
      <span class="seg" role="radiogroup" aria-label="Diff layout">
        <button type="button" class:on={layout === "unified"} role="radio" aria-checked={layout === "unified"} onclick={() => setLayout("unified")}>Unified</button>
        <button type="button" class:on={layout === "split"} role="radio" aria-checked={layout === "split"} onclick={() => setLayout("split")}>Split</button>
      </span>
```
Replace the `<GitDiffUnified … />` line with:
```svelte
      {#if layout === "split"}
        <GitDiffSplit rows={splitRows} {isCollapsed} {canAct} {actionLabel} onHunkAction={hunkAction} onExpand={expand} />
      {:else}
        <GitDiffUnified rows={unifiedRows} {isCollapsed} {canAct} {actionLabel} onHunkAction={hunkAction} onExpand={expand} />
      {/if}
```
Add styles:
```css
  .seg {
    display: inline-flex;
    border: 1px solid #3a3a3a;
    border-radius: 6px;
    overflow: hidden;
  }
  .seg button {
    background: transparent;
    border: 0;
    color: #999;
    font-family: monospace;
    font-size: 0.95em;
    padding: 2px 8px;
    cursor: pointer;
  }
  .seg button.on {
    background: #2a3a4a;
    color: #eee;
  }
```

- [ ] **Step 3: Type-check and exercise**

Run: `cd app && npm run check`, then `npm run tauri dev`.
Expected: the toggle switches layouts; split shows deletions left / additions right with the k-th/k-th pairing and blank cells for leftovers; the choice survives switching tabs and restarting the app; hunk Stage/Unstage works in both layouts.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/GitDiffSplit.svelte app/src/lib/GitDiff.svelte
git commit -m "feat(git): side-by-side diff layout with persisted unified/split toggle"
```

---

### Task 16: Line selection + partial staging

**Files:**
- Create: `app/src/lib/diffSelection.ts`
- Test: `app/src/lib/diffSelection.test.ts`
- Modify: `app/src/lib/GitDiffUnified.svelte`, `app/src/lib/GitDiffSplit.svelte`, `app/src/lib/GitDiff.svelte`

**Interfaces:**
- Produces `diffSelection.ts`:
  ```ts
  selectionHunk(ids: ReadonlySet<string>): number | null
  rangeIds(hunks: Hunk[], hunkIndex: number, a: number, b: number): Set<string>   // change lines between a..b inclusive
  clickLine(current: ReadonlySet<string>, hunks: Hunk[], hunkIndex: number, lineIndex: number, shift: boolean, anchor: number | null): { ids: Set<string>; anchor: number | null }
  ```
- Layout components gain props: `selection: ReadonlySet<string>`, `onLineClick: (hunkIndex: number, lineIndex: number, shift: boolean) => void`, `onDragRange: (hunkIndex: number, from: number, to: number) => void`, `selectedLabel: (hunkIndex: number) => string | null` (the "Stage selected (n)" text for that hunk, or null).

- [ ] **Step 1: Write the failing tests**

`app/src/lib/diffSelection.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { selectionHunk, rangeIds, clickLine } from "./diffSelection";
import type { Hunk } from "./git";

const hunks: Hunk[] = [
  {
    header: "@@ -1,5 +1,6 @@", oldStart: 1, oldLines: 5, newStart: 1, newLines: 6,
    lines: [
      { kind: "context", text: "alpha" }, { kind: "del", text: "beta" }, { kind: "add", text: "BETA" },
      { kind: "context", text: "gamma" }, { kind: "del", text: "delta" }, { kind: "add", text: "new1" },
      { kind: "add", text: "new2" }, { kind: "context", text: "epsilon" },
    ],
  },
  { header: "@@ -20,1 +21,1 @@", oldStart: 20, oldLines: 1, newStart: 21, newLines: 1, lines: [{ kind: "del", text: "x" }, { kind: "add", text: "y" }] },
];

describe("selectionHunk", () => {
  it("reports the hunk of the selection or null", () => {
    expect(selectionHunk(new Set(["1:0"]))).toBe(1);
    expect(selectionHunk(new Set())).toBeNull();
  });
});

describe("rangeIds", () => {
  it("covers change lines between the bounds in either order, skipping context", () => {
    expect([...rangeIds(hunks, 0, 1, 5)].sort()).toEqual(["0:1", "0:2", "0:4", "0:5"]);
    expect([...rangeIds(hunks, 0, 5, 1)].sort()).toEqual(["0:1", "0:2", "0:4", "0:5"]);
  });
});

describe("clickLine", () => {
  it("ignores context lines", () => {
    expect(clickLine(new Set(["0:1"]), hunks, 0, 0, false, 1)).toEqual({ ids: new Set(["0:1"]), anchor: 1 });
  });
  it("toggles a single line within the same hunk", () => {
    expect(clickLine(new Set(["0:1"]), hunks, 0, 2, false, 1)).toEqual({ ids: new Set(["0:1", "0:2"]), anchor: 2 });
    expect(clickLine(new Set(["0:1", "0:2"]), hunks, 0, 1, false, 2)).toEqual({ ids: new Set(["0:2"]), anchor: 1 });
  });
  it("replaces the selection when clicking in another hunk", () => {
    expect(clickLine(new Set(["0:1"]), hunks, 1, 1, false, 1)).toEqual({ ids: new Set(["1:1"]), anchor: 1 });
  });
  it("shift-click selects the range from the anchor", () => {
    expect(clickLine(new Set(["0:1"]), hunks, 0, 6, true, 1)).toEqual({ ids: new Set(["0:1", "0:2", "0:4", "0:5", "0:6"]), anchor: 1 });
  });
  it("shift-click without an anchor behaves like a plain click", () => {
    expect(clickLine(new Set(), hunks, 0, 5, true, null)).toEqual({ ids: new Set(["0:5"]), anchor: 5 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app && npx vitest run src/lib/diffSelection.test.ts`
Expected: FAIL — cannot resolve `./diffSelection`.

- [ ] **Step 3: Implement `diffSelection.ts`**

```ts
// Line-selection rules for partial staging (spec §3): only add/del lines,
// one hunk at a time, shift-click/drag extends from an anchor.

import { lineId, parseLineId, type Hunk } from "./git";

export function selectionHunk(ids: ReadonlySet<string>): number | null {
  const first = ids.values().next();
  return first.done ? null : parseLineId(first.value).hunk;
}

export function rangeIds(hunks: Hunk[], hunkIndex: number, a: number, b: number): Set<string> {
  const hunk = hunks[hunkIndex];
  const ids = new Set<string>();
  if (!hunk) return ids;
  const [from, to] = a <= b ? [a, b] : [b, a];
  for (let i = from; i <= to; i++) {
    if (hunk.lines[i] && hunk.lines[i].kind !== "context") ids.add(lineId(hunkIndex, i));
  }
  return ids;
}

export function clickLine(
  current: ReadonlySet<string>,
  hunks: Hunk[],
  hunkIndex: number,
  lineIndex: number,
  shift: boolean,
  anchor: number | null
): { ids: Set<string>; anchor: number | null } {
  const line = hunks[hunkIndex]?.lines[lineIndex];
  if (!line || line.kind === "context") return { ids: new Set(current), anchor };
  const sameHunk = selectionHunk(current) === hunkIndex;
  if (shift && sameHunk && anchor !== null) {
    return { ids: rangeIds(hunks, hunkIndex, anchor, lineIndex), anchor };
  }
  const id = lineId(hunkIndex, lineIndex);
  const ids = sameHunk ? new Set(current) : new Set<string>();
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: lineIndex };
}
```

- [ ] **Step 4: Run tests**

Run: `cd app && npx vitest run src/lib/diffSelection.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Wire selection into `GitDiffUnified.svelte`**

Add to `Props` and destructuring:
```ts
    selection: ReadonlySet<string>;
    onLineClick: (hunkIndex: number, lineIndex: number, shift: boolean) => void;
    onDragRange: (hunkIndex: number, from: number, to: number) => void;
    selectedLabel: (hunkIndex: number) => string | null;
```
Add drag state + handlers in the script:
```ts
  // Gutter drag paints a range within one hunk. Window-level pointerup with
  // a buttons===0 bail-out (WKWebView drops pointerup in some cases).
  let drag: { hunkIndex: number; from: number } | null = null;
  function gutterDown(hunkIndex: number, lineIndex: number, e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = { hunkIndex, from: lineIndex };
    onDragRange(hunkIndex, lineIndex, lineIndex);
    const up = (): void => {
      drag = null;
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }
  function lineEnter(hunkIndex: number, lineIndex: number, e: PointerEvent): void {
    if (!drag) return;
    if (e.buttons === 0) {
      drag = null;
      return;
    }
    if (drag.hunkIndex === hunkIndex) onDragRange(hunkIndex, drag.from, lineIndex);
  }
```
In the markup, replace the hunk header's action button block with:
```svelte
        {#if canAct}
          {@const sel = selectedLabel(row.hunkIndex)}
          <button type="button" class="act" onclick={() => onHunkAction(row.hunkIndex)}>{sel ?? actionLabel}</button>
        {/if}
```
and replace the line row with:
```svelte
      <div
        class="line {row.line.kind}"
        class:selected={selection.has(row.id)}
        class:selectable={row.line.kind !== "context"}
        role="option"
        aria-selected={selection.has(row.id)}
        tabindex="-1"
        onclick={(e) => onLineClick(row.hunkIndex, row.lineIndex, e.shiftKey)}
        onpointerenter={(e) => lineEnter(row.hunkIndex, row.lineIndex, e)}
      >
        <span class="no gutter" onpointerdown={(e) => row.line.kind !== "context" && gutterDown(row.hunkIndex, row.lineIndex, e)}>{row.line.oldNo ?? ""}</span>
        <span class="no gutter" onpointerdown={(e) => row.line.kind !== "context" && gutterDown(row.hunkIndex, row.lineIndex, e)}>{row.line.newNo ?? ""}</span>
        <span class="sign">{row.line.kind === "add" ? "+" : row.line.kind === "del" ? "−" : " "}</span>
        <span class="text">{row.line.text}{#if row.line.noNewline}<span class="eof" title="No newline at end of file">⏎̸</span>{/if}</span>
      </div>
```
Add styles:
```css
  .selectable {
    cursor: pointer;
  }
  .gutter {
    cursor: ns-resize;
  }
  .line.selected {
    outline: 1px solid #6a8aaa;
    outline-offset: -1px;
    filter: brightness(1.25);
  }
```

- [ ] **Step 6: Wire selection into `GitDiffSplit.svelte`**

Same four props and the same `gutterDown`/`lineEnter` handlers as Step 5 (copy them verbatim). The hunk header gets the identical `{@const sel = …}` block. Replace the pair row with:
```svelte
      <div class="pair">
        {#each [row.left, row.right] as cell, side (side)}
          {#if cell}
            <div
              class="cell {cell.kind}"
              class:selected={selection.has(cell.id)}
              class:selectable={cell.kind !== "context"}
              role="option"
              aria-selected={selection.has(cell.id)}
              tabindex="-1"
              onclick={(e) => onLineClick(row.hunkIndex, cell.lineIndex, e.shiftKey)}
              onpointerenter={(e) => lineEnter(row.hunkIndex, cell.lineIndex, e)}
            >
              <span class="no gutter" onpointerdown={(e) => cell.kind !== "context" && gutterDown(row.hunkIndex, cell.lineIndex, e)}>{cell.no ?? ""}</span>
              <span class="text">{cell.text}</span>
            </div>
          {:else}
            <div class="cell blank"><span class="no"></span><span class="text"></span></div>
          {/if}
        {/each}
      </div>
```
and add the same `.selectable`, `.gutter`, `.cell.selected` styles (use `.cell.selected` instead of `.line.selected`).

- [ ] **Step 7: Wire it in `GitDiff.svelte`**

Script additions:
```ts
  import { setLineSelection } from "./gitState";   // merge into the existing gitState import
  import { clickLine, rangeIds, selectionHunk } from "./diffSelection";

  const selection = $derived(view?.lineSelection ?? new Set<string>());
  let anchor = $state<number | null>(null);
  $effect(() => {
    void diff;
    anchor = null;
  });

  function onLineClick(hunkIndex: number, lineIndex: number, shift: boolean): void {
    if (!diff || !canAct) return;
    const next = clickLine(selection, diff.hunks, hunkIndex, lineIndex, shift, anchor);
    anchor = next.anchor;
    setLineSelection(workspaceId, next.ids);
  }
  function onDragRange(hunkIndex: number, from: number, to: number): void {
    if (!diff || !canAct) return;
    anchor = from;
    setLineSelection(workspaceId, rangeIds(diff.hunks, hunkIndex, from, to));
  }
  function selectedLabel(hunkIndex: number): string | null {
    return selectionHunk(selection) === hunkIndex && selection.size > 0 ? `${actionLabel} selected (${selection.size})` : null;
  }
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && selection.size > 0) {
      e.preventDefault();
      setLineSelection(workspaceId, new Set());
    }
  }
```
Change `hunkAction` so a selection in that hunk stages only the selected lines:
```ts
  function hunkAction(hunkIndex: number): void {
    if (!diff || !selected || !canAct) return;
    const partial = selectionHunk(selection) === hunkIndex && selection.size > 0 ? selection : null;
    const patch = buildPatch(diff, hunkIndex, partial);
    if (!patch) return;
    void applyPatch(workspaceId, patch, selected.area === "staged" ? "unstage" : "stage");
  }
```
Markup: make the root focusable for Esc — `<div class="diff" tabindex="-1" onkeydown={onKeydown} onpointerdown={(e) => e.currentTarget.focus()}>` — and pass the new props to both layout components: `{selection} {onLineClick} {onDragRange} {selectedLabel}`. Add `.diff:focus { outline: none; }`.

- [ ] **Step 8: Type-check and exercise**

Run: `cd app && npm run check && npm test`, then `npm run tauri dev`.
Expected: clicking an add/del line highlights it; shift-click extends; dragging down the gutter paints a range; the hunk button reads *Stage selected (n)* and staging it moves just those lines (the staged diff shows them, the unstaged diff keeps the rest); switching Unified↔Split keeps the highlight; Esc clears; context lines don't select; unstage-selected works from the staged row.

- [ ] **Step 9: Commit**

```bash
git add app/src/lib/diffSelection.ts app/src/lib/diffSelection.test.ts app/src/lib/GitDiffUnified.svelte app/src/lib/GitDiffSplit.svelte app/src/lib/GitDiff.svelte
git commit -m "feat(git): line selection with partial stage/unstage in both layouts"
```

---

### Task 17: Discard flows with confirmation

**Files:**
- Create: `app/src/lib/discardFlow.ts`
- Test: `app/src/lib/discardFlow.test.ts`
- Create: `app/src/lib/GitDiscardDialog.svelte`
- Modify: `app/src/lib/GitFileRow.svelte`, `app/src/lib/GitChanges.svelte`, `app/src/lib/GitDiff.svelte`, `app/src/lib/GitDiffUnified.svelte`, `app/src/lib/GitDiffSplit.svelte`

**Interfaces:**
- Produces `discardFlow.ts`:
  ```ts
  interface FileDiscardPrompt { title: string; body: string; tracked: string[]; untracked: string[] }
  describeFileDiscard(entries: FileEntry[]): FileDiscardPrompt
  describeHunkDiscard(path: string, selectedCount: number | null): { title: string; body: string }
  ```
- `GitDiscardDialog` props `{ title: string; body: string; offerSkip: boolean; onConfirm: (skip: boolean) => void; onCancel: () => void }`.
- `GitFileRow` gains `onDiscard?: () => void`; layout components gain `discardLabel: (hunkIndex: number) => string | null` (null hides that hunk's button) and `onHunkDiscard: (hunkIndex: number) => void`.

- [ ] **Step 1: Write the failing tests**

`app/src/lib/discardFlow.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { describeFileDiscard, describeHunkDiscard } from "./discardFlow";

describe("describeFileDiscard", () => {
  it("names tracked discards", () => {
    const p = describeFileDiscard([{ path: "a.ts", status: "M" }, { path: "b.ts", status: "D" }]);
    expect(p.title).toBe("Discard changes in 2 files?");
    expect(p.tracked).toEqual(["a.ts", "b.ts"]);
    expect(p.untracked).toEqual([]);
    expect(p.body).toContain("a.ts");
    expect(p.body).toContain("This cannot be undone.");
  });
  it("calls out untracked deletions separately (git clean removes them from disk)", () => {
    expect(describeFileDiscard([{ path: "u.txt", status: "?" }]).title).toBe("Delete 1 untracked file?");
    const mixed = describeFileDiscard([{ path: "a.ts", status: "M" }, { path: "u.txt", status: "?" }]);
    expect(mixed.title).toBe("Discard changes in 1 file and delete 1 untracked file?");
    expect(mixed.untracked).toEqual(["u.txt"]);
  });
  it("truncates long path lists", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.ts`, status: "M" as const }));
    expect(describeFileDiscard(many).body).toContain("… and 4 more");
  });
});

describe("describeHunkDiscard", () => {
  it("distinguishes whole hunk from selected lines", () => {
    expect(describeHunkDiscard("src/a.ts", null).title).toBe("Discard this hunk in src/a.ts?");
    expect(describeHunkDiscard("src/a.ts", 7).title).toBe("Discard 7 selected lines?");
    expect(describeHunkDiscard("src/a.ts", 1).title).toBe("Discard 1 selected line?");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app && npx vitest run src/lib/discardFlow.test.ts`
Expected: FAIL — cannot resolve `./discardFlow`.

- [ ] **Step 3: Implement `discardFlow.ts`**

```ts
// Copy for the discard confirmations (spec §4): the dialog names exactly
// what goes, and untracked files get their own sentence because `git
// clean` deletes them from disk.

import type { FileEntry } from "./git";

const MAX_LISTED = 8;

export interface FileDiscardPrompt {
  title: string;
  body: string;
  tracked: string[];
  untracked: string[];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function listPaths(paths: string[]): string {
  const shown = paths.slice(0, MAX_LISTED);
  const rest = paths.length - shown.length;
  return shown.join("\n") + (rest > 0 ? `\n… and ${rest} more` : "");
}

export function describeFileDiscard(entries: FileEntry[]): FileDiscardPrompt {
  const tracked = entries.filter((e) => e.status !== "?").map((e) => e.path);
  const untracked = entries.filter((e) => e.status === "?").map((e) => e.path);
  let title: string;
  if (tracked.length && untracked.length) {
    title = `Discard changes in ${plural(tracked.length, "file")} and delete ${plural(untracked.length, "untracked file")}?`;
  } else if (untracked.length) {
    title = `Delete ${plural(untracked.length, "untracked file")}?`;
  } else {
    title = `Discard changes in ${plural(tracked.length, "file")}?`;
  }
  const body = `${listPaths([...tracked, ...untracked])}\n\nThis cannot be undone.`;
  return { title, body, tracked, untracked };
}

export function describeHunkDiscard(path: string, selectedCount: number | null): { title: string; body: string } {
  const title = selectedCount === null ? `Discard this hunk in ${path}?` : `Discard ${plural(selectedCount, "selected line")}?`;
  return { title, body: `${path}\n\nThe working-tree changes are reverted. This cannot be undone.` };
}
```

- [ ] **Step 4: Run tests**

Run: `cd app && npx vitest run src/lib/discardFlow.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Create `GitDiscardDialog.svelte`**

```svelte
<script lang="ts">
  import Modal from "./Modal.svelte";

  interface Props {
    title: string;
    body: string;
    offerSkip: boolean;
    onConfirm: (skip: boolean) => void;
    onCancel: () => void;
  }
  let { title, body, offerSkip, onConfirm, onCancel }: Props = $props();

  let skip = $state(false);
</script>

<Modal onClose={onCancel}>
  <h3>{title}</h3>
  <pre class="body">{body}</pre>
  {#if offerSkip}
    <label class="skip"><input type="checkbox" bind:checked={skip} /> Don't ask again for hunks and lines</label>
  {/if}
  <div class="actions">
    <button type="button" onclick={onCancel}>Cancel</button>
    <button type="button" class="danger" onclick={() => onConfirm(skip)}>Discard</button>
  </div>
</Modal>

<style>
  h3 {
    margin: 0 0 10px;
    font-size: 1em;
    color: #eee;
  }
  .body {
    margin: 0 0 12px;
    white-space: pre-wrap;
    color: #bbb;
    font-size: 0.85em;
    max-height: 40vh;
    overflow: auto;
  }
  .skip {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #999;
    font-size: 0.8em;
    margin-bottom: 12px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .actions button {
    background: #333;
    border: 1px solid #444;
    border-radius: 6px;
    color: #ddd;
    padding: 5px 12px;
    font-family: monospace;
    cursor: pointer;
  }
  .danger {
    background: #4a2020 !important;
    border-color: #7a3030 !important;
    color: #f0c0c0 !important;
  }
</style>
```

- [ ] **Step 6: File-level discard in `GitFileRow.svelte` + `GitChanges.svelte`**

`GitFileRow.svelte`: add `onDiscard?: () => void;` to `Props` (and destructure it); inside `.actions`, before the toggle button:
```svelte
    {#if onDiscard}
      <button type="button" class="danger" use:tooltip={entry.status === "?" ? "Delete untracked file" : "Discard changes"} {disabled} onclick={(e) => { e.stopPropagation(); onDiscard?.(); }}>🗑</button>
    {/if}
```
and the style `.actions .danger:hover:not(:disabled) { border-color: #7a3030; color: #f0c0c0; }`.

`GitChanges.svelte`: import `discardFiles` from `./gitState`, `describeFileDiscard` from `./discardFlow`, `GitDiscardDialog`, and `type { FileEntry }` is already imported. Add:
```ts
  let pending = $state<ReturnType<typeof describeFileDiscard> | null>(null);
  function askDiscard(entry: FileEntry): void {
    pending = describeFileDiscard([entry]);
  }
  function confirmDiscard(): void {
    if (!pending) return;
    const { tracked, untracked } = pending;
    pending = null;
    void discardFiles(workspaceId, tracked, untracked);
  }
```
Pass `onDiscard={area === "unstaged" ? () => askDiscard(entry) : undefined}` to `GitFileRow` (discard only applies to worktree changes). At the end of the markup:
```svelte
{#if pending}
  <GitDiscardDialog title={pending.title} body={pending.body} offerSkip={false} onConfirm={confirmDiscard} onCancel={() => (pending = null)} />
{/if}
```

- [ ] **Step 7: Hunk/line discard in the diff**

`GitDiffUnified.svelte` and `GitDiffSplit.svelte`: add props `discardLabel: (hunkIndex: number) => string | null;` and `onHunkDiscard: (hunkIndex: number) => void;`. In each hunk header, after the stage/unstage button:
```svelte
        {#if canAct}
          {@const dl = discardLabel(row.hunkIndex)}
          {#if dl}
            <button type="button" class="act danger" onclick={() => onHunkDiscard(row.hunkIndex)}>{dl}</button>
          {/if}
        {/if}
```
with style `.act.danger { border-color: #5a3030; color: #e0a0a0; } .act.danger:hover { border-color: #9a4040; color: #fcc; }`.

`GitDiff.svelte`: imports — `setGitViewPrefs` is already imported; add `describeHunkDiscard` from `./discardFlow` and `GitDiscardDialog`. Script:
```ts
  const skipHunkConfirm = $derived(
    $layoutState.workspaces.find((w) => w.id === workspaceId)?.gitView?.skipHunkDiscardConfirm ?? false
  );
  // Discard only exists for worktree changes: unstaged rows, tracked files.
  // The "selected" wording applies only to the hunk that owns the selection.
  function discardLabelFor(hunkIndex: number): string | null {
    if (selected?.area !== "unstaged" || !canAct) return null;
    return selectionHunk(selection) === hunkIndex && selection.size > 0 ? `Discard selected (${selection.size})` : "Discard";
  }
  let pendingHunk = $state<{ hunkIndex: number; patch: string; title: string; body: string } | null>(null);

  function onHunkDiscard(hunkIndex: number): void {
    if (!diff || !selected || selected.area !== "unstaged" || !canAct) return;
    const partial = selectionHunk(selection) === hunkIndex && selection.size > 0 ? selection : null;
    const patch = buildPatch(diff, hunkIndex, partial);
    if (!patch) return;
    if (skipHunkConfirm) {
      void applyPatch(workspaceId, patch, "discard");
      return;
    }
    const { title, body } = describeHunkDiscard(diff.path, partial ? partial.size : null);
    pendingHunk = { hunkIndex, patch, title, body };
  }
  function confirmHunkDiscard(skip: boolean): void {
    if (!pendingHunk) return;
    const { patch } = pendingHunk;
    pendingHunk = null;
    if (skip) void setGitViewPrefs(workspaceId, { skipHunkDiscardConfirm: true });
    void applyPatch(workspaceId, patch, "discard");
  }
```
Pass `discardLabel={discardLabelFor} {onHunkDiscard}` to both layout components, and render the dialog at the end of `GitDiff.svelte`'s markup:
```svelte
{#if pendingHunk}
  <GitDiscardDialog title={pendingHunk.title} body={pendingHunk.body} offerSkip={true} onConfirm={confirmHunkDiscard} onCancel={() => (pendingHunk = null)} />
{/if}
```

- [ ] **Step 8: Type-check and exercise**

Run: `cd app && npm run check && npm test`, then `npm run tauri dev`.
Expected: the trash icon on an unstaged row opens *"Discard changes in 1 file?"* (or *"Delete 1 untracked file?"*), Cancel does nothing, Discard reverts/deletes; hunk **Discard** asks *"Discard this hunk in …?"* with the skip checkbox; with lines selected it reads *Discard selected (n)* and only those lines revert; ticking "Don't ask again" suppresses the hunk/line dialog on later discards but file-level still confirms; staged rows and untracked files' diffs show no Discard button.

- [ ] **Step 9: Commit**

```bash
git add app/src/lib/discardFlow.ts app/src/lib/discardFlow.test.ts app/src/lib/GitDiscardDialog.svelte app/src/lib/GitFileRow.svelte app/src/lib/GitChanges.svelte app/src/lib/GitDiff.svelte app/src/lib/GitDiffUnified.svelte app/src/lib/GitDiffSplit.svelte
git commit -m "feat(git): discard file/hunk/lines with scoped confirmations and opt-out"
```

---

### Task 18: Home tile, smoke checklist, final verification, plan status

**Files:**
- Modify: `app/src/lib/HomeHubView.svelte`
- Modify: `app/src/lib/smokeChecklist.ts` (append a section to `SMOKE_SECTIONS`)
- Modify: `.gavin-root/plans/git-tab-local-changes.md` (status + checklist)
- Modify: `docs/superpowers/brainstorms/2026-08-20-git-tab-brainstorm.md` (execution notes, repo convention)

- [ ] **Step 1: Home tile**

In `HomeHubView.svelte` script: `import { gitStore, ensureGitView, refresh as refreshGit } from "./gitState";` and `import { changedCount } from "./git";`, plus
```ts
  const git = $derived($gitStore[workspaceId] ?? null);
  const gitLine = $derived(
    git?.gitMissing ? "git not found" : git?.repo?.notARepo ? "not a repository" : git?.status ? `${changedCount(git.status)} changes` : "—"
  );
```
Inside the existing root effect (the one reading PRD/CLAUDE.md), add — a one-shot read, no watcher, matching the "summaries stay summaries" rule:
```ts
    ensureGitView(workspaceId, r);
    void refreshGit(workspaceId);
```
Add a fifth tile after the Board tile and change `.tiles` to `grid-template-columns: repeat(5, 1fr);`:
```svelte
      <button type="button" class="tile" onclick={() => go("git")}>
        <b>Git</b><span>{gitLine}</span>
      </button>
```

- [ ] **Step 2: Smoke checklist section**

Append to `SMOKE_SECTIONS` in `smokeChecklist.ts`:
```ts
  {
    title: "Git tab",
    items: [
      { id: "git-tab-lists", text: "Git tab shows unstaged/staged lists for the workspace repo and refreshes within ~300 ms of `touch x` in a terminal" },
      { id: "git-partial-stage", text: "Select a few lines in a hunk → “Stage selected (n)” stages only those lines (staged diff shows them; unstaged keeps the rest)" },
      { id: "git-split-toggle", text: "Unified/Split toggle keeps the line selection and survives an app restart" },
      { id: "git-discard-untracked", text: "Trash on an untracked row says “Delete 1 untracked file?” and removes the file on confirm", hint: "Cancel must leave the file in place." },
      { id: "git-discard-skip", text: "“Don't ask again for hunks and lines” suppresses the hunk dialog; file-level discard still asks" },
      { id: "git-hook-reject", text: "A failing pre-commit hook shows its stderr in the banner and keeps the commit draft", hint: "printf '#!/bin/sh\\nexit 1' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit" },
      { id: "git-amend", text: "Amend pre-fills HEAD's message when the draft is empty and restores the draft when unticked" },
      { id: "git-not-a-repo", text: "A rooted non-repo workspace shows “Initialize repository”; clicking it turns the tab live" },
    ],
  },
```
If `smokeChecklist.test.ts` asserts section/item counts, update those numbers.

- [ ] **Step 3: Full verification**

Run from the repo root: `cargo test -p app` and from `app/`: `npm test && npm run check`, then `npm run tauri dev` and walk the new smoke section in the Smoke Test workspace.
Expected: all green; every smoke item ticks.

- [ ] **Step 4: Status + notes**

- Set the plan card's status to the board's done column (`gavin_set_plan_field(".gavin-root/plans/git-tab-local-changes.md", "status", "Done")`) and tick its checklist items.
- Append an `## Execution notes — plan 1 (Local Changes, <date>)` section to `docs/superpowers/brainstorms/2026-08-20-git-tab-brainstorm.md` recording anything that diverged from the spec (e.g. binary files show no byte size; `diff` binary detection reads git's "Binary files" line instead of `--numstat`).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/HomeHubView.svelte app/src/lib/smokeChecklist.ts app/src/lib/smokeChecklist.test.ts .gavin-root/plans/git-tab-local-changes.md docs/superpowers/brainstorms/2026-08-20-git-tab-brainstorm.md
git commit -m "feat(git): Home tile, smoke checklist, SP1 complete"
```

---

## Self-review notes (kept for executors)

- Spec §1 "Binary file — N bytes": SP1 renders "Binary file — no text diff" (no size plumbing); recorded as an execution note.
- Spec §2 binary detection "via `--numstat`": implemented by reading git's `Binary files … differ` line from the same diff invocation — one subprocess instead of two, identical outcome.
- Spec §2 `git_repo_info`: unborn is detected with `rev-parse --verify -q HEAD` (spec updated to match: `symbolic-ref` still succeeds on an unborn branch).
- The watcher only watches the worktree root; a linked worktree's real gitdir lives under the main repo's `.git/worktrees/<name>/` and is SP3's concern.
