# Git Status Detection — Part 1 (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect per-session git status (branch, dirty, ahead/behind), deduped
by repo root, and relay it live to the frontend as a new protocol event.

**Architecture:** A new `crates/daemon/src/git_status.rs` module provides pure,
independently-testable building blocks (porcelain-v2 output parsing, repo-root
resolution, running `git status` with a timeout). `crates/daemon/src/server.rs`
wires these into `SessionManager` as a new kind of state this daemon has never
had before — shared *per-repo-root* pollers (not per-session), each with a
filesystem watch, a sparse timer backstop, and a reactive hook off the
existing OSC 133 idle detection. `crates/protocol` gains the wire type and
event; the Tauri app relays it to the frontend exactly like `CwdChanged`/
`StatusChanged` already are.

**Tech Stack:** Rust, `notify` + `notify-debouncer-mini` (new dependencies,
filesystem watching), shelling out to the system `git` binary via
`std::process::Command`.

## Global Constraints

- Per-session status, deduped by canonical repo root — one shared poller per
  unique repo root, not one per session.
- This milestone never runs `git fetch`. Ahead/behind reflects whatever the
  local remote-tracking ref last recorded.
- Refresh triggers, all three, none replacing the others: (1) a filesystem
  watch reacting to real repo-state changes, (2) a reactive hook off the
  existing OSC 133 idle marker detection (free, already-scanned signal), (3) a
  **3-minute** sparse timer backstop. This design exists specifically to avoid
  a real, shipped bug in cmux (this project's own stated inspiration): polling
  `git status` on a tight timer touches `.git/index.lock` on every check, which
  broke other tools watching the same repo and interfered with users' own
  concurrent git commands (manaflow-ai/cmux issues #2722, #4779). Do not
  "simplify" this back toward a single blind polling loop.
- A **10-second** timeout on every `git status` subprocess invocation.
- `git` not on PATH, or any invocation failing for a reason other than "not a
  repo": treated identically to "not in a repo" — no status, no user-facing
  error, logged to stderr only.
- `dirty` is true if git reports *any* changed, renamed, unmerged, or
  untracked entry — untracked files count as dirty.
- `ahead`/`behind` are only meaningful (and the frontend only shows them) when
  an upstream tracking branch exists.
- This state is **not persisted**. Unlike cwd and session status, it's fully
  re-derivable from the filesystem — a daemon restart starts every repo root's
  polling fresh.
- `Response::GitStatusChanged` is sent to *every* session currently mapped to
  a repo root when that root's status updates, not just one.
- `GitStatus` is the first wire type in `crates/protocol` that needs
  camelCase field names (`repoRoot`, `hasUpstream`) — unlike `SessionSummary`
  (also in `crates/protocol`), which never needs this because it's only ever
  consumed Rust-side and reconciled into other frontend-facing shapes before
  reaching Tauri IPC. `GitStatus`, by contrast, forwards directly through to
  the frontend via the same `(id, status)`-tuple event-emission pattern
  `CwdChanged`/`StatusChanged` already use — so it needs
  `#[serde(rename_all = "camelCase")]` on its own definition, verified by a
  dedicated shape test, not inherited from anywhere else.
- Nothing in this plan may synchronously block `spawn_pump`'s PTY-reading loop
  on a `git status` subprocess call (up to the 10-second timeout) — every path
  that could run one must be dispatched off the pump thread. A `git rev-parse
  --show-toplevel` call (repo-root resolution) is cheap enough to run inline,
  matching the existing synchronous SQLite `update_cwd` write already in that
  same loop.
- Every task must leave `cargo build` and `cargo test` (run from the repo
  root, covering `app`, `crates/daemon`, `crates/protocol`) fully green.

---

### Task 1: Dependencies and protocol types

**Files:**
- Modify: `crates/daemon/Cargo.toml`
- Modify: `crates/protocol/src/lib.rs`

**Interfaces:**
- Produces: `pub struct GitStatus { pub repo_root: String, pub branch: String, pub dirty: bool, pub ahead: u32, pub behind: u32, pub has_upstream: bool }` (derives `Debug, Clone, Serialize, Deserialize, PartialEq`, `#[serde(rename_all = "camelCase")]`); `Response::GitStatusChanged { id: String, status: Option<GitStatus> }`.

- [ ] **Step 1: Add the new dependencies**

In `crates/daemon/Cargo.toml`, find:

```toml
[dependencies]
serde = { version = "1", features = ["derive"] }
uuid = { version = "1", features = ["v4", "serde"] }
anyhow = "1"
rusqlite = { version = "0.31", features = ["bundled"] }
portable-pty = "0.8"
protocol = { path = "../protocol" }
```

Replace with:

```toml
[dependencies]
serde = { version = "1", features = ["derive"] }
uuid = { version = "1", features = ["v4", "serde"] }
anyhow = "1"
rusqlite = { version = "0.31", features = ["bundled"] }
portable-pty = "0.8"
protocol = { path = "../protocol" }
notify = "8"
notify-debouncer-mini = "0.7"
```

- [ ] **Step 2: Add `GitStatus` and `Response::GitStatusChanged`**

In `crates/protocol/src/lib.rs`, find the `Response` enum:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Response {
    SessionCreated { id: String },
    SessionList { sessions: Vec<SessionSummary> },
    Output { id: String, data: String },
    SessionExited { id: String, exit_code: i32 },
    CwdChanged { id: String, cwd: String },
    StatusChanged { id: String, status: String },
    Ok,
    Error { message: String },
}
```

Replace with:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Response {
    SessionCreated { id: String },
    SessionList { sessions: Vec<SessionSummary> },
    Output { id: String, data: String },
    SessionExited { id: String, exit_code: i32 },
    CwdChanged { id: String, cwd: String },
    StatusChanged { id: String, status: String },
    GitStatusChanged { id: String, status: Option<GitStatus> },
    Ok,
    Error { message: String },
}

/// A session's git status, deduped daemon-side by repo root (many sessions
/// in the same repo share one of these). Crosses directly through to the
/// frontend via the Tauri event `session.rs`'s relay emits, unlike
/// `SessionSummary` below (which is only ever consumed Rust-side and
/// reconciled into other frontend-facing shapes) -- so unlike
/// `SessionSummary`, this needs camelCase field names to match the
/// frontend's own TypeScript naming, verified by the roundtrip test below
/// rather than assumed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub repo_root: String,
    pub branch: String,
    pub dirty: bool,
    pub ahead: u32,
    pub behind: u32,
    pub has_upstream: bool,
}
```

- [ ] **Step 3: Add the tests**

In the same file's `#[cfg(test)] mod tests` block, add these three tests
immediately after the existing `status_changed_response_roundtrips_through_json_line` test:

```rust
    #[test]
    fn git_status_serializes_to_the_camel_case_shape_the_frontend_expects() {
        let status = GitStatus {
            repo_root: "/Users/alice/project".to_string(),
            branch: "main".to_string(),
            dirty: true,
            ahead: 2,
            behind: 0,
            has_upstream: true,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "repoRoot": "/Users/alice/project",
                "branch": "main",
                "dirty": true,
                "ahead": 2,
                "behind": 0,
                "hasUpstream": true
            })
        );
    }

    #[test]
    fn git_status_changed_response_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let resp = Response::GitStatusChanged {
            id: "s1".to_string(),
            status: Some(GitStatus {
                repo_root: "/tmp/repo".to_string(),
                branch: "main".to_string(),
                dirty: false,
                ahead: 0,
                behind: 0,
                has_upstream: false,
            }),
        };
        write_message(&mut buf, &resp).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Response = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Response::GitStatusChanged { id, status } => {
                assert_eq!(id, "s1");
                let status = status.unwrap();
                assert_eq!(status.repo_root, "/tmp/repo");
                assert_eq!(status.branch, "main");
                assert_eq!(status.dirty, false);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn git_status_changed_response_roundtrips_with_none_status() {
        let mut buf = Vec::new();
        let resp = Response::GitStatusChanged { id: "s1".to_string(), status: None };
        write_message(&mut buf, &resp).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Response = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Response::GitStatusChanged { id, status } => {
                assert_eq!(id, "s1");
                assert_eq!(status, None);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }
```

- [ ] **Step 4: Run the tests**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin && source "$HOME/.cargo/env"; cargo build && cargo test -p protocol`
Expected: clean build (confirms the new dependencies resolve), and PASS — 9
tests (6 existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add crates/daemon/Cargo.toml Cargo.lock crates/protocol/src/lib.rs
git commit -m "feat(protocol): add GitStatus and Response::GitStatusChanged"
```

---

### Task 2: `git_status.rs` — pure porcelain-v2 parser

**Files:**
- Create: `crates/daemon/src/git_status.rs`
- Modify: `crates/daemon/src/main.rs` (add `mod git_status;`)

**Interfaces:**
- Produces: `pub struct ParsedGitStatus { pub branch: String, pub dirty: bool, pub ahead: u32, pub behind: u32, pub has_upstream: bool }` (derives `Debug, Clone, PartialEq`); `pub fn parse_porcelain_v2(output: &str) -> Option<ParsedGitStatus>`.

This task is fully self-contained and independently testable — no process
spawning, no filesystem access, matching `status.rs`/`osc.rs`'s own
pure-scanner precedent. Task 3 builds the process-spawning layer on top of
this.

- [ ] **Step 1: Write the failing tests**

Create `crates/daemon/src/git_status.rs`:

```rust
/// The fields this scanner extracts from `git status --porcelain=v2
/// --branch` output. `ahead`/`behind` are only meaningful when
/// `has_upstream` is true.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedGitStatus {
    pub branch: String,
    pub dirty: bool,
    pub ahead: u32,
    pub behind: u32,
    pub has_upstream: bool,
}

/// Parses `git status --porcelain=v2 --branch` output. Returns `None` for
/// anything that doesn't look like valid output (missing the mandatory
/// `# branch.head` line) rather than panicking -- this milestone's own
/// silent-degradation convention applies here exactly as it does to a
/// malformed OSC sequence in `status.rs`.
///
/// `dirty` is true if ANY non-header, non-blank line is present -- every
/// such line (ordinary changed entries prefixed `1`, renamed/copied
/// entries prefixed `2`, unmerged entries prefixed `u`, and untracked
/// entries prefixed `?`) means the working tree isn't clean. Untracked
/// files counting as dirty matches plain `git status`'s own "Untracked
/// files" section.
#[cfg(test)]
pub fn parse_porcelain_v2(output: &str) -> Option<ParsedGitStatus> {
    parse_porcelain_v2_impl(output)
}

#[cfg(not(test))]
pub fn parse_porcelain_v2(output: &str) -> Option<ParsedGitStatus> {
    parse_porcelain_v2_impl(output)
}

fn parse_porcelain_v2_impl(output: &str) -> Option<ParsedGitStatus> {
    let mut branch: Option<String> = None;
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut has_upstream = false;
    let mut dirty = false;

    for line in output.lines() {
        if let Some(head) = line.strip_prefix("# branch.head ") {
            branch = Some(if head == "(detached)" { "detached".to_string() } else { head.to_string() });
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            has_upstream = true;
            let mut parts = ab.split_whitespace();
            if let (Some(a), Some(b)) = (parts.next(), parts.next()) {
                ahead = a.trim_start_matches('+').parse().unwrap_or(0);
                behind = b.trim_start_matches('-').parse().unwrap_or(0);
            }
        } else if line.starts_with('#') {
            continue;
        } else if !line.is_empty() {
            dirty = true;
        }
    }

    Some(ParsedGitStatus { branch: branch?, dirty, ahead, behind, has_upstream })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_clean_repo_with_no_upstream() {
        let output = "# branch.oid abc123\n# branch.head main\n";
        let parsed = parse_porcelain_v2(output).unwrap();
        assert_eq!(parsed.branch, "main");
        assert_eq!(parsed.dirty, false);
        assert_eq!(parsed.has_upstream, false);
    }

    #[test]
    fn a_changed_entry_counts_as_dirty() {
        let output = "# branch.oid abc123\n# branch.head main\n1 M. N... 100644 100644 100644 abc def src/foo.rs\n";
        let parsed = parse_porcelain_v2(output).unwrap();
        assert_eq!(parsed.dirty, true);
    }

    #[test]
    fn untracked_files_count_as_dirty() {
        let output = "# branch.oid abc123\n# branch.head main\n? new-file.txt\n";
        let parsed = parse_porcelain_v2(output).unwrap();
        assert_eq!(parsed.dirty, true);
    }

    #[test]
    fn a_renamed_entry_counts_as_dirty() {
        let output = "# branch.oid abc123\n# branch.head main\n2 R. N... 100644 100644 100644 abc def R100 src/new.rs\tsrc/old.rs\n";
        let parsed = parse_porcelain_v2(output).unwrap();
        assert_eq!(parsed.dirty, true);
    }

    #[test]
    fn an_unmerged_entry_counts_as_dirty() {
        let output = "# branch.oid abc123\n# branch.head main\nu UU N... 100644 100644 100644 100644 abc def ghi src/conflict.rs\n";
        let parsed = parse_porcelain_v2(output).unwrap();
        assert_eq!(parsed.dirty, true);
    }

    #[test]
    fn parses_ahead_and_behind_from_branch_ab_when_upstream_exists() {
        let output = "# branch.oid abc123\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3\n";
        let parsed = parse_porcelain_v2(output).unwrap();
        assert_eq!(parsed.has_upstream, true);
        assert_eq!(parsed.ahead, 2);
        assert_eq!(parsed.behind, 3);
    }

    #[test]
    fn ahead_and_behind_are_zero_and_has_upstream_is_false_with_no_upstream_configured() {
        let output = "# branch.oid abc123\n# branch.head main\n";
        let parsed = parse_porcelain_v2(output).unwrap();
        assert_eq!(parsed.has_upstream, false);
        assert_eq!(parsed.ahead, 0);
        assert_eq!(parsed.behind, 0);
    }

    #[test]
    fn detached_head_maps_to_a_detached_label_instead_of_the_raw_marker() {
        let output = "# branch.oid abc123\n# branch.head (detached)\n";
        let parsed = parse_porcelain_v2(output).unwrap();
        assert_eq!(parsed.branch, "detached");
    }

    #[test]
    fn malformed_output_with_no_branch_head_line_returns_none_rather_than_panicking() {
        let output = "this is not valid git status output at all\n";
        assert_eq!(parse_porcelain_v2(output), None);
    }

    #[test]
    fn empty_output_returns_none() {
        assert_eq!(parse_porcelain_v2(""), None);
    }

    #[test]
    fn a_clean_repo_with_only_header_lines_and_trailing_blank_line_is_not_dirty() {
        let output = "# branch.oid abc123\n# branch.head main\n\n";
        let parsed = parse_porcelain_v2(output).unwrap();
        assert_eq!(parsed.dirty, false);
    }
}
```

(The `#[cfg(test)]`/`#[cfg(not(test))]` split on `parse_porcelain_v2` is
temporary scaffolding — Task 3 removes it once the function has a second,
non-test caller. Ignore the duplication for now; it exists only so this
task's own tests can call the function without a premature "never used
outside tests" warning breaking the build.)

- [ ] **Step 2: Register the module**

In `crates/daemon/src/main.rs`, find the existing module declarations:

```rust
mod osc;
mod pty;
mod registry;
mod server;
mod status;
```

Replace with:

```rust
mod git_status;
mod osc;
mod pty;
mod registry;
mod server;
mod status;
```

(Alphabetical, matching this list's existing convention.)

- [ ] **Step 3: Run the tests**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin && source "$HOME/.cargo/env"; cargo test -p gavin-daemon git_status::`
Expected: PASS — 10 tests.

- [ ] **Step 4: Verify the whole workspace still builds**

Run: `cargo build && cargo test`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add crates/daemon/src/git_status.rs crates/daemon/src/main.rs
git commit -m "feat(daemon): add the pure git status porcelain-v2 parser"
```

---

### Task 3: `git_status.rs` — repo-root resolution and running `git status`

**Files:**
- Modify: `crates/daemon/src/git_status.rs`

**Interfaces:**
- Consumes: `ParsedGitStatus`, `parse_porcelain_v2` (Task 2); `protocol::GitStatus` (Task 1).
- Produces: `pub fn resolve_repo_root(cwd: &str) -> Option<String>`; `pub fn run_git_status(repo_root: &str) -> Option<protocol::GitStatus>`.

This is the first task in this project needing a genuinely new testing
pattern: integration tests against a *real* temporary git repository (via
`tempfile` plus shelling to `git init`/`git commit`/etc.), not just fixed
sample text. Every existing daemon test uses `tempfile::tempdir()` already
(for PTY sessions and the SQLite registry) — this reuses that same fixture
approach for git repos instead.

- [ ] **Step 1: Remove the temporary test-only scaffolding from Task 2**

In `crates/daemon/src/git_status.rs`, find:

```rust
#[cfg(test)]
pub fn parse_porcelain_v2(output: &str) -> Option<ParsedGitStatus> {
    parse_porcelain_v2_impl(output)
}

#[cfg(not(test))]
pub fn parse_porcelain_v2(output: &str) -> Option<ParsedGitStatus> {
    parse_porcelain_v2_impl(output)
}

fn parse_porcelain_v2_impl(output: &str) -> Option<ParsedGitStatus> {
```

Replace with:

```rust
pub fn parse_porcelain_v2(output: &str) -> Option<ParsedGitStatus> {
```

(Now that this task adds a second, non-test caller of `parse_porcelain_v2`,
the `#[cfg(test)]`/`#[cfg(not(test))]` split that silenced an "unused
outside tests" warning is no longer needed — collapse back to one plain
function. Both the find and replace blocks above end mid-statement, right
after the opening `{` — everything from there through the function's own
closing `}` is the existing function body from Task 2, entirely unchanged;
only the three-function preamble above it collapses into one signature.)

- [ ] **Step 2: Write the failing tests**

In the same file's `#[cfg(test)] mod tests` block, add this at the very end
(after the existing parser tests, still inside the same `mod tests` block —
do not close and reopen it):

```rust
    mod git_shelling_tests {
        use super::super::*;
        use std::process::Command;

        fn init_repo(dir: &std::path::Path) {
            Command::new("git").args(["init", "-q"]).current_dir(dir).status().unwrap();
            Command::new("git").args(["config", "user.email", "test@example.com"]).current_dir(dir).status().unwrap();
            Command::new("git").args(["config", "user.name", "Test"]).current_dir(dir).status().unwrap();
            // git init's default branch name depends on the test machine's
            // global config -- pin it explicitly so these tests don't
            // depend on that.
            Command::new("git").args(["checkout", "-q", "-b", "main"]).current_dir(dir).status().unwrap();
        }

        fn commit_all(dir: &std::path::Path, message: &str) {
            Command::new("git").args(["add", "-A"]).current_dir(dir).status().unwrap();
            Command::new("git").args(["commit", "-q", "-m", message]).current_dir(dir).status().unwrap();
        }

        #[test]
        fn resolve_repo_root_finds_the_toplevel_from_a_nested_subdirectory() {
            let dir = tempfile::tempdir().unwrap();
            init_repo(dir.path());
            std::fs::write(dir.path().join("file.txt"), "hello").unwrap();
            commit_all(dir.path(), "initial");

            let nested = dir.path().join("a").join("b");
            std::fs::create_dir_all(&nested).unwrap();

            let root = resolve_repo_root(nested.to_str().unwrap()).unwrap();
            // Canonicalize both sides -- macOS's /tmp is a symlink to
            // /private/tmp, and `git rev-parse --show-toplevel` resolves
            // through it, so a direct string comparison against the
            // un-canonicalized tempdir path would spuriously fail.
            assert_eq!(
                std::fs::canonicalize(&root).unwrap(),
                std::fs::canonicalize(dir.path()).unwrap()
            );
        }

        #[test]
        fn resolve_repo_root_returns_none_outside_any_repo() {
            let dir = tempfile::tempdir().unwrap();
            assert_eq!(resolve_repo_root(dir.path().to_str().unwrap()), None);
        }

        #[test]
        fn run_git_status_reports_clean_for_a_fully_committed_repo() {
            let dir = tempfile::tempdir().unwrap();
            init_repo(dir.path());
            std::fs::write(dir.path().join("file.txt"), "hello").unwrap();
            commit_all(dir.path(), "initial");

            let status = run_git_status(dir.path().to_str().unwrap()).unwrap();
            assert_eq!(status.branch, "main");
            assert_eq!(status.dirty, false);
            assert_eq!(status.has_upstream, false);
        }

        #[test]
        fn run_git_status_reports_dirty_for_an_uncommitted_change() {
            let dir = tempfile::tempdir().unwrap();
            init_repo(dir.path());
            std::fs::write(dir.path().join("file.txt"), "hello").unwrap();
            commit_all(dir.path(), "initial");

            std::fs::write(dir.path().join("file.txt"), "changed").unwrap();

            let status = run_git_status(dir.path().to_str().unwrap()).unwrap();
            assert_eq!(status.dirty, true);
        }

        #[test]
        fn run_git_status_reports_dirty_for_an_untracked_file() {
            let dir = tempfile::tempdir().unwrap();
            init_repo(dir.path());
            std::fs::write(dir.path().join("file.txt"), "hello").unwrap();
            commit_all(dir.path(), "initial");

            std::fs::write(dir.path().join("new-file.txt"), "new").unwrap();

            let status = run_git_status(dir.path().to_str().unwrap()).unwrap();
            assert_eq!(status.dirty, true);
        }

        #[test]
        fn run_git_status_includes_the_repo_root_in_its_result() {
            let dir = tempfile::tempdir().unwrap();
            init_repo(dir.path());
            std::fs::write(dir.path().join("file.txt"), "hello").unwrap();
            commit_all(dir.path(), "initial");

            let repo_root = dir.path().to_str().unwrap();
            let status = run_git_status(repo_root).unwrap();
            assert_eq!(status.repo_root, repo_root);
        }

        #[test]
        fn run_git_status_reports_ahead_count_against_a_local_upstream() {
            let remote_dir = tempfile::tempdir().unwrap();
            Command::new("git").args(["init", "-q", "--bare"]).current_dir(remote_dir.path()).status().unwrap();

            let dir = tempfile::tempdir().unwrap();
            init_repo(dir.path());
            std::fs::write(dir.path().join("file.txt"), "hello").unwrap();
            commit_all(dir.path(), "initial");
            Command::new("git")
                .args(["remote", "add", "origin", remote_dir.path().to_str().unwrap()])
                .current_dir(dir.path())
                .status()
                .unwrap();
            Command::new("git")
                .args(["push", "-q", "-u", "origin", "main"])
                .current_dir(dir.path())
                .status()
                .unwrap();

            // A commit made locally, never pushed, is one commit ahead of
            // the already-configured upstream tracking branch -- checked
            // purely against the local copy of origin/main (from the push
            // above), no live network fetch involved, matching this
            // milestone's own "never fetches" constraint.
            std::fs::write(dir.path().join("file2.txt"), "more").unwrap();
            commit_all(dir.path(), "second");

            let status = run_git_status(dir.path().to_str().unwrap()).unwrap();
            assert_eq!(status.has_upstream, true);
            assert_eq!(status.ahead, 1);
            assert_eq!(status.behind, 0);
        }

        #[test]
        fn run_git_status_returns_none_for_a_directory_that_is_not_a_repo() {
            let dir = tempfile::tempdir().unwrap();
            assert_eq!(run_git_status(dir.path().to_str().unwrap()), None);
        }
    }
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin && source "$HOME/.cargo/env"; cargo test -p gavin-daemon git_status::`
Expected: FAIL to compile — `resolve_repo_root`/`run_git_status` don't exist
yet.

- [ ] **Step 4: Implement `resolve_repo_root` and `run_git_status`**

In `crates/daemon/src/git_status.rs`, add these at the top of the file,
before `ParsedGitStatus`:

```rust
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Hard cap on how long a single `git status` subprocess is allowed to
/// run before this scanner gives up on it and moves on -- an unusual repo
/// hook, an enormous repo, or a genuinely hung process must never block a
/// repo root's poller (and by extension, every session mapped to it)
/// indefinitely.
const GIT_STATUS_TIMEOUT: Duration = Duration::from_secs(10);
```

Then, after `parse_porcelain_v2` and before `#[cfg(test)] mod tests`, add:

```rust
/// Resolves the canonical git repository root containing `cwd`, or `None`
/// if `cwd` is not inside any git repository -- or if `git` itself can't
/// even be run at all, which is treated identically (this milestone's own
/// silent-degradation convention: no status, no user-facing error, no
/// distinction made between "definitely not a repo" and "couldn't check").
pub fn resolve_repo_root(cwd: &str) -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel", "--path-format=absolute"])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let root = String::from_utf8(output.stdout).ok()?;
    let root = root.trim();
    if root.is_empty() {
        return None;
    }
    Some(root.to_string())
}

/// Runs `git status --porcelain=v2 --branch` in `repo_root`, parses the
/// result, and returns it -- or `None` if git fails to spawn, exits
/// non-zero, times out, or produces output `parse_porcelain_v2` can't
/// make sense of. Never panics; every failure mode degrades to "no status
/// available."
pub fn run_git_status(repo_root: &str) -> Option<protocol::GitStatus> {
    let mut child = Command::new("git")
        .args(["status", "--porcelain=v2", "--branch"])
        .current_dir(repo_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    // Read stdout on a separate thread, concurrently with waiting below --
    // not after. `git status` can write more output than the OS pipe
    // buffer holds (a large change set); if nothing is draining that pipe
    // while this function is busy polling `try_wait()`, the child blocks
    // on its own `write()` call and this function blocks waiting for it
    // to exit -- a classic, well-documented `std::process` deadlock (the
    // same reason `Child::wait_with_output` exists for the no-timeout
    // case; a timeout loop can't use it directly).
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut output = String::new();
        let _ = stdout.read_to_string(&mut output);
        let _ = tx.send(output);
    });

    let deadline = Instant::now() + GIT_STATUS_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    };
    if !status.success() {
        return None;
    }

    let output = rx.recv_timeout(Duration::from_secs(1)).ok()?;
    let parsed = parse_porcelain_v2(&output)?;
    Some(protocol::GitStatus {
        repo_root: repo_root.to_string(),
        branch: parsed.branch,
        dirty: parsed.dirty,
        ahead: parsed.ahead,
        behind: parsed.behind,
        has_upstream: parsed.has_upstream,
    })
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin && source "$HOME/.cargo/env"; cargo test -p gavin-daemon git_status::`
Expected: PASS — 19 tests (10 from Task 2 + 9 new).

- [ ] **Step 6: Verify the whole workspace still builds and tests pass**

Run: `cargo build && cargo test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/daemon/src/git_status.rs
git commit -m "feat(daemon): resolve repo roots and run git status with a timeout"
```

---

### Task 4: Wire the shared per-repo-root poller into `SessionManager`

**Files:**
- Modify: `crates/daemon/src/server.rs`

**Interfaces:**
- Consumes: `resolve_repo_root`, `run_git_status` (Task 3); `protocol::GitStatus`, `Response::GitStatusChanged` (Task 1); the existing `StatusEvent::Idle` arm in `spawn_pump` (from the session-status milestone).
- Produces: a new private `RepoPoller`/`RepoPollerInner` pair, new private `SessionManager` fields `repo_pollers`/`session_repo_root`, a new private `update_session_repo_mapping` function -- Task 5 (Attach baseline) calls this same function.

This is the largest and most concurrency-sensitive task in this plan --
comparable to (and building directly alongside) the session-status
milestone's own heuristic-timer task, which needed one real concurrency fix
round even with careful design. Read this task's full brief before starting;
do not split it further -- the poller's lifecycle (spawn/teardown), its three
trigger sources, and the session-to-repo-root mapping bookkeeping are too
tightly coupled to review or test in isolation from each other.

**A structural note on why the design looks the way it does, worth
understanding before touching this code:** every trigger source (filesystem
watch callback, timer thread, OSC-133-reactive hook) ultimately wants to do
the exact same thing -- "run `run_git_status` again for this repo root, and
if a client is attached to any mapped session, tell it." Unlike the
session-status milestone's `HeuristicState` (where two threads could reach
*opposite* conclusions -- Working vs. Idle -- from stale reads of each
other's state, which was a real bug that needed fixing), every trigger here
converges on the *same* action with no opposing outcome to race against.
The one thing that still needs guarding is redundant concurrent `git status`
subprocesses for the same repo root when triggers fire close together --
handled by a single `checking` flag that lets extra triggers no-op, relying
on the fact that this is a best-effort, eventually-fresh indicator by
design (the spec's own "never fetches" non-goal already embraces exactly
this kind of staleness tolerance) and the 3-minute backstop timer guarantees
eventual freshness regardless of any one skipped trigger.

- [ ] **Step 1: Add the new state types**

In `crates/daemon/src/server.rs`, find the top-of-file imports:

```rust
use protocol::{read_message, write_message, Request, Response, SessionSummary};
use crate::osc::OscCwdScanner;
use crate::pty::PtySession;
use crate::registry::{Registry, SessionRecord, SessionStatus};
use crate::status::{StatusEvent, StatusScanner, HEURISTIC_QUIET_PERIOD};
use std::collections::{HashMap, VecDeque};
use std::io::{BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;
```

Replace with:

```rust
use protocol::{read_message, write_message, GitStatus, Request, Response, SessionSummary};
use crate::osc::OscCwdScanner;
use crate::pty::PtySession;
use crate::registry::{Registry, SessionRecord, SessionStatus};
use crate::status::{StatusEvent, StatusScanner, HEURISTIC_QUIET_PERIOD};
use notify_debouncer_mini::Debouncer;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;
```

Find the `HeuristicState`/`HeuristicInner` struct definitions (right after
the `HEURISTIC_POLL_INTERVAL` constant) and add these new types immediately
after `HeuristicInner`'s closing brace (before `persist_and_emit_status`):

```rust
/// How often a repo root's poller re-checks even with no filesystem event
/// and no OSC-133-idle hook firing -- a pure safety net, deliberately
/// sparse. This project's own design history has a cautionary example of
/// getting this wrong: cmux (this project's stated inspiration) originally
/// polled `git status` on a tight ~5-second timer, which touches
/// `.git/index.lock` on every single check and broke other tools watching
/// the same repo (manaflow-ai/cmux#2722) and interfered with users' own
/// concurrent git commands (#4779). At 3 minutes, this backstop carries
/// essentially none of that risk -- the filesystem watch and the
/// OSC-133-idle hook are what actually keep things fresh in practice.
const GIT_STATUS_BACKSTOP_INTERVAL: Duration = Duration::from_secs(180);

/// How long the filesystem watch waits for a burst of related writes (a
/// single git operation, or a single file save, both often touch several
/// paths in quick succession) to settle before firing one recheck, rather
/// than one recheck per individual write event.
const GIT_STATUS_DEBOUNCE: Duration = Duration::from_millis(500);

/// One shared poller per unique repo root -- not per session. The first
/// session that resolves to a given repo root causes one of these to be
/// created (see `register_session_with_repo`); the last session mapped to
/// it going away tears it down.
struct RepoPoller {
    /// True while a `git status` subprocess for this repo root is
    /// currently running. Lets a trigger that fires while a check is
    /// already in flight simply skip rather than piling up a second,
    /// redundant subprocess -- correctness doesn't require every trigger
    /// to actually run a check (see this task's own doc comment on why),
    /// and the backstop timer guarantees eventual freshness regardless.
    checking: AtomicBool,
    /// The session ids currently mapped to this repo root, and the most
    /// recently observed status -- read and written together whenever a
    /// check completes, so both live behind one lock.
    inner: Mutex<RepoPollerInner>,
    /// Kept alive for as long as this poller exists; dropping it
    /// unregisters the filesystem watch. `None` only in the brief window
    /// during poller construction before the watch is set up (or if
    /// setting it up failed -- watch failure degrades to "no filesystem
    /// trigger for this repo root," not a hard error, since the
    /// OSC-133-idle hook and the backstop timer still work either way).
    debouncer: Mutex<Option<Debouncer<notify::RecommendedWatcher>>>,
}

struct RepoPollerInner {
    mapped_sessions: HashSet<String>,
    last_status: Option<GitStatus>,
}
```

- [ ] **Step 2: Add the new `SessionManager` fields**

Find:

```rust
pub struct SessionManager {
    registry: Mutex<Registry>,
    sessions: Mutex<HashMap<String, PtySession>>,
    attached_writers: Mutex<HashMap<String, Arc<Mutex<UnixStream>>>>,
    output_buffers: Mutex<HashMap<String, VecDeque<u8>>>,
}

impl SessionManager {
    pub fn new(registry: Registry) -> Self {
        Self {
            registry: Mutex::new(registry),
            sessions: Mutex::new(HashMap::new()),
            attached_writers: Mutex::new(HashMap::new()),
            output_buffers: Mutex::new(HashMap::new()),
        }
    }
```

Replace with:

```rust
pub struct SessionManager {
    registry: Mutex<Registry>,
    sessions: Mutex<HashMap<String, PtySession>>,
    attached_writers: Mutex<HashMap<String, Arc<Mutex<UnixStream>>>>,
    output_buffers: Mutex<HashMap<String, VecDeque<u8>>>,
    /// The daemon's first genuinely *shared* (not per-session) state:
    /// one entry per unique repo root any live session is currently
    /// mapped to. Not persisted -- see this plan's Global Constraints.
    repo_pollers: Mutex<HashMap<String, Arc<RepoPoller>>>,
    /// Each session's current repo root, if any -- the reverse lookup
    /// `update_session_repo_mapping` needs to know what to unregister a
    /// session from when its cwd changes again (or it exits).
    session_repo_root: Mutex<HashMap<String, String>>,
}

impl SessionManager {
    pub fn new(registry: Registry) -> Self {
        Self {
            registry: Mutex::new(registry),
            sessions: Mutex::new(HashMap::new()),
            attached_writers: Mutex::new(HashMap::new()),
            output_buffers: Mutex::new(HashMap::new()),
            repo_pollers: Mutex::new(HashMap::new()),
            session_repo_root: Mutex::new(HashMap::new()),
        }
    }
```

- [ ] **Step 3: Add the mapping and poller-lifecycle functions**

Immediately after `spawn_heuristic_idle_timer`'s closing brace (before
`pub struct SessionManager`), add:

```rust
/// Called whenever a session's cwd is newly known or changes: resolves
/// the repo root for the new cwd and updates this session's mapping,
/// unregistering it from its previous root (if any -- tearing that
/// root's poller down if this was the last session mapped to it) and
/// registering it with the new one (spawning a poller if this is the
/// first session ever mapped to that root). A cwd that resolves to the
/// same root as before is a no-op -- the common case, since most PTY
/// output containing a cwd report doesn't actually change which repo the
/// session is in.
///
/// Runs `resolve_repo_root` synchronously (a cheap `git rev-parse` call,
/// tolerated inline the same way the existing synchronous SQLite
/// `update_cwd` write already is in this same loop) -- but never runs
/// `run_git_status` itself inline; see `register_session_with_repo`.
fn update_session_repo_mapping(manager: &Arc<SessionManager>, id: &str, cwd: &str) {
    let new_root = crate::git_status::resolve_repo_root(cwd);

    let old_root = {
        let mut map = manager.session_repo_root.lock().unwrap();
        let old = map.get(id).cloned();
        if old == new_root {
            return;
        }
        match &new_root {
            Some(root) => map.insert(id.to_string(), root.clone()),
            None => map.remove(id),
        };
        old
    };

    if let Some(old) = old_root {
        unregister_session_from_repo(manager, id, &old);
    }
    if let Some(new) = new_root {
        register_session_with_repo(manager, id, &new);
    }
}

/// Registers `id` as mapped to `repo_root`, spawning a new poller for
/// that root first if none exists yet. The poller's own setup (the
/// filesystem watch, the backstop timer, and its first check) all happen
/// on a dedicated background thread -- never inline here -- so a
/// session's first `cd` into a brand-new repo can never block whatever
/// caller triggered this (the `spawn_pump` PTY-reading loop, or
/// `attach()`'s baseline logic in Task 5) on a `git status` subprocess.
fn register_session_with_repo(manager: &Arc<SessionManager>, id: &str, repo_root: &str) {
    let mut pollers = manager.repo_pollers.lock().unwrap();
    if !pollers.contains_key(repo_root) {
        let poller = Arc::new(RepoPoller {
            checking: AtomicBool::new(false),
            inner: Mutex::new(RepoPollerInner { mapped_sessions: HashSet::new(), last_status: None }),
            debouncer: Mutex::new(None),
        });
        pollers.insert(repo_root.to_string(), Arc::clone(&poller));
        let manager = Arc::clone(manager);
        let repo_root = repo_root.to_string();
        std::thread::spawn(move || spawn_repo_poller(&manager, repo_root, poller));
    }
    pollers.get(repo_root).unwrap().inner.lock().unwrap().mapped_sessions.insert(id.to_string());
}

/// Unregisters `id` from `repo_root`'s mapped-sessions set, tearing the
/// poller down entirely (dropping its `Arc`, which drops its debouncer
/// and therefore unregisters the filesystem watch) if that was the last
/// session mapped to it.
fn unregister_session_from_repo(manager: &Arc<SessionManager>, id: &str, repo_root: &str) {
    let mut pollers = manager.repo_pollers.lock().unwrap();
    let Some(poller) = pollers.get(repo_root) else { return };
    let now_empty = {
        let mut inner = poller.inner.lock().unwrap();
        inner.mapped_sessions.remove(id);
        inner.mapped_sessions.is_empty()
    };
    if now_empty {
        pollers.remove(repo_root);
    }
}

/// Removes `id` from whatever repo root it was mapped to, if any --
/// called from `spawn_pump`'s teardown when a session exits, mirroring
/// how `attached_writers`/`heuristic` are also cleaned up there.
fn unregister_session_repo_mapping(manager: &Arc<SessionManager>, id: &str) {
    let old_root = manager.session_repo_root.lock().unwrap().remove(id);
    if let Some(root) = old_root {
        unregister_session_from_repo(manager, id, &root);
    }
}

/// Sets up a newly-created repo root's poller: the filesystem watch, the
/// backstop timer thread, and one immediate check so a fresh poller
/// doesn't wait for either to produce its first result. Always runs on
/// its own dedicated thread (spawned by `register_session_with_repo`),
/// never inline on a caller's thread.
fn spawn_repo_poller(manager: &Arc<SessionManager>, repo_root: String, poller: Arc<RepoPoller>) {
    setup_filesystem_watch(manager, &repo_root, &poller);

    {
        let manager = Arc::clone(manager);
        let repo_root = repo_root.clone();
        let poller = Arc::clone(&poller);
        std::thread::spawn(move || loop {
            std::thread::sleep(GIT_STATUS_BACKSTOP_INTERVAL);
            if !manager.repo_pollers.lock().unwrap().contains_key(&repo_root) {
                return; // this root's poller was torn down; stop looping
            }
            trigger_recheck(&manager, &repo_root, &poller);
        });
    }

    trigger_recheck(manager, &repo_root, &poller);
}

/// Sets up the filesystem-watch trigger for one repo root: git's own
/// internal state files (HEAD, index, refs -- covers commits, checkouts,
/// and staging), plus the working tree itself (covers plain file
/// edits/new files, which touch none of those three -- the single most
/// common way a repo becomes dirty). Watching `.git/` broadly (via a
/// naive single recursive watch on the whole repo root) is deliberately
/// avoided: `.git/objects/` alone can hold many thousands of loose
/// object files in an active repo, and recursively watching all of them
/// wastes OS-level watch resources for no benefit (on Linux, this can
/// exhaust `inotify`'s system-wide watch-count limit for a large repo) --
/// so the working-tree watch enumerates `repo_root`'s existing top-level
/// entries once at setup time, skips `.git` specifically, and watches
/// each remaining entry recursively, plus `repo_root` itself
/// non-recursively (to notice new/deleted top-level entries). A known,
/// accepted limitation: a file created deep inside a *brand-new*
/// top-level directory (created after this poller started) won't be
/// watched until something else triggers a fresh check for this root --
/// the 3-minute backstop timer always eventually does.
fn setup_filesystem_watch(manager: &Arc<SessionManager>, repo_root: &str, poller: &Arc<RepoPoller>) {
    let manager = Arc::clone(manager);
    let repo_root_owned = repo_root.to_string();
    let poller_for_callback = Arc::clone(poller);
    let debounce_result = notify_debouncer_mini::new_debouncer(
        GIT_STATUS_DEBOUNCE,
        move |res: notify_debouncer_mini::DebounceEventResult| {
            if res.is_ok() {
                trigger_recheck(&manager, &repo_root_owned, &poller_for_callback);
            }
        },
    );
    let Ok(mut debouncer) = debounce_result else {
        // Watch setup failed entirely (e.g. a permissions issue) -- the
        // OSC-133-idle hook and the backstop timer still work, so this
        // repo root degrades to "less responsive," not "broken."
        return;
    };

    let git_dir = std::path::Path::new(repo_root).join(".git");
    let _ = debouncer.watcher().watch(&git_dir.join("HEAD"), notify::RecursiveMode::NonRecursive);
    let _ = debouncer.watcher().watch(&git_dir.join("index"), notify::RecursiveMode::NonRecursive);
    // refs is a directory tree (refs/heads/<branch>, etc.) -- a new
    // branch or commit can create files nested under it, so this one
    // specifically needs Recursive, unlike HEAD/index which are plain
    // files.
    let _ = debouncer.watcher().watch(&git_dir.join("refs"), notify::RecursiveMode::Recursive);

    // repo_root itself, non-recursively, to notice new/deleted top-level
    // entries (including a freshly re-created .git, in the rare case
    // this directory stops being a repo entirely).
    let _ = debouncer.watcher().watch(std::path::Path::new(repo_root), notify::RecursiveMode::NonRecursive);
    if let Ok(entries) = std::fs::read_dir(repo_root) {
        for entry in entries.flatten() {
            if entry.file_name() == ".git" {
                continue;
            }
            let _ = debouncer.watcher().watch(&entry.path(), notify::RecursiveMode::Recursive);
        }
    }

    *poller.debouncer.lock().unwrap() = Some(debouncer);
}

/// Shared by all three trigger sources (filesystem watch, backstop timer,
/// and the reactive OSC-133-idle hook in `spawn_pump`). Runs at most one
/// `git status` at a time per repo root (via `checking`), caches the
/// result, and emits `Response::GitStatusChanged` to every session
/// currently mapped to this root that has an attached writer.
fn trigger_recheck(manager: &Arc<SessionManager>, repo_root: &str, poller: &Arc<RepoPoller>) {
    if poller.checking.swap(true, Ordering::SeqCst) {
        return;
    }
    let status = crate::git_status::run_git_status(repo_root);
    poller.checking.store(false, Ordering::SeqCst);

    let mapped: Vec<String> = {
        let mut inner = poller.inner.lock().unwrap();
        inner.last_status = status.clone();
        inner.mapped_sessions.iter().cloned().collect()
    };
    for id in mapped {
        let target = manager.attached_writers.lock().unwrap().get(&id).cloned();
        if let Some(w) = target {
            let _ = write_message(
                &mut *w.lock().unwrap(),
                &Response::GitStatusChanged { id: id.clone(), status: status.clone() },
            );
        }
    }
}

/// Piggybacks on the existing OSC-133 idle-marker detection in
/// `spawn_pump`: a fresh shell prompt is a natural moment to recheck
/// git status, at zero additional detection cost (the marker is already
/// being scanned for session-status purposes). Dispatched to its own
/// thread -- never run inline on the pump thread -- since `git status`
/// can take up to `GIT_STATUS_TIMEOUT` in the worst case, and this must
/// never stall PTY output relay. No-ops if this session isn't currently
/// mapped to any repo root.
fn trigger_recheck_for_session(manager: &Arc<SessionManager>, id: &str) {
    let manager = Arc::clone(manager);
    let id = id.to_string();
    std::thread::spawn(move || {
        let root = manager.session_repo_root.lock().unwrap().get(&id).cloned();
        let Some(root) = root else { return };
        let poller = manager.repo_pollers.lock().unwrap().get(&root).cloned();
        let Some(poller) = poller else { return };
        trigger_recheck(&manager, &root, &poller);
    });
}
```

- [ ] **Step 4: Wire `update_session_repo_mapping` into the cwd-change loop**

Inside `spawn_pump`, find:

```rust
                        for cwd in osc_scanner.feed(&buf[..n]) {
                            if let Err(e) = manager.registry.lock().unwrap().update_cwd(&id, &cwd) {
                                eprintln!("failed to persist cwd for session {id}: {e}");
                            }
                            let target = manager.attached_writers.lock().unwrap().get(&id).cloned();
                            if let Some(w) = target {
                                let _ = write_message(
                                    &mut *w.lock().unwrap(),
                                    &Response::CwdChanged { id: id.clone(), cwd },
                                );
                            }
                        }
```

Replace with:

```rust
                        for cwd in osc_scanner.feed(&buf[..n]) {
                            if let Err(e) = manager.registry.lock().unwrap().update_cwd(&id, &cwd) {
                                eprintln!("failed to persist cwd for session {id}: {e}");
                            }
                            let target = manager.attached_writers.lock().unwrap().get(&id).cloned();
                            if let Some(w) = target {
                                let _ = write_message(
                                    &mut *w.lock().unwrap(),
                                    &Response::CwdChanged { id: id.clone(), cwd: cwd.clone() },
                                );
                            }
                            update_session_repo_mapping(&manager, &id, &cwd);
                        }
```

- [ ] **Step 5: Wire the OSC-133-idle reactive trigger**

Find the `StatusEvent::Idle` arm inside `spawn_pump`:

```rust
                                StatusEvent::Idle => {
                                    heuristic.seen_osc133.store(true, Ordering::SeqCst);
                                    persist_and_emit_status(&manager, &id, SessionStatus::Idle);
                                }
```

Replace with:

```rust
                                StatusEvent::Idle => {
                                    heuristic.seen_osc133.store(true, Ordering::SeqCst);
                                    persist_and_emit_status(&manager, &id, SessionStatus::Idle);
                                    trigger_recheck_for_session(&manager, &id);
                                }
```

- [ ] **Step 6: Wire session-exit cleanup**

Find the pump's teardown block:

```rust
            heuristic.inner.lock().unwrap().running = false;
            let exit_code = manager.exit_code_for(&id).ok().flatten().unwrap_or(-1);
```

Replace with:

```rust
            heuristic.inner.lock().unwrap().running = false;
            unregister_session_repo_mapping(&manager, &id);
            let exit_code = manager.exit_code_for(&id).ok().flatten().unwrap_or(-1);
```

- [ ] **Step 7: Add the integration tests**

In `crates/daemon/src/server.rs`'s existing `#[cfg(test)] mod tests` block,
add these tests immediately after the existing
`waiting_for_input_survives_a_full_quiet_period_in_heuristic_mode` test.
These need a real git repo, matching Task 3's own fixture pattern:

```rust
    fn init_test_repo(dir: &std::path::Path) {
        std::process::Command::new("git").args(["init", "-q"]).current_dir(dir).status().unwrap();
        std::process::Command::new("git").args(["config", "user.email", "test@example.com"]).current_dir(dir).status().unwrap();
        std::process::Command::new("git").args(["config", "user.name", "Test"]).current_dir(dir).status().unwrap();
        std::process::Command::new("git").args(["checkout", "-q", "-b", "main"]).current_dir(dir).status().unwrap();
        std::fs::write(dir.join("file.txt"), "hello").unwrap();
        std::process::Command::new("git").args(["add", "-A"]).current_dir(dir).status().unwrap();
        std::process::Command::new("git").args(["commit", "-q", "-m", "initial"]).current_dir(dir).status().unwrap();
    }

    #[test]
    fn relays_git_status_changed_when_a_session_cwd_reports_a_git_repo() {
        let repo_dir = tempfile::tempdir().unwrap();
        init_test_repo(repo_dir.path());
        let repo_path = repo_dir.path().to_str().unwrap().to_string();

        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        let mut stream2 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        write_message(
            &mut stream2,
            &Request::WriteInput {
                id: id.clone(),
                data: format!("printf '\\033]7;file://host{repo_path}\\007'\n"),
            },
        )
        .unwrap();

        let mut reader = BufReader::new(stream2.try_clone().unwrap());
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut found = false;
        while std::time::Instant::now() < deadline {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::GitStatusChanged { id: rid, status: Some(status) } = resp {
                if rid == id && status.branch == "main" {
                    found = true;
                    break;
                }
            }
        }
        assert!(found, "never saw the expected GitStatusChanged for the session's OSC7-reported repo cwd");
    }

    // Deliberately not testing "exactly one poller was spawned" directly:
    // that would need `start_test_server()` (shared by every test in this
    // file) to also return a handle to the `SessionManager` it constructs,
    // which it currently doesn't -- a broader change to shared test
    // infrastructure than this one property justifies. The dedup-by-repo-
    // root mechanism is an internal efficiency optimization (avoiding
    // redundant `git status` subprocesses), not a user-visible correctness
    // requirement -- even if it were somehow broken, both sessions below
    // would still receive correct status independently, just less
    // efficiently. The test below verifies the behavior that actually
    // matters: two sessions mapped to the same repo both receive
    // consistent, correct status for it.
    #[test]
    fn two_sessions_in_the_same_repo_both_receive_git_status_changed() {
        let repo_dir = tempfile::tempdir().unwrap();
        init_test_repo(repo_dir.path());
        let repo_path = repo_dir.path().to_str().unwrap().to_string();

        let (socket_path, _dir) = start_test_server();

        let make_session = || {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };
        let id_a = make_session();
        let id_b = make_session();

        let attach_and_report_cwd = |id: &str| {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            write_message(&mut stream, &Request::Attach { id: id.to_string() }).unwrap();
            write_message(
                &mut stream,
                &Request::WriteInput {
                    id: id.to_string(),
                    data: format!("printf '\\033]7;file://host{repo_path}\\007'\n"),
                },
            )
            .unwrap();
            stream
        };
        let mut stream_a = attach_and_report_cwd(&id_a);
        let mut stream_b = attach_and_report_cwd(&id_b);

        let wait_for_git_status = |stream: &mut UnixStream, expected_id: &str| {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while std::time::Instant::now() < deadline {
                let resp: Response = read_message(&mut reader).unwrap().unwrap();
                if let Response::GitStatusChanged { id: rid, status: Some(status) } = resp {
                    if rid == expected_id {
                        return status;
                    }
                }
            }
            panic!("never saw GitStatusChanged for {expected_id}");
        };
        let status_a = wait_for_git_status(&mut stream_a, &id_a);
        let status_b = wait_for_git_status(&mut stream_b, &id_b);
        assert_eq!(status_a.repo_root, status_b.repo_root);
        assert_eq!(status_a.branch, "main");
        assert_eq!(status_b.branch, "main");
    }

    #[test]
    fn a_session_outside_any_git_repo_never_receives_git_status_changed() {
        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        let mut stream2 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        // /tmp itself is essentially never a git repo -- no OSC7 report
        // needed, the session's own launch cwd already qualifies.
        write_message(&mut stream2, &Request::WriteInput { id: id.clone(), data: "echo no_repo_here\n".to_string() }).unwrap();

        let mut reader = BufReader::new(stream2.try_clone().unwrap());
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        reader.get_ref().set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        let mut saw_output = false;
        loop {
            if std::time::Instant::now() >= deadline {
                break;
            }
            match read_message::<_, Response>(&mut reader) {
                Ok(Some(Response::GitStatusChanged { id: rid, .. })) if rid == id => {
                    panic!("session outside any git repo received a GitStatusChanged");
                }
                Ok(Some(Response::Output { data, .. })) if data.contains("no_repo_here") => {
                    saw_output = true;
                    break;
                }
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => continue,
            }
        }
        assert!(saw_output, "never even saw the echoed output -- test setup itself may be broken");
    }
```

- [ ] **Step 8: Run the tests**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin && source "$HOME/.cargo/env"; cargo test -p gavin-daemon`
Expected: PASS — all existing daemon tests plus the 3 new ones (the git-repo
tests may each take a few real seconds, matching this project's existing
timing-test style).

- [ ] **Step 9: Verify the whole workspace still builds and tests pass**

Run: `cargo build && cargo test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add crates/daemon/src/server.rs
git commit -m "feat(daemon): wire the shared per-repo-root git status poller into spawn_pump"
```

---

### Task 5: Baseline `GitStatusChanged` on `Attach`

**Files:**
- Modify: `crates/daemon/src/server.rs`

**Interfaces:**
- Consumes: `update_session_repo_mapping` (Task 4).

Mirrors `CwdChanged`/`StatusChanged`'s own existing baseline-on-attach
precedent exactly, with one addition Task 4's own design note already
flagged: `attach()` must call `update_session_repo_mapping` too, not just
send a baseline from whatever's already cached -- a session that has never
emitted a single OSC 7 report (no shell integration for cwd tracking) would
otherwise never get *any* repo mapping established at all, since Task 4's
own wiring is purely reactive to *live* cwd changes.

- [ ] **Step 1: Extend `attach()`'s baseline block**

Find:

```rust
        let baseline_record = self.registry.lock().unwrap().get(id).ok().flatten();
        if let Some(record) = baseline_record {
            let _ = write_message(
                &mut *writer.lock().unwrap(),
                &Response::CwdChanged { id: id.to_string(), cwd: record.cwd },
            );
            // StatusChanged is never sent for Exited -- SessionExited
            // already covers session death, and the frontend's status
            // union has no "exited" member.
            if record.status != SessionStatus::Exited {
                let _ = write_message(
                    &mut *writer.lock().unwrap(),
                    &Response::StatusChanged { id: id.to_string(), status: record.status.as_str().to_string() },
                );
            }
        }
```

Replace with:

```rust
        let baseline_record = self.registry.lock().unwrap().get(id).ok().flatten();
        if let Some(record) = baseline_record {
            let _ = write_message(
                &mut *writer.lock().unwrap(),
                &Response::CwdChanged { id: id.to_string(), cwd: record.cwd.clone() },
            );
            // StatusChanged is never sent for Exited -- SessionExited
            // already covers session death, and the frontend's status
            // union has no "exited" member.
            if record.status != SessionStatus::Exited {
                let _ = write_message(
                    &mut *writer.lock().unwrap(),
                    &Response::StatusChanged { id: id.to_string(), status: record.status.as_str().to_string() },
                );
            }
            // Establishes this session's repo mapping even if it never
            // emits a single OSC 7 cwd report (Task 4's own wiring is
            // purely reactive to *live* changes) -- runs synchronously
            // (cheap `git rev-parse`, same tolerance as the existing
            // registry read just above), but never runs `git status`
            // itself inline; see register_session_with_repo's own note.
            update_session_repo_mapping(self, id, &record.cwd);
            let cached_status = {
                let repo_root = self.session_repo_root.lock().unwrap().get(id).cloned();
                repo_root.and_then(|root| {
                    self.repo_pollers
                        .lock()
                        .unwrap()
                        .get(&root)
                        .and_then(|poller| poller.inner.lock().unwrap().last_status.clone())
                })
            };
            if let Some(status) = cached_status {
                let _ = write_message(
                    &mut *writer.lock().unwrap(),
                    &Response::GitStatusChanged { id: id.to_string(), status: Some(status) },
                );
            }
        }
```

(No baseline is sent when `cached_status` is `None` -- either the session
isn't in a repo at all, or its poller was *just* spawned by
`update_session_repo_mapping` above and hasn't completed its first check
yet. In the latter case the first live `GitStatusChanged` arrives shortly
after, once that poller's initial `trigger_recheck` completes on its own
background thread.)

- [ ] **Step 2: Add the test**

In the test module, add this immediately after Task 4's own
`a_session_outside_any_git_repo_never_receives_git_status_changed` test:

```rust
    #[test]
    fn attach_sends_a_baseline_git_status_changed_when_a_cached_status_already_exists() {
        let repo_dir = tempfile::tempdir().unwrap();
        init_test_repo(repo_dir.path());
        let repo_path = repo_dir.path().to_str().unwrap().to_string();

        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: repo_path.clone(),
                    cwd: repo_path.clone(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        // First attach: establishes the repo mapping via attach()'s own
        // update_session_repo_mapping call, and waits for the poller's
        // very first check (spawned in the background) to actually land
        // before detaching, so the SECOND attach below has something
        // real to find already cached.
        {
            let mut stream1 = UnixStream::connect(&socket_path).unwrap();
            write_message(&mut stream1, &Request::Attach { id: id.clone() }).unwrap();
            let mut reader = BufReader::new(stream1.try_clone().unwrap());
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            let mut found = false;
            while std::time::Instant::now() < deadline {
                let resp: Response = read_message(&mut reader).unwrap().unwrap();
                if let Response::GitStatusChanged { id: rid, status: Some(_) } = resp {
                    if rid == id {
                        found = true;
                        break;
                    }
                }
            }
            assert!(found, "first attach never produced a live GitStatusChanged to seed the cache");
        }

        // Second attach, a fresh connection: this is what actually
        // exercises the baseline path (a cache already populated by the
        // first attach above), not a fresh live check.
        let mut stream2 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        let mut reader2 = BufReader::new(stream2.try_clone().unwrap());

        let first: Response = read_message(&mut reader2).unwrap().unwrap();
        assert!(matches!(first, Response::CwdChanged { .. }), "expected CwdChanged first, got {first:?}");
        let second: Response = read_message(&mut reader2).unwrap().unwrap();
        assert!(matches!(second, Response::StatusChanged { .. }), "expected StatusChanged second, got {second:?}");
        let third: Response = read_message(&mut reader2).unwrap().unwrap();
        match third {
            Response::GitStatusChanged { id: rid, status: Some(status) } => {
                assert_eq!(rid, id);
                assert_eq!(status.branch, "main");
            }
            other => panic!("expected a baseline GitStatusChanged third, got {other:?}"),
        }
    }
```

- [ ] **Step 3: Run the tests**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin && source "$HOME/.cargo/env"; cargo test -p gavin-daemon`
Expected: PASS — all existing tests plus this new one.

- [ ] **Step 4: Verify the whole workspace still builds and tests pass**

Run: `cargo build && cargo test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/daemon/src/server.rs
git commit -m "feat(daemon): send a baseline GitStatusChanged on Attach when already cached"
```

---

### Task 6: Tauri app relay arm

**Files:**
- Modify: `app/src-tauri/src/session.rs`

**Interfaces:**
- Consumes: `Response::GitStatusChanged` (Task 1).
- Produces: a new Tauri event `"git-status-changed"`, payload `(id: String, status: Option<GitStatus>)`.

- [ ] **Step 1: Add the relay arm**

Find `bootstrap()`'s relay-loop `match resp { ... }` statement. Locate:

```rust
                Response::StatusChanged { id, status } => {
                    let _ = reader_app_handle.emit("session-status-changed", (id, status));
                }
```

Add a new arm immediately after it:

```rust
                Response::StatusChanged { id, status } => {
                    let _ = reader_app_handle.emit("session-status-changed", (id, status));
                }
                Response::GitStatusChanged { id, status } => {
                    let _ = reader_app_handle.emit("git-status-changed", (id, status));
                }
```

- [ ] **Step 2: Verify the whole workspace builds**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin && source "$HOME/.cargo/env"; cargo build`
Expected: clean build. (This match statement already has a catch-all
`_ => {}` arm for other `Response` variants it doesn't relay -- confirm
your added arm sits alongside the other explicit arms, above any catch-all,
exactly like the existing `StatusChanged` arm does.)

- [ ] **Step 3: Run the tests**

Run: `cargo test`
Expected: PASS -- this change has no dedicated new test (it's a one-line
addition to an existing, already-tested relay pattern with no new branching
logic of its own to exercise; the daemon-side tests from Tasks 4-5 already
prove `Response::GitStatusChanged` is correctly produced and delivered over
the socket, which is the input this relay arm consumes).

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/src/session.rs
git commit -m "feat(app): relay Response::GitStatusChanged as the git-status-changed Tauri event"
```

---

## Not covered by this plan (deliberately, per the design spec)

- Any Svelte/TypeScript frontend work -- Part 2 (a separate, later plan)
  consumes the `"git-status-changed"` event this plan produces.
- `git fetch`, ever.
- PR status, listening ports, or any other richer per-session metadata.
- Any git *write* operation from within the app.
