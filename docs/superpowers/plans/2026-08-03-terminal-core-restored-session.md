# Restored-Session UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make session restoration fail safely (one broken pane instead of a blanked app, and self-healing registry state instead of a repeating failure) and finish the originally-specified, never-built "restored after restart" pane marker.

**Architecture:** One plan spanning the whole stack — every piece here is tightly coupled (the new `SessionRestored` event needs daemon and frontend changes together to be meaningful) and the frontend surface is small enough not to need its own dedicated design pass. Five tasks: daemon-side failure isolation, the new protocol event plus its daemon-side baseline/clearing, the app-side cwd-preserving replacement plus Tauri relay, frontend state, and the pane badge.

**Tech Stack:** Rust (daemon, protocol, Tauri app), TypeScript/Svelte 5 (frontend). No new dependencies.

## Global Constraints

- A single session that fails to restore must never affect any other session or blank the whole app — isolation to that one pane only.
- A registry record that fails to restore must self-heal: marked `Exited` so it doesn't repeat the identical failure on the next launch.
- A session needing full replacement (not just recovery) must land at its own last-known `cwd`, not `$HOME` — `$HOME` remains the fallback only when a session id has no registry record at all.
- The `restored` marker is purely informational — no OS notification, no blocking UI, matching the "silence is a valid baseline" convention already established for other per-session baseline events in this protocol.
- No new inline "exited pane" banner UI — a session that can't be attached to (for any reason) closes its tab exactly the way any other exit already does. This plan makes that existing behavior safely scoped, not different.
- Work happens directly on `main`, no worktree (this project's standing preference). Execute via subagent-driven-development. The user has explicitly asked to move straight through implementation and validate via manual testing afterward, rather than pausing for intermediate check-ins.

---

### Task 1: `recover()` self-heals, and Attach failures are isolated to one pane

**Files:**
- Modify: `crates/daemon/src/server.rs`

**Interfaces:**
- Produces: `ATTACH_FAILURE_EXIT_CODE: i32` constant, consumed by Task 2 (no direct dependency, but Task 2's `SessionRestored` baseline sits in the same `attach()` function this task's tests exercise).

`recover()` currently has **two** separate early-return paths that leave a registry record at its stale pre-crash status forever instead of marking it `Exited` — grounding this plan in the actual current code (not just the design spec's prose, which only called out the `PtySession::spawn` failure explicitly) found a second one: the `workspace_path` no-longer-a-directory check. Both produce the identical "zombie record repeats the same failure on every future launch" problem, so both get the same fix here.

- [ ] **Step 1: Write the failing tests**

Find this existing test (it currently asserts the *old*, soon-to-be-wrong behavior — you'll fix it in Step 3, not now):

```rust
    #[test]
    fn attaching_after_a_failed_recovery_spawn_leaves_no_repo_mapping_or_poller_behind() {
        // recover() leaves a registry row at its ORIGINAL, non-Exited
        // status when PtySession::spawn fails for it, and no `sessions`
        // entry -- so attach()'s Exited gate does not apply, the mapping
        // gets established, a poller gets spawned, and then the pump's
        // reader_for call fails. Without the error arm's own
        // unregister_session_repo_mapping, both leak permanently, once
        // per attach.
```

Add these new tests near it (in the same `mod tests` block):

```rust
    #[test]
    fn recover_marks_a_failed_spawn_record_exited_instead_of_leaving_it_stale() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        {
            let registry = Registry::open(&db_path).unwrap();
            registry
                .insert(&SessionRecord {
                    id: "failed-spawn-2".to_string(),
                    workspace_path: "/tmp".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/nonexistent/definitely-not-an-executable-xyz".to_string()),
                    status: SessionStatus::Idle,
                    restored: false,
                })
                .unwrap();
        }

        let manager = SessionManager::new(Registry::open(&db_path).unwrap());
        manager.recover().unwrap();

        assert!(
            manager.sessions.lock().unwrap().get("failed-spawn-2").is_none(),
            "test premise broken: the command was expected to fail to spawn"
        );
        assert_eq!(
            manager.registry.lock().unwrap().get("failed-spawn-2").unwrap().unwrap().status,
            SessionStatus::Exited,
            "a failed-spawn record must now be marked Exited, not left at its pre-crash status"
        );
    }

    #[test]
    fn recover_marks_a_missing_workspace_path_record_exited_instead_of_leaving_it_stale() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        {
            let registry = Registry::open(&db_path).unwrap();
            registry
                .insert(&SessionRecord {
                    id: "missing-workspace-1".to_string(),
                    workspace_path: "/definitely/does/not/exist/anywhere".to_string(),
                    cwd: "/definitely/does/not/exist/anywhere".to_string(),
                    command: Some("/bin/sh".to_string()),
                    status: SessionStatus::Working,
                    restored: false,
                })
                .unwrap();
        }

        let manager = SessionManager::new(Registry::open(&db_path).unwrap());
        manager.recover().unwrap();

        assert!(manager.sessions.lock().unwrap().get("missing-workspace-1").is_none());
        assert_eq!(
            manager.registry.lock().unwrap().get("missing-workspace-1").unwrap().unwrap().status,
            SessionStatus::Exited,
            "a record whose workspace_path no longer exists must also be marked Exited"
        );
    }

    #[test]
    fn attach_to_a_registry_record_with_no_live_pty_sends_a_scoped_session_exited_not_a_bare_error() {
        // Constructs the general "registry says alive, no live process"
        // case directly, independent of any specific real-world cause --
        // recover()'s own two failure-to-recover avenues are now closed by
        // the fixes above (both mark the record Exited immediately), so
        // this is the defensive path spawn_pump's error arm exists for
        // regardless of how it's reached (a future, currently
        // unanticipated cause; a narrow timing race; etc.).
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        {
            let registry = Registry::open(&db_path).unwrap();
            registry
                .insert(&SessionRecord {
                    id: "no-live-pty-1".to_string(),
                    workspace_path: "/tmp".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                    status: SessionStatus::Idle,
                    restored: false,
                })
                .unwrap();
        }
        let manager = Arc::new(SessionManager::new(Registry::open(&db_path).unwrap()));
        // No recover() call -- `sessions` genuinely has no entry for this
        // id, simulating whatever unanticipated cause reaches this arm.

        let (client, server_side) = UnixStream::pair().unwrap();
        // Set before attach, not after: the pump's error arm drops the far
        // end of this pair, and on macOS SO_RCVTIMEO on a socketpair whose
        // peer has already been dropped fails with EINVAL.
        client.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        manager.attach("no-live-pty-1", Arc::new(Mutex::new(server_side)));

        let mut reader = BufReader::new(client);
        let mut saw_scoped_exit = false;
        loop {
            match read_message::<_, Response>(&mut reader) {
                Ok(Some(Response::SessionExited { id, exit_code })) if id == "no-live-pty-1" => {
                    assert_eq!(exit_code, ATTACH_FAILURE_EXIT_CODE);
                    saw_scoped_exit = true;
                    break;
                }
                Ok(Some(Response::Error { message })) => {
                    panic!("expected a scoped SessionExited, got a bare Error: {message}");
                }
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => break,
            }
        }
        assert!(saw_scoped_exit, "never received a scoped SessionExited for the failed attach");

        // And it self-heals: the registry now reflects Exited too, so the
        // *next* launch's reconciliation (Task 3) can cleanly replace it.
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let status = manager.registry.lock().unwrap().get("no-live-pty-1").unwrap().unwrap().status;
            if status == SessionStatus::Exited {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "registry never self-healed to Exited");
            std::thread::sleep(Duration::from_millis(25));
        }
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin && source "$HOME/.cargo/env"; cargo test -p gavin-daemon recover_marks_a_failed_spawn_record_exited -- --exact`
Expected: FAIL — `ATTACH_FAILURE_EXIT_CODE` doesn't exist yet, and the two `recover_marks_*` tests fail their `SessionStatus::Exited` assertions (still `Idle`/`Working`).

- [ ] **Step 3: Implement**

Add the new constant near the top of the file, alongside the other module-level constants (e.g. right after `const OUTPUT_BUFFER_CAP: usize = 64 * 1024;`):

```rust
/// Sent as the exit_code of a Response::SessionExited that isn't really an
/// exit at all -- it's spawn_pump's reader_for failing to find any live
/// process for this session id (no PTY was ever running for it in THIS
/// daemon process). Distinct from the -1 "exit code genuinely unknown"
/// sentinel used elsewhere in this file (see exit_code_for's own callers),
/// so the two different "we don't have a real exit code" cases stay
/// distinguishable in logs/diagnostics even though the frontend doesn't
/// currently branch on the value -- it reuses the exact same
/// SessionExited handling as any other exit either way.
const ATTACH_FAILURE_EXIT_CODE: i32 = -2;
```

In `recover()`, find:

```rust
            if !std::path::Path::new(&record.workspace_path).is_dir() {
                eprintln!(
                    "skipping recovery of session {} — workspace_path no longer exists: {}",
                    record.id, record.workspace_path
                );
                continue;
            }
```

Replace with:

```rust
            if !std::path::Path::new(&record.workspace_path).is_dir() {
                eprintln!(
                    "skipping recovery of session {} — workspace_path no longer exists: {}",
                    record.id, record.workspace_path
                );
                if let Err(e) = self.registry.lock().unwrap().update_status(&record.id, SessionStatus::Exited) {
                    eprintln!("failed to mark session {} exited: {e}", record.id);
                }
                continue;
            }
```

Then find:

```rust
                Err(e) => {
                    eprintln!(
                        "failed to recover session {} (workspace_path {}): {e}",
                        record.id, record.workspace_path
                    );
                }
```

Replace with:

```rust
                Err(e) => {
                    eprintln!(
                        "failed to recover session {} (workspace_path {}): {e}",
                        record.id, record.workspace_path
                    );
                    if let Err(e) = self.registry.lock().unwrap().update_status(&record.id, SessionStatus::Exited) {
                        eprintln!("failed to mark session {} exited: {e}", record.id);
                    }
                }
```

In `spawn_pump`'s error arm, find:

```rust
                    let removed = manager.attached_writers.lock().unwrap().remove(&id);
                    if let Some(w) = removed {
                        let _ = write_message(&mut *w.lock().unwrap(), &Response::Error { message: e.to_string() });
                    }
```

Replace with:

```rust
                    let removed = manager.attached_writers.lock().unwrap().remove(&id);
                    if let Some(w) = removed {
                        let _ = write_message(
                            &mut *w.lock().unwrap(),
                            &Response::SessionExited { id: id.clone(), exit_code: ATTACH_FAILURE_EXIT_CODE },
                        );
                    }
                    if let Err(e) = manager.registry.lock().unwrap().update_status(&id, SessionStatus::Exited) {
                        eprintln!("failed to mark session {id} exited after a failed attach: {e}");
                    }
```

Now update the existing (now-stale) test. Find:

```rust
        let manager = Arc::new(SessionManager::new(Registry::open(&db_path).unwrap()));
        manager.recover().unwrap();
        assert!(
            manager.sessions.lock().unwrap().get("failed-spawn-1").is_none(),
            "test premise broken: the command was expected to fail to spawn"
        );
        assert_eq!(
            manager.registry.lock().unwrap().get("failed-spawn-1").unwrap().unwrap().status,
            SessionStatus::Idle,
            "test premise broken: recover() is expected to leave the row's original status alone"
        );
```

Replace with:

```rust
        let manager = Arc::new(SessionManager::new(Registry::open(&db_path).unwrap()));
        manager.recover().unwrap();
        assert!(
            manager.sessions.lock().unwrap().get("failed-spawn-1").is_none(),
            "test premise broken: the command was expected to fail to spawn"
        );
        assert_eq!(
            manager.registry.lock().unwrap().get("failed-spawn-1").unwrap().unwrap().status,
            SessionStatus::Exited,
            "test premise broken: recover() is now expected to mark a failed-spawn record Exited"
        );
```

The rest of that test (the `attach()` call and the wait-loop asserting no repo mapping/poller leaked) stays unchanged — it will now pass immediately rather than needing the async wait, since an `Exited` record never establishes a git-status mapping in the first place (`attach()`'s existing baseline block already gates that on non-`Exited` status). That's fine: the underlying defensive code in `spawn_pump`'s error arm (`unregister_session_repo_mapping`) stays in place for any other cause that might still reach it — this test just no longer needs the wait-loop to prove it, since there's nothing to unregister via this particular avenue anymore. Leave the wait-loop as-is; it still passes correctly, just quickly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p gavin-daemon`
Expected: PASS — all existing tests plus the 3 new ones, including the updated `attaching_after_a_failed_recovery_spawn_leaves_no_repo_mapping_or_poller_behind`.

- [ ] **Step 5: Run twice to check for flakiness, then the full workspace**

Run: `cargo test -p gavin-daemon && cargo test -p gavin-daemon && cargo build`
Expected: PASS both times, clean build.

- [ ] **Step 6: Commit**

```bash
git add crates/daemon/src/server.rs
git commit -m "fix(daemon): mark failed-to-recover sessions Exited and isolate Attach failures to one session"
```

---

### Task 2: `SessionRestored` protocol event + daemon baseline + clearing on input

**Files:**
- Modify: `crates/protocol/src/lib.rs`
- Modify: `crates/daemon/src/registry.rs`
- Modify: `crates/daemon/src/server.rs`

**Interfaces:**
- Consumes: nothing from Task 1 directly (independent files/functions), but both land in `server.rs`.
- Produces: `Response::SessionRestored { id: String }`, `Registry::clear_restored(&self, id: &str) -> anyhow::Result<()>` — consumed by Task 3 (the new Tauri relay arm matches on this variant).

- [ ] **Step 1: Write the failing tests**

In `crates/protocol/src/lib.rs`'s `mod tests`, add (mirroring `cwd_changed_response_roundtrips_through_json_line` exactly):

```rust
    #[test]
    fn session_restored_response_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let resp = Response::SessionRestored { id: "s1".to_string() };
        write_message(&mut buf, &resp).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Response = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Response::SessionRestored { id } => {
                assert_eq!(id, "s1");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }
```

In `crates/daemon/src/registry.rs`'s `mod tests`, add (mirroring the existing `mark_restored_persists` test exactly, in reverse):

```rust
    #[test]
    fn clear_restored_persists() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();
        registry.mark_restored("s1").unwrap();

        registry.clear_restored("s1").unwrap();

        let sessions = registry.list().unwrap();
        assert_eq!(sessions[0].restored, false);
    }

    #[test]
    fn clear_restored_on_an_already_clear_record_is_a_harmless_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();

        registry.clear_restored("s1").unwrap();

        let sessions = registry.list().unwrap();
        assert_eq!(sessions[0].restored, false);
    }
```

In `crates/daemon/src/server.rs`'s `mod tests`, add:

```rust
    #[test]
    fn attach_sends_a_session_restored_baseline_right_after_cwd_changed_when_restored_is_true() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        {
            let registry = Registry::open(&db_path).unwrap();
            registry
                .insert(&SessionRecord {
                    id: "restored-1".to_string(),
                    workspace_path: "/tmp".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                    status: SessionStatus::Idle,
                    restored: true,
                })
                .unwrap();
        }
        let manager = Arc::new(SessionManager::new(Registry::open(&db_path).unwrap()));

        let (client, server_side) = UnixStream::pair().unwrap();
        client.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        manager.attach("restored-1", Arc::new(Mutex::new(server_side)));

        let mut reader = BufReader::new(client);
        let first: Response = read_message(&mut reader).unwrap().unwrap();
        assert!(matches!(first, Response::CwdChanged { .. }), "expected CwdChanged first, got {first:?}");
        let second: Response = read_message(&mut reader).unwrap().unwrap();
        match second {
            Response::SessionRestored { id } => assert_eq!(id, "restored-1"),
            other => panic!("expected SessionRestored right after CwdChanged, got {other:?}"),
        }
    }

    #[test]
    fn attach_never_sends_session_restored_when_restored_is_false() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        {
            let registry = Registry::open(&db_path).unwrap();
            registry
                .insert(&SessionRecord {
                    id: "not-restored-1".to_string(),
                    workspace_path: "/tmp".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                    status: SessionStatus::Idle,
                    restored: false,
                })
                .unwrap();
        }
        let manager = Arc::new(SessionManager::new(Registry::open(&db_path).unwrap()));

        let (client, server_side) = UnixStream::pair().unwrap();
        client.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        manager.attach("not-restored-1", Arc::new(Mutex::new(server_side)));

        let mut reader = BufReader::new(client);
        loop {
            match read_message::<_, Response>(&mut reader) {
                Ok(Some(Response::SessionRestored { .. })) => {
                    panic!("SessionRestored must never be sent when restored is false");
                }
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => break,
            }
        }
    }

    #[test]
    fn write_input_clears_the_restored_flag() {
        // Drives SessionManager directly rather than over the socket: a
        // session created via Request::CreateSession is always fresh and
        // never restored, so `restored: true` needs to be established
        // directly first, which only the in-process manager makes
        // convenient.
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        let manager = SessionManager::new(Registry::open(&db_path).unwrap());
        let id = manager.create_session("/tmp", "/tmp", Some("/bin/sh")).unwrap();
        manager.registry.lock().unwrap().mark_restored(&id).unwrap();
        assert_eq!(
            manager.registry.lock().unwrap().get(&id).unwrap().unwrap().restored,
            true,
            "test premise broken: mark_restored should have set restored"
        );

        manager.write_input(&id, b"echo hi\n").unwrap();

        assert_eq!(
            manager.registry.lock().unwrap().get(&id).unwrap().unwrap().restored,
            false,
            "write_input must clear the restored flag"
        );
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p gavin-daemon session_restored -- --list` then `cargo test -p gavin-daemon`
Expected: FAIL to compile — `Response::SessionRestored` and `Registry::clear_restored` don't exist yet.

- [ ] **Step 3: Implement**

In `crates/protocol/src/lib.rs`, find:

```rust
    GitStatusChanged { id: String, status: Option<GitStatus> },
    Ok,
```

Replace with:

```rust
    GitStatusChanged { id: String, status: Option<GitStatus> },
    SessionRestored { id: String },
    Ok,
```

In `crates/daemon/src/registry.rs`, find:

```rust
    pub fn mark_restored(&self, id: &str) -> anyhow::Result<()> {
        self.conn
            .execute("UPDATE sessions SET restored = 1 WHERE id = ?1", params![id])?;
        Ok(())
    }
```

Add right after it:

```rust
    pub fn clear_restored(&self, id: &str) -> anyhow::Result<()> {
        self.conn
            .execute("UPDATE sessions SET restored = 0 WHERE id = ?1 AND restored = 1", params![id])?;
        Ok(())
    }
```

In `crates/daemon/src/server.rs`'s `attach()`, find:

```rust
        let baseline_record = self.registry.lock().unwrap().get(id).ok().flatten();
        if let Some(record) = baseline_record {
            let _ = write_message(
                &mut *writer.lock().unwrap(),
                &Response::CwdChanged { id: id.to_string(), cwd: record.cwd.clone() },
            );
            // Git-status mapping/baseline is skipped for Exited sessions
```

Replace with:

```rust
        let baseline_record = self.registry.lock().unwrap().get(id).ok().flatten();
        if let Some(record) = baseline_record {
            let _ = write_message(
                &mut *writer.lock().unwrap(),
                &Response::CwdChanged { id: id.to_string(), cwd: record.cwd.clone() },
            );
            // Sent regardless of status (unlike StatusChanged/git-status
            // just below) -- restored is orthogonal to the session's
            // current status, and an Exited record never reaches this
            // point via a normal attach anyway (Task 1/3 keep it that
            // way), so gating on status here would just be dead code, not
            // a safety requirement. Nothing is sent when restored is
            // false, mirroring GitStatusChanged's own "silence is a valid
            // baseline" convention.
            if record.restored {
                let _ = write_message(
                    &mut *writer.lock().unwrap(),
                    &Response::SessionRestored { id: id.to_string() },
                );
            }
            // Git-status mapping/baseline is skipped for Exited sessions
```

In `crates/daemon/src/server.rs`'s `write_input`, find:

```rust
    pub fn write_input(&self, id: &str, data: &[u8]) -> anyhow::Result<()> {
        let writer = {
            let sessions = self.sessions.lock().unwrap();
            let session = sessions
                .get(id)
                .ok_or_else(|| anyhow::anyhow!("unknown session: {id}"))?;
            session.writer_handle()
        };
        writer.lock().unwrap().write_all(data)?;
        Ok(())
    }
```

Replace with:

```rust
    pub fn write_input(&self, id: &str, data: &[u8]) -> anyhow::Result<()> {
        let writer = {
            let sessions = self.sessions.lock().unwrap();
            let session = sessions
                .get(id)
                .ok_or_else(|| anyhow::anyhow!("unknown session: {id}"))?;
            session.writer_handle()
        };
        writer.lock().unwrap().write_all(data)?;
        if let Err(e) = self.registry.lock().unwrap().clear_restored(id) {
            eprintln!("failed to clear restored flag for session {id}: {e}");
        }
        Ok(())
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p protocol && cargo test -p gavin-daemon`
Expected: PASS — all existing tests plus the new ones in both crates.

- [ ] **Step 5: Run twice to check for flakiness, then the full workspace**

Run: `cargo test -p gavin-daemon && cargo test -p gavin-daemon && cargo build`
Expected: PASS both times, clean build.

- [ ] **Step 6: Commit**

```bash
git add crates/protocol/src/lib.rs crates/daemon/src/registry.rs crates/daemon/src/server.rs
git commit -m "feat(daemon): add the SessionRestored baseline event and clear it on first input"
```

---

### Task 3: App-side cwd-preserving replacement + Tauri relay

**Files:**
- Modify: `app/src-tauri/src/session.rs`

**Interfaces:**
- Consumes: `Response::SessionRestored` (Task 2).
- Produces: `create_fresh_session(command_conn: &Mutex<UnixStream>, cwd: Option<&str>) -> anyhow::Result<String>` (signature change) — consumed by Task 4 only insofar as the frontend now receives a `"session-restored"` event; no direct frontend dependency on this task's Rust-side signature.

- [ ] **Step 1: Write the failing tests**

The existing `fake_daemon_replying_with` test helper (in `mod test_support`) only *replies* to requests — it discards each one after reading it, so a test built on it can't assert *which* `cwd` a `CreateSession` request actually carried, only the final resolved session id. That's not strong enough to prove this task's actual claim (the replacement uses the exited session's own last-known `cwd`, not `$HOME`), so add a capturing variant alongside it. In `app/src-tauri/src/session.rs`'s `mod test_support`, add this right after the existing `fake_daemon_replying_with`:

```rust
    /// Like `fake_daemon_replying_with`, but also captures every request
    /// the fake daemon receives, in order, into the returned `Vec` (shared
    /// via `Arc<Mutex<...>>` since the daemon thread and the test both
    /// need it) -- for tests that need to assert not just the final
    /// resolved state, but specifically what was SENT to get there (e.g.
    /// which `cwd` a `CreateSession` request carried).
    pub fn fake_daemon_capturing_requests(
        responses: Vec<Response>,
    ) -> (UnixStream, Arc<Mutex<Vec<Request>>>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("fake.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        let captured = Arc::new(Mutex::new(Vec::new()));
        let captured_clone = Arc::clone(&captured);

        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            for response in responses {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let req: Request = read_message(&mut reader).unwrap().unwrap();
                captured_clone.lock().unwrap().push(req);
                write_message(&mut stream, &response).unwrap();
            }
        });

        let client = UnixStream::connect(&socket_path).unwrap();
        (client, captured, dir)
    }
```

In `mod resolve_workspaces_tests`, add an `exited_session` helper right after the existing `valid_session` helper:

```rust
    fn exited_session(id: &str, cwd: &str) -> protocol::SessionSummary {
        protocol::SessionSummary {
            id: id.to_string(),
            workspace_path: cwd.to_string(),
            cwd: cwd.to_string(),
            status: "exited".to_string(),
            restored: false,
        }
    }
```

Add `use super::test_support::fake_daemon_capturing_requests;` alongside the existing `use super::test_support::fake_daemon_replying_with;` line at the top of `mod resolve_workspaces_tests`, then add these tests after `replaces_stale_session_ids_across_multiple_pages_and_workspaces`:

```rust
    #[test]
    fn replaces_an_exited_session_at_its_own_last_known_cwd_not_home() {
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![
            Response::SessionList {
                sessions: vec![exited_session("exited-1", "/Users/alice/project")],
            },
            Response::SessionCreated { id: "fresh-a".to_string() },
        ]);
        let conn = Mutex::new(client);
        let mut workspaces = vec![workspace("ws-1", vec![page("page-1", leaf(&["exited-1"]))])];

        resolve_workspaces(&mut workspaces, &conn).unwrap();

        assert_eq!(workspaces[0].pages[0].layout, leaf(&["fresh-a"]));
        let requests = captured.lock().unwrap();
        match &requests[1] {
            Request::CreateSession { cwd, workspace_path, .. } => {
                assert_eq!(cwd, "/Users/alice/project");
                assert_eq!(workspace_path, "/Users/alice/project");
            }
            other => panic!("expected the second request to be CreateSession, got {other:?}"),
        }
    }

    #[test]
    fn falls_back_to_home_only_when_the_id_has_no_registry_record_at_all() {
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![
            Response::SessionList { sessions: vec![] },
            Response::SessionCreated { id: "fresh-b".to_string() },
        ]);
        let conn = Mutex::new(client);
        let mut workspaces = vec![workspace("ws-1", vec![page("page-1", leaf(&["unknown-id"]))])];

        resolve_workspaces(&mut workspaces, &conn).unwrap();

        assert_eq!(workspaces[0].pages[0].layout, leaf(&["fresh-b"]));
        let requests = captured.lock().unwrap();
        let home = std::env::var("HOME").unwrap();
        match &requests[1] {
            Request::CreateSession { cwd, .. } => assert_eq!(cwd, &home),
            other => panic!("expected the second request to be CreateSession, got {other:?}"),
        }
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app/src-tauri && cargo test resolve_workspaces_tests`
Expected: FAIL to compile — `fake_daemon_capturing_requests` and `exited_session` don't exist yet.

- [ ] **Step 3: Implement**

Find:

```rust
fn resolve_sessions(
    node: &mut LayoutNode,
    command_conn: &Mutex<UnixStream>,
    valid_ids: &HashSet<String>,
) -> anyhow::Result<()> {
    match node {
        LayoutNode::Leaf { tabs, .. } => {
            for id in tabs.iter_mut() {
                if !valid_ids.contains(id.as_str()) {
                    *id = create_fresh_session(command_conn)?;
                }
            }
            Ok(())
        }
        LayoutNode::Split { children, .. } => {
            for child in children.iter_mut() {
                resolve_sessions(child, command_conn, valid_ids)?;
            }
            Ok(())
        }
    }
}

/// Fetches the full session list once and returns the set of ids that are
/// still alive (not exited). Called at most once per bootstrap, regardless
/// of how many pages/workspaces need reconciling against it.
fn list_valid_session_ids(command_conn: &Mutex<UnixStream>) -> anyhow::Result<HashSet<String>> {
    let resp = send_command(command_conn, &Request::ListSessions)?;
    match resp {
        Response::SessionList { sessions } => Ok(sessions
            .into_iter()
            .filter(|s| s.status != "exited")
            .map(|s| s.id)
            .collect()),
        other => anyhow::bail!("expected SessionList, got {other:?}"),
    }
}

/// Resolves every session id referenced by every page of every workspace
/// against the daemon's actual live sessions, replacing any that are stale
/// in place. An empty `workspaces` list -- nothing saved yet, or a config
/// from before this milestone -- is left untouched: no default workspace
/// or session is auto-created, and `ListSessions` isn't even called.
fn resolve_workspaces(
    workspaces: &mut [Workspace],
    command_conn: &Mutex<UnixStream>,
) -> anyhow::Result<()> {
    if workspaces.is_empty() {
        return Ok(());
    }
    let valid_ids = list_valid_session_ids(command_conn)?;
    for workspace in workspaces.iter_mut() {
        for page in workspace.pages.iter_mut() {
            resolve_sessions(&mut page.layout, command_conn, &valid_ids)?;
        }
    }
    Ok(())
}
```

Replace with:

```rust
fn resolve_sessions(
    node: &mut LayoutNode,
    command_conn: &Mutex<UnixStream>,
    all_sessions: &HashMap<String, protocol::SessionSummary>,
) -> anyhow::Result<()> {
    match node {
        LayoutNode::Leaf { tabs, .. } => {
            for id in tabs.iter_mut() {
                let is_valid = all_sessions.get(id.as_str()).is_some_and(|s| s.status != "exited");
                if !is_valid {
                    let last_known_cwd = all_sessions.get(id.as_str()).map(|s| s.cwd.as_str());
                    *id = create_fresh_session(command_conn, last_known_cwd)?;
                }
            }
            Ok(())
        }
        LayoutNode::Split { children, .. } => {
            for child in children.iter_mut() {
                resolve_sessions(child, command_conn, all_sessions)?;
            }
            Ok(())
        }
    }
}

/// Fetches the full session list once -- every record, exited ones
/// included -- keyed by id. Called at most once per bootstrap, regardless
/// of how many pages/workspaces need reconciling against it. Exited
/// records are kept (not filtered out here) so `resolve_sessions` can look
/// up an exited session's own last-known `cwd` before replacing it, rather
/// than falling back to `$HOME`.
fn list_valid_session_ids(
    command_conn: &Mutex<UnixStream>,
) -> anyhow::Result<HashMap<String, protocol::SessionSummary>> {
    let resp = send_command(command_conn, &Request::ListSessions)?;
    match resp {
        Response::SessionList { sessions } => {
            Ok(sessions.into_iter().map(|s| (s.id.clone(), s)).collect())
        }
        other => anyhow::bail!("expected SessionList, got {other:?}"),
    }
}

/// Resolves every session id referenced by every page of every workspace
/// against the daemon's actual live sessions, replacing any that are stale
/// in place. An empty `workspaces` list -- nothing saved yet, or a config
/// from before this milestone -- is left untouched: no default workspace
/// or session is auto-created, and `ListSessions` isn't even called.
fn resolve_workspaces(
    workspaces: &mut [Workspace],
    command_conn: &Mutex<UnixStream>,
) -> anyhow::Result<()> {
    if workspaces.is_empty() {
        return Ok(());
    }
    let all_sessions = list_valid_session_ids(command_conn)?;
    for workspace in workspaces.iter_mut() {
        for page in workspace.pages.iter_mut() {
            resolve_sessions(&mut page.layout, command_conn, &all_sessions)?;
        }
    }
    Ok(())
}
```

(`list_valid_session_ids` keeps its name despite no longer returning just "valid" ids — renaming it is optional polish, not required; if you rename it, update its one call site in `resolve_workspaces` too and keep the doc comment accurate either way.)

Remove `HashSet` from the top-of-file import (it's now unused everywhere in this file):

```rust
use std::collections::{HashMap, HashSet};
```

becomes:

```rust
use std::collections::HashMap;
```

Find:

```rust
fn create_fresh_session(command_conn: &Mutex<UnixStream>) -> anyhow::Result<String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let resp = send_command(
        command_conn,
        &Request::CreateSession {
            workspace_path: home.clone(),
            cwd: home,
            command: None,
        },
    )?;
    match resp {
        Response::SessionCreated { id } => Ok(id),
        other => anyhow::bail!("expected SessionCreated, got {other:?}"),
    }
}
```

Replace with:

```rust
fn create_fresh_session(command_conn: &Mutex<UnixStream>, cwd: Option<&str>) -> anyhow::Result<String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let target = cwd.map(str::to_string).unwrap_or(home);
    let resp = send_command(
        command_conn,
        &Request::CreateSession {
            workspace_path: target.clone(),
            cwd: target,
            command: None,
        },
    )?;
    match resp {
        Response::SessionCreated { id } => Ok(id),
        other => anyhow::bail!("expected SessionCreated, got {other:?}"),
    }
}
```

Find its other call site (the `create_session` Tauri command — a genuinely new session, e.g. from a split/new-tab action, has no "last-known cwd" of its own):

```rust
    let id = create_fresh_session(&command_state.0).map_err(|e| e.to_string())?;
