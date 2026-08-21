# Orchestration Tab — SP3 "The agent surface" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The workspace agent can read the whole orchestration picture — rails, their checkouts, what each checkout has uncommitted, what is running, and which cards are still unplaced — reason about what may safely run in parallel, and write back a whole arrangement that appears in the open tab without a reload.

**Architecture:** Two MCP tools sit on root-addressed daemon requests, mirroring `GetBoardByRoot`. The read tool is composed in the MCP server from four daemon calls rather than one fat protocol response, which keeps the wire types honest and the tool payload shaped for an agent. A `SetOrchestration` from either entry point pushes `OrchestrationChanged` on the watching connection, exactly as `GavinTreeChanged` already does, so the tab updates live. A second embedded skill file teaches the rules, and a button hands the request to the already-running workspace agent.

**Tech Stack:** Rust (serde_json, anyhow, rusqlite) for protocol/daemon/MCP; Tauri 2 event forwarding; Svelte 5 + TypeScript for the app.

**Spec:** `docs/superpowers/specs/2026-08-21-orchestration-tab-design.md` — §2.3 (push), §8 (MCP tools), §9 (skill and button), and §5/O13 for the conflict rule the skill must state.

**Depends on:** SP1 (`2026-08-21-orchestration-rails-that-run.md`) complete and merged. SP2 (`2026-08-21-orchestration-conflicts-and-drag.md`) is **not** a prerequisite — this plan's payload is facts the store already holds — but the `declared` conflict kind only becomes visible once SP2's conflicts box exists.

## Global Constraints

- The MCP payload carries **facts, not gavin's computed conflict list** (spec §8.1). `detectConflicts` is TypeScript in the app; duplicating it in Rust would give two implementations of one rule, free to drift. The skill states the rule instead.
- **Separate worktrees are never a conflict** (spec O13). The skill must say this plainly, and must say that a stage's parallel steps share their rail's checkout with no step-level escape hatch.
- `SetOrchestration` pushes; **run-state writes do not** (spec §2.3) — they always originate in the app that already holds the state.
- Root-addressed requests resolve root → watcher → workspace and **require the workspace to be open in gavin**, erroring with `workspace not open in gavin`, exactly as `board_by_root` does.
- The daemon's `replace_plan` guards (SP1 Task 2) apply unchanged to the MCP path: a refused write must reach the agent as a tool error naming the running step.
- `dirtyPaths` is capped at **200 per worktree**, with `dirtyTruncated` telling the truth about it.
- The skill file is **gavin-managed and overwritten wholesale** on every setup run, like the existing one.
- The Reorganize button **never starts an agent** — disabled when none is running, matching `sendToMainAgent`.
- Test commands: Rust `cargo test -p protocol -p gavin-daemon -p gavin-mcp`; TS `cd app && npm test`; type check `cd app && npm run check`.
- Commit after every task.

---

### Task 0: Plan card on the board

**Files:**
- Create: `.gavin-root/plans/orchestration-agent-surface.md`

- [ ] **Step 1: Create the card**

```
gavin_create_plan(
  context_folder: ".gavin-root",
  file_name: "orchestration-agent-surface",
  title: "Orchestration tab — The agent surface (SP3 of 3)",
  status: "In Progress",
  priority: "high",
  kind: "plan",
  body: <the markdown below>
)
```

Body:

```markdown
# Orchestration tab — The agent surface (SP3 of 3)

Two MCP tools, the live push into the open tab, the gavin-orchestrate
skill, and the Reorganize button.

Spec: `docs/superpowers/specs/2026-08-21-orchestration-tab-design.md`
Plan: `docs/superpowers/plans/2026-08-21-orchestration-agent-surface.md`

## Steps

- [ ] GitDirtyPaths: capture helper, v2 path parser, request (+ tests)
- [ ] Root-addressed orchestration requests and the OrchestrationChanged push (+ tests)
- [ ] gavin_get_orchestration (+ tests)
- [ ] gavin_set_orchestration (+ tests)
- [ ] App: forward and apply the push
- [ ] The gavin-orchestrate skill and multi-skill setup
- [ ] The Reorganize with agent button
```

- [ ] **Step 2: Commit**

```bash
git add .gavin-root/plans/orchestration-agent-surface.md
git commit -m "docs(plan): orchestration SP3 card"
```

---

### Task 1: `GitDirtyPaths`

**Files:**
- Modify: `crates/daemon/src/git_status.rs`
- Modify: `crates/protocol/src/lib.rs`
- Modify: `crates/daemon/src/server.rs`

**Interfaces:**
- Produces: `git_status::run_git_capture(repo_root, args, timeout) → Option<String>`; `git_status::parse_dirty_paths(output, limit) → (Vec<String>, bool)`; `git_status::dirty_paths(repo_root, limit) → Option<(Vec<String>, bool)>`; `Request::GitDirtyPaths { cwd, limit }`; `Response::DirtyPaths { paths, truncated }`; `SessionManager::git_dirty_paths`.

- [ ] **Step 1: Write the failing parser tests**

Append to `crates/daemon/src/git_status.rs`'s `mod tests`:

```rust
    #[test]
    fn dirty_paths_reads_ordinary_staged_and_unstaged_entries() {
        let output = "# branch.oid abc\n# branch.head main\n\
            1 M. N... 100644 100644 100644 abc def src/foo.rs\n\
            1 .M N... 100644 100644 100644 abc def src/bar.rs\n";
        let (paths, truncated) = parse_dirty_paths(output, 10);
        assert_eq!(paths, vec!["src/foo.rs", "src/bar.rs"]);
        assert!(!truncated);
    }

    #[test]
    fn dirty_paths_takes_the_NEW_side_of_a_rename() {
        let output =
            "2 R. N... 100644 100644 100644 abc def R100 src/new.rs\tsrc/old.rs\n";
        assert_eq!(parse_dirty_paths(output, 10).0, vec!["src/new.rs"]);
    }

    #[test]
    fn dirty_paths_includes_untracked_and_unmerged_entries() {
        let output = "? new-file.txt\n\
            u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.rs\n";
        assert_eq!(
            parse_dirty_paths(output, 10).0,
            vec!["new-file.txt", "src/conflict.rs"]
        );
    }

    #[test]
    fn dirty_paths_skips_headers_and_ignored_entries() {
        let output = "# branch.oid abc\n# branch.head main\n! build/out.js\n";
        assert!(parse_dirty_paths(output, 10).0.is_empty());
    }

    #[test]
    fn dirty_paths_caps_at_the_limit_and_says_so() {
        let output = (0..5)
            .map(|i| format!("? file{i}.txt\n"))
            .collect::<String>();
        let (paths, truncated) = parse_dirty_paths(&output, 3);
        assert_eq!(paths.len(), 3);
        assert!(truncated);
    }

    #[test]
    fn dirty_paths_handles_a_path_containing_spaces() {
        let output = "1 M. N... 100644 100644 100644 abc def src/a file.rs\n";
        assert_eq!(parse_dirty_paths(output, 10).0, vec!["src/a file.rs"]);
    }
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cargo test -p gavin-daemon dirty_paths`
Expected: FAIL — `cannot find function 'parse_dirty_paths'`.