```

Replace with:

```rust
    let id = create_fresh_session(&command_state.0, None).map_err(|e| e.to_string())?;
```

Add the new Tauri relay arm. Find:

```rust
                Response::GitStatusChanged { id, status } => {
                    let _ = reader_app_handle.emit("git-status-changed", (id, status));
                }
```

Replace with:

```rust
                Response::GitStatusChanged { id, status } => {
                    let _ = reader_app_handle.emit("git-status-changed", (id, status));
                }
                Response::SessionRestored { id } => {
                    let _ = reader_app_handle.emit("session-restored", id);
                }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p app`
Expected: PASS — all existing tests plus the 2 new ones in `resolve_workspaces_tests`.

- [ ] **Step 5: Run the full workspace build and tests**

Run: `cargo build && cargo test`
Expected: PASS, clean build, no unused-import warnings.

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/src/session.rs
git commit -m "fix(app): replace a stale session at its own last-known cwd, relay SessionRestored"
```

---

### Task 4: Frontend state — `restoredSessionIds`

**Files:**
- Modify: `app/src/lib/backend.ts`
- Modify: `app/src/lib/layoutState.ts`
- Test: `app/src/lib/layoutState.test.ts`

**Interfaces:**
- Consumes: the `"session-restored"` Tauri event (Task 3).
- Produces: `LayoutState.restoredSessionIds: Set<string>`, `handleSessionRestored(sessionId: string): void`, `clearRestoredMarker(sessionId: string): void` — consumed by Task 5 (`Pane.svelte` reads `$layoutState.restoredSessionIds`).