- [ ] **Step 3: Extract the capture helper**

In `crates/daemon/src/git_status.rs`, pull the subprocess half of `run_git_status` (lines ~109-153: spawn, drain stdout on its own thread, wait with a deadline) into a reusable helper, and make `run_git_status` call it. The thread is not an optimization — `git status` can outrun the OS pipe buffer, and polling `try_wait()` with nothing draining the pipe deadlocks.

```rust
/// Spawn git, drain stdout on its own thread, wait with a deadline.
/// None on spawn failure, non-zero exit, or timeout.
///
/// The draining thread is load-bearing: git can write more than the pipe
/// buffer holds, and a try_wait() loop with nothing reading blocks the
/// child on its own write() and this function on the child -- the
/// classic std::process deadlock that Child::wait_with_output exists to
/// avoid, and which a timeout loop cannot use directly.
fn run_git_capture(repo_root: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(repo_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut output = String::new();
        let _ = stdout.read_to_string(&mut output);
        let _ = tx.send(output);
    });

    let deadline = Instant::now() + timeout;
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
    rx.recv_timeout(Duration::from_secs(1)).ok()
}
```

`run_git_status` becomes:

```rust
pub fn run_git_status(repo_root: &str) -> Option<protocol::GitStatus> {
    let output = run_git_capture(
        repo_root,
        &["--no-optional-locks", "status", "--porcelain=v2", "--branch"],
        GIT_STATUS_TIMEOUT,
    )?;
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

- [ ] **Step 4: Add the path parser and the entry point**

Also in `git_status.rs`:

```rust
/// Every path with an uncommitted change, from porcelain=v2 output --
/// the SAME format run_git_status already uses, so this file reasons
/// about one git format rather than two.
///
/// Field layouts (v2, no -z):
///   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
///   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\t<origPath>
///   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
///   ? <path>
/// Renames report the NEW path: that is the file an agent would edit.
/// `!` (ignored) and `#` (header) lines are not changes.
///
/// Returns (paths, truncated). This is EVIDENCE for an agent, not a
/// correctness-critical read: a path containing a literal newline (which
/// git would quote here) is not worth a -z parser.
pub fn parse_dirty_paths(output: &str, limit: usize) -> (Vec<String>, bool) {
    let mut paths = Vec::new();
    let mut truncated = false;
    for line in output.lines() {
        let path = if let Some(rest) = line.strip_prefix("? ") {
            Some(rest)
        } else if line.starts_with("1 ") {
            line.splitn(9, ' ').nth(8)
        } else if line.starts_with("2 ") {
            line.splitn(10, ' ').nth(9).and_then(|p| p.split('\t').next())
        } else if line.starts_with("u ") {
            line.splitn(11, ' ').nth(10)
        } else {
            None
        };
        let Some(path) = path.filter(|p| !p.is_empty()) else { continue };
        if paths.len() >= limit {
            truncated = true;
            break;
        }
        paths.push(path.to_string());
    }
    (paths, truncated)
}

pub fn dirty_paths(repo_root: &str, limit: usize) -> Option<(Vec<String>, bool)> {
    let output = run_git_capture(
        repo_root,
        &["--no-optional-locks", "status", "--porcelain=v2", "--untracked-files=all"],
        GIT_STATUS_TIMEOUT,
    )?;
    Some(parse_dirty_paths(&output, limit))
}
```

- [ ] **Step 5: Add the request and route it**

In `crates/protocol/src/lib.rs`, in `Request` beside the other orchestration variants:

```rust
    /// Paths with uncommitted changes in `cwd`, capped at `limit` --
    /// evidence for the reorganize skill (spec §8.1), never used by the
    /// app's own conflict detection.
    GitDirtyPaths {
        cwd: String,
        limit: u32,
    },
```

and in `Response`:

```rust
    DirtyPaths { paths: Vec<String>, truncated: bool },
```

In `crates/daemon/src/server.rs`, beside the other orchestration arms in `handle_request`:

```rust
        Request::GitDirtyPaths { cwd, limit } => Ok(
            match crate::git_status::dirty_paths(&cwd, limit as usize) {
                Some((paths, truncated)) => Response::DirtyPaths { paths, truncated },
                // Not a repo, or git was too slow: empty evidence, not an
                // error -- one unreadable worktree must not fail the
                // whole gavin_get_orchestration payload.
                None => Response::DirtyPaths { paths: vec![], truncated: false },
            },
        ),
```

- [ ] **Step 6: Run the suite**

Run: `cargo test -p protocol -p gavin-daemon`
Expected: PASS, including the pre-existing `run_git_status` integration tests, which now exercise the extracted helper.

- [ ] **Step 7: Commit**

```bash
git add crates/daemon/src/git_status.rs crates/protocol/src/lib.rs crates/daemon/src/server.rs
git commit -m "feat(daemon): GitDirtyPaths, with the git capture helper extracted"
```

---

### Task 2: Root-addressed requests and the push

**Files:**
- Modify: `crates/protocol/src/lib.rs`
- Modify: `crates/daemon/src/server.rs`

**Interfaces:**
- Consumes: SP1's `OrchestrationStore`, `SessionManager::get_orchestration/set_orchestration`.
- Produces: `Request::GetOrchestrationByRoot`, `Request::SetOrchestrationByRoot`; `Response::OrchestrationChanged { workspace_id, orchestration }`; `SessionManager::orchestration_by_root`, `set_orchestration_by_root`, and a private `push_orchestration`.

- [ ] **Step 1: Write the failing tests**

Append to `crates/daemon/src/server.rs`'s `mod tests`. `test_manager` is SP1 Task 3's helper.

```rust
    fn one_rail(step_id: &str) -> Vec<protocol::Rail> {
        vec![protocol::Rail {
            id: "r1".into(),
            name: "backend".into(),
            position: 0,
            worktree_path: None,
            page_id: None,
            stages: vec![protocol::Stage {
                id: "s1".into(),
                position: 0,
                steps: vec![protocol::Step {
                    id: step_id.into(),
                    position: 0,
                    card_path: "/x/a.md".into(),
                }],
            }],
        }]
    }

    #[test]
    fn orchestration_by_root_errors_when_the_workspace_is_not_open() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        let resp = handle_request(
            &manager,
            Request::GetOrchestrationByRoot { root_path: "/nowhere".into() },
        );
        match resp {
            Response::Error { message } => assert!(message.contains("not open in gavin"), "{message}"),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn set_orchestration_by_root_writes_the_watched_workspaces_plan() {
        let (socket_path, _dir) = start_test_server();
        let ws_dir = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(ws_dir.path(), "WS").unwrap();
        let root = ws_dir.path().to_string_lossy().to_string();
        // A watching connection is what makes the root resolvable.
        let mut watcher = connect(&socket_path);
        write_message(
            &mut watcher,
            &Request::WatchGavinRoot { workspace_id: "ws-1".into(), root_path: root.clone() },
        )
        .unwrap();
        let mut reader = BufReader::new(watcher.try_clone().unwrap());
        let first: Option<Response> = protocol::read_message(&mut reader).unwrap();
        assert!(matches!(first, Some(Response::GavinTreeChanged { .. })));

        let mut cmd = connect(&socket_path);
        let resp = request(
            &mut cmd,
            &Request::SetOrchestrationByRoot {
                root_path: root.clone(),
                rails: one_rail("t1"),
                conflict_notes: vec![],
            },
        );
        assert!(matches!(resp, Response::Ok));

        // The plan is readable by workspace id, and the write pushed.
        let resp = request(&mut cmd, &Request::GetOrchestration { workspace_id: "ws-1".into() });
        match resp {
            Response::Orchestration { rails, .. } => assert_eq!(rails[0].id, "r1"),
            other => panic!("expected Orchestration, got {other:?}"),
        }
        let pushed: Option<Response> = protocol::read_message(&mut reader).unwrap();
        match pushed {
            Some(Response::OrchestrationChanged { workspace_id, orchestration }) => {
                assert_eq!(workspace_id, "ws-1");
                assert_eq!(orchestration.rails[0].stages[0].steps[0].id, "t1");
            }
            other => panic!("expected OrchestrationChanged, got {other:?}"),
        }
    }

    #[test]
    fn a_run_state_write_does_not_push() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        handle_request(
            &manager,
            Request::SetOrchestration {
                workspace_id: "ws-1".into(),
                rails: one_rail("t1"),
                conflict_notes: vec![],
            },
        );
        // No watcher is registered, so the only thing under test is that
        // the run-state arm does not try to push: it must answer Ok.
        let resp = handle_request(
            &manager,
            Request::SetStepRun {
                step_id: "t1".into(),
                state: "running".into(),
                session_id: Some("s-1".into()),
                reason: None,
            },
        );
        assert!(matches!(resp, Response::Ok));
    }

    #[test]
    fn the_running_step_guard_reaches_the_root_addressed_path_too() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        handle_request(
            &manager,
            Request::SetOrchestration {
                workspace_id: "ws-1".into(),
                rails: one_rail("t1"),
                conflict_notes: vec![],
            },
        );
        handle_request(
            &manager,
            Request::SetStepRun {
                step_id: "t1".into(),
                state: "running".into(),
                session_id: None,
                reason: None,
            },
        );
        match handle_request(
            &manager,
            Request::SetOrchestration {
                workspace_id: "ws-1".into(),
                rails: one_rail("t2"),
                conflict_notes: vec![],
            },
        ) {
            Response::Error { message } => assert!(message.contains("is running"), "{message}"),
            other => panic!("expected Error, got {other:?}"),
        }
    }
```

Reuse whatever `connect` / `request` / `start_test_server` helpers that module already defines for the socket tests; do not add new ones.

- [ ] **Step 2: Run them and watch them fail**

Run: `cargo test -p gavin-daemon orchestration_by_root`
Expected: FAIL to compile — the request variants do not exist.

- [ ] **Step 3: Add the protocol variants**

In `Request`, beside the other orchestration variants:

```rust
    /// The orchestration of the WATCHED workspace whose root matches --
    /// same resolution as GetBoardByRoot.
    GetOrchestrationByRoot {
        root_path: String,
    },
    SetOrchestrationByRoot {
        root_path: String,
        rails: Vec<Rail>,
        #[serde(default)]
        conflict_notes: Vec<ConflictNote>,
    },
```

In `Response`, beside `GavinTreeChanged`:

```rust
    /// Pushed on the watching connection after any SetOrchestration, so
    /// an agent's rewrite lands in the open tab without a poll. Run-state
    /// writes deliberately do NOT push: they always originate in the app
    /// that already holds the state.
    OrchestrationChanged { workspace_id: String, orchestration: Orchestration },
```

- [ ] **Step 4: Add the manager methods and the push**

In `crates/daemon/src/server.rs`, beside `board_by_root`:

```rust
    pub fn orchestration_by_root(&self, root_path: &str) -> anyhow::Result<protocol::Orchestration> {
        let watcher = self
            .find_watcher_by_root(root_path)
            .ok_or_else(|| anyhow::anyhow!("workspace not open in gavin"))?;
        self.get_orchestration(&watcher.workspace_id)
    }

    pub fn set_orchestration_by_root(
        &self,
        root_path: &str,
        rails: Vec<protocol::Rail>,
        conflict_notes: Vec<protocol::ConflictNote>,
    ) -> anyhow::Result<()> {
        let watcher = self
            .find_watcher_by_root(root_path)
            .ok_or_else(|| anyhow::anyhow!("workspace not open in gavin"))?;
        self.set_orchestration(&watcher.workspace_id, rails, conflict_notes)
    }

    /// Best-effort push of the whole orchestration on the watching app
    /// connection. Silent when the workspace is not watched (a headless
    /// agent with the app closed) or the writer is dead -- the app's next
    /// fetch catches up either way.
    fn push_orchestration(&self, workspace_id: &str) {
        let watcher = self.gavin_watchers.lock().unwrap().get(workspace_id).cloned();
        let Some(watcher) = watcher else { return };
        let Ok(orchestration) = self.get_orchestration(workspace_id) else { return };
        watcher.push_response(&protocol::Response::OrchestrationChanged {
            workspace_id: workspace_id.to_string(),
            orchestration,
        });
    }
```

Then make `set_orchestration` (SP1 Task 3) push after a successful write, so **both** entry points are covered by one call site:

```rust
    pub fn set_orchestration(
        &self,
        workspace_id: &str,
        rails: Vec<protocol::Rail>,
        conflict_notes: Vec<protocol::ConflictNote>,
    ) -> anyhow::Result<()> {
        self.orchestration.lock().unwrap().replace_plan(workspace_id, &rails, &conflict_notes)?;
        // After the lock is released: push_orchestration re-reads through
        // the same mutex, and holding it across the call would deadlock.
        self.push_orchestration(workspace_id);
        Ok(())
    }
```

The `?` before the push is deliberate — a refused write (the running-step guard) must not push a plan that was never stored.

- [ ] **Step 5: Route the two requests**

In `handle_request`:

```rust
        Request::GetOrchestrationByRoot { root_path } => {
            manager.orchestration_by_root(&root_path).map(|o| Response::Orchestration {
                rails: o.rails,
                conflict_notes: o.conflict_notes,
                rail_runs: o.rail_runs,
                step_runs: o.step_runs,
            })
        }
        Request::SetOrchestrationByRoot { root_path, rails, conflict_notes } => manager
            .set_orchestration_by_root(&root_path, rails, conflict_notes)
            .map(|()| Response::Ok),