`backend.ts`'s `writeInput` is the one function every real input path in this app already funnels through (`terminalRegistry.ts`'s per-keystroke `term.onData` handler, and `clipboard.ts`'s paste action both call it directly) — so the clearing hook goes there, not into `terminalRegistry.ts` itself. `terminalRegistry.ts` is *not* touched by this task: `layoutState.ts` already imports it (for `destroyTerminal`), so having `terminalRegistry.ts` import `layoutState.ts` back would create a circular import — the same class of problem `notifications.ts`'s own doc comment already documents avoiding in this codebase. Routing the hook through `backend.ts` (which `layoutState.ts` already imports) sidesteps this entirely, and covers both real call sites (typed input and paste) through one choke point instead of two.

- [ ] **Step 1: Write the failing tests**

In `app/src/lib/layoutState.test.ts`, add `handleSessionRestored` and `clearRestoredMarker` to the existing `import { ... } from "./layoutState";` block, add `setOnWriteInputHook: vi.fn(),` to the existing `vi.mock("./backend", () => ({ ... }))` factory, add `restoredSessionIds: new Set(),` to both existing `layoutState.set({...})` object literals in `beforeEach` and the `setState` helper (mirroring the existing `gitStatusById: {},` line right above the closing brace in each), and add this test block after the existing `describe("handleGitStatusChanged", ...)` block:

```ts
describe("handleSessionRestored and clearRestoredMarker", () => {
  it("adds a session id when restored", () => {
    handleSessionRestored("a");
    expect(get(layoutState).restoredSessionIds.has("a")).toBe(true);
  });

  it("tracks independent sessions independently", () => {
    handleSessionRestored("a");
    handleSessionRestored("b");
    expect(get(layoutState).restoredSessionIds).toEqual(new Set(["a", "b"]));
  });

  it("adding the same id twice is idempotent", () => {
    handleSessionRestored("a");
    handleSessionRestored("a");
    expect(get(layoutState).restoredSessionIds).toEqual(new Set(["a"]));
  });

  it("clearRestoredMarker removes just that session's id", () => {
    handleSessionRestored("a");
    handleSessionRestored("b");
    clearRestoredMarker("a");
    expect(get(layoutState).restoredSessionIds).toEqual(new Set(["b"]));
  });

  it("clearRestoredMarker on a session that was never restored is a harmless no-op", () => {
    clearRestoredMarker("never-restored");
    expect(get(layoutState).restoredSessionIds).toEqual(new Set());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm test -- layoutState.test.ts`
Expected: FAIL — `handleSessionRestored`/`clearRestoredMarker` are not exported from `./layoutState`, and/or `restoredSessionIds` is missing from the state object literals.