```

- [ ] **Step 6: Run the suite**

Run: `cargo test -p protocol -p gavin-daemon`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/protocol/src/lib.rs crates/daemon/src/server.rs
git commit -m "feat(daemon): root-addressed orchestration requests and the change push"
```

---

### Task 3: `gavin_get_orchestration`

**Files:**
- Modify: `crates/gavin-mcp/src/main.rs`

**Interfaces:**
- Consumes: `GetOrchestrationByRoot`, `GetBoardByRoot`, `ScanGavinRoot`, `GitDirtyPaths`.
- Produces: the `gavin_get_orchestration` tool.

This tool composes several daemon calls, so it takes an early-return branch in `dispatch_tool` like `gavin_init_root` does, rather than joining the one-request `match`.

- [ ] **Step 1: Write the failing test**

Append to `crates/gavin-mcp/src/main.rs`'s `mod tests`:

```rust
    fn orchestration_reply() -> Response {
        Response::Orchestration {
            rails: vec![protocol::Rail {
                id: "r1".into(),
                name: "backend".into(),
                position: 0,
                worktree_path: Some("/x/wt-a".into()),
                page_id: None,
                stages: vec![protocol::Stage {
                    id: "s1".into(),
                    position: 0,
                    steps: vec![protocol::Step {
                        id: "t1".into(),
                        position: 0,
                        card_path: "/ws/.gavin-root/plans/a.md".into(),
                    }],
                }],
            }],
            conflict_notes: vec![],
            rail_runs: vec![],
            step_runs: vec![protocol::StepRun {
                step_id: "t1".into(),
                state: "running".into(),
                session_id: Some("s-1".into()),
                reason: None,
            }],
        }
    }

    fn board_reply() -> Response {
        Response::Board {
            columns: vec![
                protocol::Column { id: "c0".into(), name: "To Do".into(), position: 0 },
                protocol::Column { id: "c2".into(), name: "Done".into(), position: 2 },
                protocol::Column { id: "c1".into(), name: "In Progress".into(), position: 1 },
            ],
            labels: vec![],
            card_sessions: vec![],
        }
    }

    #[test]
    fn get_orchestration_composes_plan_board_tree_and_dirty_paths() {
        let root = Path::new("/ws");
        let mut t = mock(vec![
            orchestration_reply(),
            board_reply(),
            Response::GavinTreeScanned { tree: two_card_tree() },
            Response::DirtyPaths { paths: vec!["app/src/lib/git.ts".into()], truncated: false },
        ]);
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"gavin_get_orchestration","arguments":{}}}"#,
            Some(root),
            &mut t,
        )
        .unwrap();

        // One GitDirtyPaths per DISTINCT rail worktree, capped at 200.
        match &t.requests[3] {
            Request::GitDirtyPaths { cwd, limit } => {
                assert_eq!(cwd, "/x/wt-a");
                assert_eq!(*limit, 200);
            }
            other => panic!("wrong request: {other:?}"),
        }

        let text: serde_json::Value = {
            let envelope: serde_json::Value = serde_json::from_str(&reply).unwrap();
            serde_json::from_str(envelope["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
        };
        // The done column is the HIGHEST position, not the last element.
        assert_eq!(text["doneColumn"], "Done");
        assert_eq!(text["rails"][0]["dirtyPaths"][0], "app/src/lib/git.ts");
        assert_eq!(text["rails"][0]["dirtyTruncated"], false);
        // Steps carry their card's title and their live run state.
        assert_eq!(text["rails"][0]["stages"][0]["steps"][0]["title"], "Card A");
        assert_eq!(text["rails"][0]["stages"][0]["steps"][0]["run"], "running");
        // b.md is not on a rail, so it is offered as unplaced; a.md is not.
        let unplaced: Vec<&str> = text["unplacedCards"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["title"].as_str().unwrap())
            .collect();
        assert_eq!(unplaced, vec!["Card B"]);
    }

    #[test]
    fn get_orchestration_needs_the_workspace_open() {
        let root = Path::new("/ws");
        let mut t = mock(vec![Response::Error { message: "workspace not open in gavin".into() }]);
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"gavin_get_orchestration","arguments":{}}}"#,
            Some(root),
            &mut t,
        )
        .unwrap();
        assert!(reply.contains("not open in gavin"));
        assert_eq!(t.requests.len(), 1, "no further calls after the first failure");
    }
```

Add the tree fixture beside the other helpers:

```rust
    fn two_card_tree() -> protocol::GavinTree {
        let card = |file: &str, title: &str| protocol::PlanFileInfo {
            path: format!("/ws/.gavin-root/plans/{file}"),
            file_name: file.into(),
            title: title.into(),
            status: Some("To Do".into()),
            priority: None,
            order: None,
            kind: protocol::CardKind::Task,
            parent: None,
            labels: vec![],
            checklist_done: 0,
            checklist_total: 0,
            parse_warning: false,
        };
        protocol::GavinTree {
            root_path: "/ws".into(),
            root_missing: false,
            contexts: vec![protocol::GavinContext {
                folder_path: "/ws/.gavin-root".into(),
                kind: protocol::GavinContextKind::Root,
                name: "ws".into(),
                plans: vec![card("a.md", "Card A"), card("b.md", "Card B")],
                docs: vec![],
                specs: vec![],
                has_prd: true,
                config_warning: false,
                agent: None,
                outside: false,
            }],
        }
    }
```

Match the field names and types to `crates/protocol/src/lib.rs` as it actually stands — that crate is the source of truth, and this fixture must compile against it.

- [ ] **Step 2: Run them and watch them fail**

Run: `cargo test -p gavin-mcp get_orchestration`
Expected: FAIL — `unknown tool: gavin_get_orchestration`.

- [ ] **Step 3: Declare the tool**

Add to `tool_definitions()`:

```rust
        { "name": "gavin_get_orchestration", "description": "The workspace's orchestration: rails with their worktrees and uncommitted files, stages, steps with their cards and live run state, the board's columns, and every runnable card not yet on a rail. Read this before writing an arrangement. Requires the workspace open in gavin.", "inputSchema": { "type": "object", "properties": {} } },
```

- [ ] **Step 4: Implement the composition**

In `dispatch_tool`, after the `gavin_init_root` branch and after `root` is resolved, add another early-return branch:

```rust
    if name == "gavin_get_orchestration" {
        return get_orchestration(root, transport);
    }
```

and add the function beside `dispatch_tool`:

```rust
/// Composed from four daemon calls rather than one fat protocol
/// response: the wire types stay honest, and the payload is shaped for
/// an agent (titles resolved, run state folded onto steps, unplaced
/// cards offered).
///
/// It carries FACTS, not gavin's computed conflict list -- that lives in
/// the app's TypeScript, and a second Rust implementation of the same
/// rule would be free to drift from the one the human sees. The skill
/// states the rule instead.
fn get_orchestration(root: &Path, transport: &mut dyn DaemonTransport) -> anyhow::Result<String> {
    let root_str = root.to_string_lossy().to_string();

    let orch = match transport
        .request(&Request::GetOrchestrationByRoot { root_path: root_str.clone() })?
    {
        Response::Orchestration { rails, conflict_notes, rail_runs, step_runs } => {
            (rails, conflict_notes, rail_runs, step_runs)
        }
        Response::Error { message } => return Err(anyhow::anyhow!(message)),
        other => return Err(anyhow::anyhow!("unexpected response: {other:?}")),
    };
    let (rails, conflict_notes, rail_runs, step_runs) = orch;

    let columns = match transport.request(&Request::GetBoardByRoot { root_path: root_str.clone() })? {
        Response::Board { columns, .. } => columns,
        Response::Error { message } => return Err(anyhow::anyhow!(message)),
        other => return Err(anyhow::anyhow!("unexpected response: {other:?}")),
    };
    // The done column is the highest POSITION, not the last element --
    // the array's order is not the board's order.
    let done_column = columns
        .iter()
        .max_by_key(|c| c.position)
        .map(|c| c.name.clone());

    let tree = match transport.request(&Request::ScanGavinRoot { root_path: root_str })? {
        Response::GavinTreeScanned { tree } => tree,
        Response::Error { message } => return Err(anyhow::anyhow!(message)),
        other => return Err(anyhow::anyhow!("unexpected response: {other:?}")),
    };

    let mut cards: HashMap<String, &protocol::PlanFileInfo> = HashMap::new();
    for ctx in &tree.contexts {
        for plan in &ctx.plans {
            cards.insert(plan.path.clone(), plan);
        }
    }
    let run_of: HashMap<&str, &protocol::StepRun> =
        step_runs.iter().map(|r| (r.step_id.as_str(), r)).collect();
    let rail_run_of: HashMap<&str, &protocol::RailRun> =
        rail_runs.iter().map(|r| (r.rail_id.as_str(), r)).collect();

    // One GitDirtyPaths per DISTINCT worktree: several rails may share
    // one, and re-running git per rail would be pure waste.
    let mut dirty: HashMap<String, (Vec<String>, bool)> = HashMap::new();
    for rail in &rails {
        let Some(path) = rail.worktree_path.clone() else { continue };
        if dirty.contains_key(&path) {
            continue;
        }
        let entry = match transport
            .request(&Request::GitDirtyPaths { cwd: path.clone(), limit: DIRTY_PATH_LIMIT })?
        {
            Response::DirtyPaths { paths, truncated } => (paths, truncated),
            // A worktree git cannot read yields empty evidence rather
            // than failing the whole payload.
            _ => (vec![], false),
        };
        dirty.insert(path, entry);
    }

    // Its own pass: mutating a set inside the nested map closures below
    // would mean reborrowing it through two FnMut layers for no gain.
    let placed: HashSet<&str> = rails
        .iter()
        .flat_map(|r| r.stages.iter())
        .flat_map(|s| s.steps.iter())
        .map(|t| t.card_path.as_str())
        .collect();

    let rails_json: Vec<Value> = rails
        .iter()
        .map(|rail| {
            let (paths, truncated) = rail
                .worktree_path
                .as_ref()
                .and_then(|p| dirty.get(p))
                .cloned()
                .unwrap_or_default();
            let stages: Vec<Value> = rail
                .stages
                .iter()
                .map(|stage| {
                    let steps: Vec<Value> = stage
                        .steps
                        .iter()
                        .map(|step| {
                            let card = cards.get(&step.card_path);
                            json!({
                                "id": step.id,
                                "cardPath": step.card_path,
                                "title": card.map(|c| c.title.clone()),
                                "kind": card.map(|c| kind_str(&c.kind)),
                                "status": card.and_then(|c| c.status.clone()),
                                "run": run_of.get(step.id.as_str()).map(|r| r.state.clone())
                                    .unwrap_or_else(|| "pending".to_string()),
                            })
                        })
                        .collect();
                    json!({ "id": stage.id, "position": stage.position, "steps": steps })
                })
                .collect();
            json!({
                "id": rail.id,
                "name": rail.name,
                "worktreePath": rail.worktree_path,
                "pageId": rail.page_id,
                "state": rail_run_of.get(rail.id.as_str()).map(|r| r.state.clone())
                    .unwrap_or_else(|| "idle".to_string()),
                "dirtyPaths": paths,
                "dirtyTruncated": truncated,
                "stages": stages,
            })
        })
        .collect();

    let unplaced: Vec<Value> = tree
        .contexts
        .iter()
        .flat_map(|ctx| ctx.plans.iter())
        .filter(|p| !matches!(p.kind, protocol::CardKind::Note))
        .filter(|p| !placed.contains(p.path.as_str()))
        .map(|p| {
            json!({
                "path": p.path,
                "title": p.title,
                "kind": kind_str(&p.kind),
                "status": p.status,
            })
        })
        .collect();

    Ok(serde_json::to_string_pretty(&json!({
        "rails": rails_json,
        "conflictNotes": conflict_notes,
        "doneColumn": done_column,
        "columns": columns.iter().map(|c| c.name.clone()).collect::<Vec<_>>(),
        "unplacedCards": unplaced,
    }))?)
}
```

Add at the top of the file:

```rust
use std::collections::{HashMap, HashSet};

/// Cap on dirty paths reported per worktree (spec §8.1). Evidence, not
/// an inventory -- a hundred-file diff tells the agent what it needs.
const DIRTY_PATH_LIMIT: u32 = 200;
```

and the kind speller beside it — an explicit match, not `format!("{:?}")`, because the wire value must be exactly `note`, `task` or `plan` and a rename of the enum variant must not silently change it:

```rust
fn kind_str(kind: &protocol::CardKind) -> &'static str {
    match kind {
        protocol::CardKind::Note => "note",
        protocol::CardKind::Task => "task",
        protocol::CardKind::Plan => "plan",
    }
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cargo test -p gavin-mcp`
Expected: PASS, existing MCP tests included.

- [ ] **Step 6: Commit**

```bash
git add crates/gavin-mcp/src/main.rs
git commit -m "feat(mcp): gavin_get_orchestration composes plan, board, tree and dirty paths"
```

---

### Task 4: `gavin_set_orchestration`

**Files:**
- Modify: `crates/gavin-mcp/src/main.rs`

**Interfaces:**
- Consumes: `SetOrchestrationByRoot`.
- Produces: the `gavin_set_orchestration` tool.

- [ ] **Step 1: Write the failing tests**

Append to `crates/gavin-mcp/src/main.rs`'s `mod tests`:

```rust
    #[test]
    fn set_orchestration_deserializes_rails_and_notes() {
        let root = Path::new("/ws");
        let mut t = mock(vec![Response::Ok]);
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"gavin_set_orchestration","arguments":{
                "rails":[{"id":"r1","name":"backend","position":0,"worktreePath":"/x/wt-a","pageId":null,
                  "stages":[{"id":"s1","position":0,"steps":[{"id":"t1","position":0,"cardPath":"/ws/a.md"}]}]}],
                "conflict_notes":[{"id":"n1","stepIds":["t1"],"note":"touches the diff renderer"}]
            }}}"#,
            Some(root),
            &mut t,
        )
        .unwrap();
        assert!(reply.contains("ok") || reply.contains("saved"), "{reply}");
        match &t.requests[0] {
            Request::SetOrchestrationByRoot { root_path, rails, conflict_notes } => {
                assert_eq!(root_path, "/ws");
                assert_eq!(rails[0].stages[0].steps[0].card_path, "/ws/a.md");
                assert_eq!(conflict_notes[0].step_ids, vec!["t1".to_string()]);
            }
            other => panic!("wrong request: {other:?}"),
        }
    }

    #[test]
    fn set_orchestration_defaults_conflict_notes_to_empty() {
        let root = Path::new("/ws");
        let mut t = mock(vec![Response::Ok]);
        handle_line(
            r#"{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"gavin_set_orchestration","arguments":{
                "rails":[{"id":"r1","name":"backend","position":0,"worktreePath":null,"pageId":null,"stages":[]}]
            }}}"#,
            Some(root),
            &mut t,
        )
        .unwrap();
        match &t.requests[0] {
            Request::SetOrchestrationByRoot { conflict_notes, .. } => assert!(conflict_notes.is_empty()),
            other => panic!("wrong request: {other:?}"),
        }
    }

    #[test]
    fn set_orchestration_reports_malformed_rails_without_calling_the_daemon() {
        let root = Path::new("/ws");
        let mut t = mock(vec![]);
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"gavin_set_orchestration","arguments":{"rails":[{"id":"r1"}]}}}"#,
            Some(root),
            &mut t,
        )
        .unwrap();
        assert!(reply.contains("rails"), "{reply}");
        assert!(t.requests.is_empty(), "malformed input never reaches the daemon");
    }

    #[test]
    fn set_orchestration_surfaces_the_running_step_guard() {
        let root = Path::new("/ws");
        let mut t = mock(vec![Response::Error {
            message: "step t1 (/ws/a.md) is running — pause or let it finish before removing it".into(),
        }]);
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"gavin_set_orchestration","arguments":{"rails":[]}}}"#,
            Some(root),
            &mut t,
        )
        .unwrap();
        assert!(reply.contains("is running"), "{reply}");
    }
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cargo test -p gavin-mcp set_orchestration`
Expected: FAIL — `unknown tool: gavin_set_orchestration`.

- [ ] **Step 3: Declare the tool**

Add to `tool_definitions()`:

```rust
        { "name": "gavin_set_orchestration", "description": "Replace the workspace's orchestration wholesale: rails of stages of steps, plus your own conflict notes. Read gavin_get_orchestration first and preserve the ids of steps you are keeping — run state follows the id. Removing a step whose run state is 'running' is refused.", "inputSchema": { "type": "object", "properties": {
            "rails": { "type": "array", "description": "Ordered rails. Each: { id, name, position, worktreePath, pageId, stages: [{ id, position, steps: [{ id, position, cardPath }] }] }. A stage's steps run IN PARALLEL in that rail's checkout; stages run one after another.", "items": { "type": "object" } },
            "conflict_notes": { "type": "array", "description": "Your judgements, shown to the human in the Conflicts box. Each: { id, stepIds: [...], note }.", "items": { "type": "object" } }
        }, "required": ["rails"] } },
```

- [ ] **Step 4: Map it**

In `dispatch_tool`'s `match name` block:

```rust
        "gavin_set_orchestration" => {
            // Deserialized here rather than in the daemon so malformed
            // input answers the agent directly, with serde's own message,
            // and never reaches the store.
            let rails: Vec<protocol::Rail> = serde_json::from_value(
                args.get("rails").cloned().unwrap_or(Value::Null),
            )
            .map_err(|e| anyhow::anyhow!("rails: {e}"))?;
            let conflict_notes: Vec<protocol::ConflictNote> = match args.get("conflict_notes") {
                Some(v) if !v.is_null() => serde_json::from_value(v.clone())
                    .map_err(|e| anyhow::anyhow!("conflict_notes: {e}"))?,
                _ => vec![],
            };
            Request::SetOrchestrationByRoot { root_path: root_str, rails, conflict_notes }
        }
```

The generic `Response::Ok => Ok("ok")` arm at the bottom of `dispatch_tool` already answers this tool, and `Response::Error` already becomes a tool error, so the running-step guard reaches the agent verbatim.

- [ ] **Step 5: Run the suite**

Run: `cargo test -p gavin-mcp`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/gavin-mcp/src/main.rs
git commit -m "feat(mcp): gavin_set_orchestration"
```

---

### Task 5: Apply the push in the app

**Files:**
- Modify: `app/src-tauri/src/session.rs:1252` (the streaming reader's match)
- Modify: `app/src/lib/orchestrationState.ts`
- Modify: `app/src/lib/layoutState.ts` (the bootstrap listener block)

**Interfaces:**
- Produces: the `orchestration-changed` Tauri event; `initOrchestrationListeners() → Promise<UnlistenFn>`.

- [ ] **Step 1: Forward the push**

In `app/src-tauri/src/session.rs`, beside the `Response::GavinTreeChanged` arm:

```rust
                Response::OrchestrationChanged { workspace_id, orchestration } => {
                    let _ = reader_app_handle.emit("orchestration-changed", (workspace_id, orchestration));
                }
```

- [ ] **Step 2: Listen for it**

Append to `app/src/lib/orchestrationState.ts`:

```ts
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/// Must be registered BEFORE the first watchGavinRoot call: Tauri events
/// emitted with no listener are lost, not buffered. layoutState.bootstrap()
/// registers this in its listener block, next to initGavinListeners.
///
/// The payload REPLACES the plan but preserves whatever run state this
/// app already holds: the daemon's copy of run state can lag an
/// optimistic local write by a round trip, and the agent never authors
/// run state anyway (spec §1.2).
export async function initOrchestrationListeners(): Promise<UnlistenFn> {
  return listen<[string, Orchestration]>("orchestration-changed", (event) => {
    const [workspaceId, incoming] = event.payload;
    orchestrations.update((m) => {
      const current = m[workspaceId];
      if (!current) return { ...m, [workspaceId]: incoming };
      // The preserved run state may name steps the agent just deleted.
      // The daemon has already dropped those rows; this keeps the
      // in-memory copy honest without waiting for the next fetch.
      const railIds = new Set(incoming.rails.map((r) => r.id));
      const stepIds = new Set(
        incoming.rails.flatMap((r) => r.stages.flatMap((s) => s.steps.map((t) => t.id)))
      );
      return {
        ...m,
        [workspaceId]: {
          rails: incoming.rails,
          conflictNotes: incoming.conflictNotes,
          railRuns: current.railRuns.filter((r) => railIds.has(r.railId)),
          stepRuns: current.stepRuns.filter((r) => stepIds.has(r.stepId)),
        },
      };
    });
  });
}
```

- [ ] **Step 3: Register it at bootstrap**

In `app/src/lib/layoutState.ts`'s `bootstrap()`, add `initOrchestrationListeners()` alongside the existing `initGavinListeners()` registration, collecting its unlisten handle the same way the neighbouring listeners do.

- [ ] **Step 4: Verify**

Run: `cargo build --workspace && cd app && npm run check && npm test`
Then, with the app open on the Orchestration tab, run `gavin_set_orchestration` from a terminal agent in the same workspace and confirm the rails change **without touching the tab**, and that a running step keeps its running chip.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/session.rs app/src/lib/orchestrationState.ts app/src/lib/layoutState.ts
git commit -m "feat(app): apply orchestration pushes live in the tab"
```

---

### Task 6: The skill

**Files:**
- Create: `app/src-tauri/src/gavin_orchestrate_skill.md`
- Modify: `app/src-tauri/src/agent_setup.rs`

**Interfaces:**
- Produces: `SkillFile`; `McpLayout.skills: &'static [SkillFile]` (replacing `skill_dir`/`skill_file`); `write_skills(root, layout) → anyhow::Result<Vec<PathBuf>>`.

- [ ] **Step 1: Widen the layout to hold several skills**

In `app/src-tauri/src/agent_setup.rs`, replace `McpLayout`'s two skill fields:

```rust
/// One gavin-managed skill file. Overwritten wholesale on every setup
/// run, like the instructions block's marker section.
pub struct SkillFile {
    pub dir: &'static str,
    pub file: &'static str,
    pub contents: &'static str,
}

pub struct McpLayout {
    pub config_file: &'static str,
    pub server_key: &'static str,
    pub skills: &'static [SkillFile],
}
```

and the `claude-code` profile's `mcp`:

```rust
        mcp: Some(McpLayout {
            config_file: ".mcp.json",
            server_key: "gavin",
            skills: &[
                SkillFile {
                    dir: ".claude/skills/gavin",
                    file: "SKILL.md",
                    contents: include_str!("gavin_skill.md"),
                },
                // Its own skill, not a section of the workflow one: this
                // loads only when orchestration comes up, so the
                // always-on skill stays short.
                SkillFile {
                    dir: ".claude/skills/gavin-orchestrate",
                    file: "SKILL.md",
                    contents: include_str!("gavin_orchestrate_skill.md"),
                },
            ],
        }),
```

Delete the now-unused `const SKILL_MD` and rewrite `write_skill` as:

```rust
/// Gavin-managed: every skill is overwritten wholesale on each setup run.
fn write_skills(root: &Path, layout: &McpLayout) -> anyhow::Result<Vec<PathBuf>> {
    let mut written = Vec::new();
    for skill in layout.skills {
        let dir = root.join(skill.dir);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(skill.file);
        std::fs::write(&path, skill.contents)?;
        written.push(path);
    }
    Ok(written)
}
```

In the setup function (around line 224), replace the single element with the vector:

```rust
    let mut written = vec![write_mcp_config(root, layout, &binary).map_err(|e| e.to_string())?];
    written.extend(write_skills(root, layout).map_err(|e| e.to_string())?);
    written.push(write_instructions_block(root, &instructions_file).map_err(|e| e.to_string())?);
```

Update the two existing tests that call `write_skill` (around lines 443-446) to call `write_skills` and assert both files land, the second overwriting cleanly on a repeat run.

- [ ] **Step 2: Write the skill**

Create `app/src-tauri/src/gavin_orchestrate_skill.md`:

```markdown
---
name: gavin-orchestrate
description: Use when the human asks to plan, order, parallelize, or reorganize this workspace's work — or asks why a rail is blocked. Reads and writes the Orchestration tab's rails.
---

# Organizing a gavin workspace's work into rails

The Orchestration tab lays this workspace's cards out in time. A **rail**
is a vertical track bound to a git worktree and a workspace page. A rail
holds ordered **stages**; a stage holds one or more **steps**; a step is
a reference to a card file. Stages run one after another. **A stage's
steps run at the same time, in that rail's checkout.**

The human arms a rail with Start; gavin then launches each stage and
advances when every step's card reaches the board's done column.

## 1. Read before you write

Call `gavin_get_orchestration` first, every time. It returns the current
rails with their worktrees and their **uncommitted files**, every step
with its card and live run state, the board's columns, and every runnable
card not yet on a rail. Never author an arrangement from memory or from
the card titles alone.

If there are no rails yet, create one per natural workstream — a
subsystem, a layer, a piece of the PRD — and propose a worktree name for
each. The human binds them in the tab; you only name them.

## 2. The parallelism rule

Two steps collide only when they edit the **same working tree**:

- **Same rail, same stage** — always the same checkout. There is no
  step-level worktree, so co-staging two steps means two agents editing
  one tree at once. Only do this when the work genuinely does not touch
  the same files.
- **Different rails on different worktrees** — never a conflict, whatever
  they touch. Worktree isolation is the answer.
- **Different rails on the SAME worktree** — always a risk: rails advance
  independently, so gavin makes no ordering promise between them.
- **Different stages of one rail** — strictly sequential, never a
  conflict.

Weigh the card bodies and the rail's `dirtyPaths` before co-staging
anything. **When unsure, serialize.** A wrong serial order costs time; a
wrong parallel one costs a merge conflict in a live checkout, and the
human has to untangle two agents' half-finished edits.

If two pieces of work must run at once and might collide, the right move
is two rails on two worktrees — not one parallel stage.

## 3. Record your reasoning

Every judgement you made goes back as a `conflict_notes` entry naming the
step ids it concerns. The human reads these in the tab's Conflicts box,
beside gavin's own structural findings. An arrangement with no notes asks
to be trusted blindly; one with notes can be checked.

## 4. Write it

`gavin_set_orchestration` replaces the whole plan.

- **Preserve the ids** of steps you are keeping. Run state follows the
  step id, so a new id silently discards which agent is on which work.
- **Never remove a step whose `run` is `running`.** The daemon refuses
  the whole write and tells you which step — moving it between stages or
  rails is fine, only deleting it is not.
- Positions are yours to set; keep them dense and ascending.

Then say what you changed and why, in a sentence or two per rail.

## 5. When a rail is stuck

A step shows `stalled` when its agent exited before the card reached the
done column, or when its card or worktree went missing. Read the card,
fix the cause, and tell the human — Retry is theirs to press, not yours.
```

- [ ] **Step 3: Verify the setup path**