- [ ] **Step 3: Implement**

In `app/src/lib/backend.ts`, find:

```ts
export function writeInput(sessionId: string, data: string): Promise<void> {
  return invoke("write_input", { sessionId, data });
}
```

Replace with:

```ts
// Set once by layoutState.ts's bootstrap() -- both real input paths in
// this app (terminalRegistry.ts's per-keystroke term.onData, and
// clipboard.ts's paste action) already call writeInput directly, so
// hooking in here is the one choke point that covers both without either
// of those modules needing to import layoutState.ts back (which would be
// circular, since layoutState.ts already imports terminalRegistry.ts).
let onWriteInput: ((sessionId: string) => void) | null = null;

export function setOnWriteInputHook(handler: (sessionId: string) => void): void {
  onWriteInput = handler;
}

export function writeInput(sessionId: string, data: string): Promise<void> {
  onWriteInput?.(sessionId);
  return invoke("write_input", { sessionId, data });
}
```

In `app/src/lib/layoutState.ts`, add `restoredSessionIds` to the `LayoutState` interface, right after `gitStatusById: Record<string, GitStatus | null>;`:

```ts
  restoredSessionIds: Set<string>;
```

Add it to `initialState`, right after `gitStatusById: {},`:

```ts
  restoredSessionIds: new Set(),
```

Add the listener registration inside `bootstrap()`, right after the existing `"git-status-changed"` listener block, and register the `backend.ts` hook right after the listener block (both still before the `getSessionNames`/`pollForStartupState` tail):

```ts
  unlisteners.push(
    await listen<string>("session-restored", (event) => {
      handleSessionRestored(event.payload);
    })
  );

  backend.setOnWriteInputHook((sessionId) => clearRestoredMarker(sessionId));
```

Add the two handler functions, right after `handleGitStatusChanged`:

```ts
// Shared by the "session-restored" event listener in bootstrap() and this
// file's own tests. Entries are added, never auto-removed by the passage
// of time -- clearRestoredMarker (below) is the only thing that removes
// one, driven by the user actually typing into (or pasting into) that
// specific session.
export function handleSessionRestored(sessionId: string): void {
  layoutState.update((s) => ({ ...s, restoredSessionIds: new Set(s.restoredSessionIds).add(sessionId) }));
}

// Called via backend.ts's writeInput hook on every single keystroke and
// paste across every session in the app -- checked against the current
// state BEFORE calling layoutState.update, so the overwhelmingly common
// case (a session that was never restored, or was already cleared) never
// triggers a store update or a new Set allocation at all.
export function clearRestoredMarker(sessionId: string): void {
  if (!get(layoutState).restoredSessionIds.has(sessionId)) return;
  layoutState.update((s) => {
    const next = new Set(s.restoredSessionIds);
    next.delete(sessionId);
    return { ...s, restoredSessionIds: next };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- layoutState.test.ts`