Run: `cargo test --workspace`
Then, in the app, run the agent setup for a workspace and confirm both
`.claude/skills/gavin/SKILL.md` and `.claude/skills/gavin-orchestrate/SKILL.md` exist and the setup panel lists both.

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/src/gavin_orchestrate_skill.md app/src-tauri/src/agent_setup.rs
git commit -m "feat(app): gavin-orchestrate skill, installed beside the workflow skill"
```

---

### Task 7: The Reorganize button

**Files:**
- Modify: `app/src/lib/cardRunActions.ts`
- Modify: `app/src/lib/orchestrationState.ts`
- Modify: `app/src/lib/OrchestrationHubView.svelte`

**Interfaces:**
- Consumes: `sendToMainAgent`'s bracketed-paste mechanism.
- Produces: `pasteToMainAgent(workspaceId, prompt) → Promise<string | null>` in `cardRunActions.ts`; `requestReorganize(workspaceId, summary) → Promise<string | null>` in `orchestrationState.ts`.

- [ ] **Step 1: Extract the paste helper**

In `app/src/lib/cardRunActions.ts`, pull the terminal-write half out of `sendToMainAgent` so both callers share it:

```ts
/// Bracketed paste into the workspace's RUNNING main agent, then Enter.
/// Bracketed so a multi-line prompt arrives as one block instead of
/// line-by-line submissions. Returns an error string or null.
///
/// Never starts the agent: agent launches cost money and attention, and
/// that is the human's call.
export async function pasteToMainAgent(
  workspaceId: string,
  prompt: string
): Promise<string | null> {
  const workspace = get(layoutState).workspaces.find((w) => w.id === workspaceId);
  const mainSessionId = workspace?.mainSessionId ?? null;
  if (!mainSessionId) return "No workspace agent running — start it on the Home tab first";
  try {
    await backend.writeInput(mainSessionId, `\x1b[200~${prompt}\x1b[201~\r`);
  } catch (e) {
    return `Couldn't reach the workspace agent: ${e instanceof Error ? e.message : e}`;
  }
  return null;
}
```

and have `sendToMainAgent` call it instead of holding its own copy of the lookup and the write.

- [ ] **Step 2: Compose the request**

Append to `app/src/lib/orchestrationState.ts`:

```ts
/// Hand the reorganize request to the RUNNING workspace agent. The
/// summary of what the tab currently shows rides along so the agent
/// starts from the same picture the human is looking at -- it still
/// calls gavin_get_orchestration for the authoritative read.
export async function requestReorganize(
  workspaceId: string,
  conflictSummary: string[]
): Promise<string | null> {
  const orch = get(orchestrations)[workspaceId];
  const railLine = (rail: Rail): string =>
    `- ${rail.name} (${rail.worktreePath ?? "no worktree"}): ` +
    `${rail.stages.length} stage${rail.stages.length === 1 ? "" : "s"}, ` +
    `${rail.stages.reduce((n, s) => n + s.steps.length, 0)} steps`;

  const prompt = [
    "Use the gavin-orchestrate skill to reorganize this workspace's orchestration.",
    "",
    orch && orch.rails.length > 0
      ? `The tab currently shows:\n${orch.rails.map(railLine).join("\n")}`
      : "The tab has no rails yet — create them.",
    conflictSummary.length > 0
      ? `\nGavin currently flags:\n${conflictSummary.map((c) => `- ${c}`).join("\n")}`
      : "\nGavin currently flags no conflicts.",
    "",
    "Read gavin_get_orchestration for the authoritative picture before writing anything.",
  ].join("\n");

  return pasteToMainAgent(workspaceId, prompt);
}
```

with `import { pasteToMainAgent } from "./cardRunActions";`.

- [ ] **Step 3: Wire the button**

In `app/src/lib/OrchestrationHubView.svelte`, the header button SP1 left inert:

```svelte
  <button
    type="button"
    class="reorganize"
    disabled={!mainAgentRunning}
    title={mainAgentRunning ? "" : "Start the workspace agent on Home first"}
    onclick={() => void reorganize()}
  >
    Reorganize with agent…
  </button>
```

```ts
  const mainAgentRunning = $derived(Boolean(ws?.mainSessionId));

  async function reorganize(): Promise<void> {
    // Conflicts are SP2's; until it lands there is nothing to summarize
    // and the agent reads the authoritative picture itself anyway.
    const err = await requestReorganize(workspaceId, conflictSummary);
    if (err) {
      saveErrors.update((e) => ({ ...e, [workspaceId]: err }));
      return;
    }
    await switchWorkspaceView(workspaceId, "home");
  }
```

Import `requestReorganize` and `switchWorkspaceView`, and define the summary as an empty list:

```ts
  const conflictSummary = $derived<string[]>([]);
```

**Once SP2 has landed**, replace that one line with the real summary and add the `describeConflict` import:

```ts
  const conflictSummary = $derived(
    orch ? numbered.map(({ n, conflict }) => `${n}. ${describeConflict(conflict, cards, orch)}`) : []
  );
```

Written this way round because SP3 does not depend on SP2 (see **Depends on**): `describeConflict` and `numbered` do not exist until SP2 is merged, so importing them here unconditionally would not compile.

- [ ] **Step 4: Verify**

Run: `cd app && npm run check && npm test`
Then, in the app:

1. With no workspace agent running, confirm the button is disabled with its explanation.
2. Start the agent on Home, return to Orchestration, click the button. Confirm the prompt arrives as **one block** in the agent's terminal and the view switches to Home.
3. Let the agent run: confirm it calls `gavin_get_orchestration`, that `dirtyPaths` reflects real uncommitted files in a bound worktree (edit a file in one and re-run the tool), and that its `gavin_set_orchestration` write appears in the tab **without a reload**.
4. Arm a rail so a step is running, then ask the agent to delete that step. Confirm it is refused with the message naming the step, and that the tab is unchanged.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/cardRunActions.ts app/src/lib/orchestrationState.ts app/src/lib/OrchestrationHubView.svelte
git commit -m "feat(app): Reorganize with agent button"
```

- [ ] **Step 6: Close out the card**

```
gavin_set_plan_field(".gavin-root/plans/orchestration-agent-surface.md", "status", "Done")
```

```bash
git add .gavin-root/plans/orchestration-agent-surface.md
git commit -m "docs(plan): orchestration SP3 complete"
```

---

## What SP3 deliberately leaves undone

- **No MCP tool writes run state.** Arming, pausing and retrying stay the human's, through the tab. The agent arranges work; it does not decide when agents launch.
- **No branch name in the payload.** The worktree path identifies the checkout; naming its branch would cost another daemon request type for no reasoning power (spec §8.1).
- **The push carries the whole orchestration**, not a diff. Plans are small, and a diff protocol would need reconciliation the tab does not otherwise need.
- **A headless agent's write does not reach a closed app.** Root-addressed requests require the workspace to be open in gavin, which is the same contract `gavin_spawn_session` already holds — visibility is the point.