Expected: PASS — all existing tests plus the 5 new ones.

- [ ] **Step 5: Run the full frontend test suite and type-check**

Run: `npm test && npm run check`
Expected: PASS — no regressions in any other test file, no new TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/backend.ts app/src/lib/layoutState.ts app/src/lib/layoutState.test.ts
git commit -m "feat(app): track restoredSessionIds, clearing on the session's own first input"
```

---

### Task 5: `Pane.svelte` restored badge

**Files:**
- Modify: `app/src/lib/Pane.svelte`

**Interfaces:**
- Consumes: `$layoutState.restoredSessionIds` (Task 4).

- [ ] **Step 1: Add the icon import and render the badge**

In `app/src/lib/Pane.svelte`, find:

```svelte
  import { X, Plus } from "@lucide/svelte";
```

Replace with:

```svelte
  import { X, Plus, RotateCw } from "@lucide/svelte";
```

Find this block inside the `{#each leaf.tabs as sessionId, tabIndex (sessionId)}` loop:

```svelte
        {#if tabGitDot(sessionId)}
          {@const gitDot = tabGitDot(sessionId)}
          <span
            class="git-dot"
            class:dirty={gitDot?.dirty}
            class:clean={!gitDot?.dirty}
            title={gitDot?.dirty ? "Uncommitted changes" : "Clean"}
          ></span>
        {/if}
```

Replace with (adding the restored badge immediately after, inside the same conditional structure):

```svelte
        {#if tabGitDot(sessionId)}
          {@const gitDot = tabGitDot(sessionId)}
          <span
            class="git-dot"
            class:dirty={gitDot?.dirty}
            class:clean={!gitDot?.dirty}
            title={gitDot?.dirty ? "Uncommitted changes" : "Clean"}
          ></span>
        {/if}
        {#if $layoutState.restoredSessionIds.has(sessionId)}
          <span
            class="restored-badge"
            title="This session's shell was freshly restarted after the daemon restarted"
          >
            <RotateCw size={10} />
          </span>
        {/if}
```

- [ ] **Step 2: Add the CSS**

Add this to the `<style>` block, right after the existing `.git-dot.clean` rule:

```css
  .restored-badge {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    color: #8bc98b;
  }
```

- [ ] **Step 3: Type-check and run the full frontend test suite**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm run check && npm test`
Expected: PASS — `Pane.svelte` has no dedicated test file (pure rendering, matching this project's established precedent for every prior tab-dot-style feature), so this step just confirms no regressions and no type errors.

- [ ] **Step 4: Run the full workspace build (Rust + frontend) one final time**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin && cargo build && cargo test && cd app && npm run check && npm test`
Expected: PASS across the board — this is the last task, so this is the final whole-stack sanity check before the plan's own final review.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/Pane.svelte
git commit -m "feat(app): render the restored-after-restart badge on a pane's tab"
```

---

## Not covered by this plan (deliberately, per the design spec)

- Any rich inline "exited" banner UI — sessions continue to just silently close their tab on any exit, restore-failures included.
- The original spec's "workspace path missing/moved" handling — moot, Workspaces are no longer directory-bound.
- True PTY reattachment across a daemon restart — a physical constraint, not a design choice.
- `kill_session`'s pre-existing `output_buffers` leak — a separate, unrelated Milestone-A-era issue.
- OS notifications for the restored marker.
