# Terminal Core Refinements — Plan 2: Tab Naming via Live cwd Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tab labels show the session's live working directory (the folder name, truncated, full path on hover) instead of a session-id fragment — updating as the user `cd`s around, via OSC 7 shell-integration escape sequences.

**Architecture:** The daemon's existing per-session PTY-output relay thread gains a small, purpose-built byte scanner that watches (without altering) the output stream for OSC 7 sequences, updating the already-existing `cwd` field on a session's registry record and emitting a new `CwdChanged` event whenever it finds one — including once, synthetically, immediately on every `Attach` (both at startup and for a freshly created session), so the frontend gets an instant baseline without a new query command. The Tauri backend relays this as a `"cwd-changed"` event, same convention as `pty-output`/`session-exited`. The frontend accumulates these into a `cwdBySessionId` map on `layoutState`, and `Pane.svelte`'s tab label reads it, showing the last path segment (CSS-truncated) wrapped in a new custom `Tooltip.svelte` component that reveals the full path on hover.

**Tech Stack:** Rust (daemon), no new dependencies — the OSC 7 payload's percent-decoding is hand-rolled rather than pulling in a crate for ~10 lines of logic. Svelte 5 (frontend), no new dependencies.

## Global Constraints

- **OSC 7 wire format**: `ESC ]7;file://<hostname><path>` terminated by either `BEL` (`\x07`) or `ST` (`ESC \`, i.e. `\x1b\x5c`). The scanner extracts everything from the first `/` after `file://` onward (skipping the hostname, which this project never validates against — a cwd report from any hostname is trusted) and percent-decodes it.
- **The scanner never strips or alters PTY output** — every byte read from the PTY, OSC 7 sequences included, is still forwarded to the frontend/xterm.js exactly as today. Real terminal emulators (xterm.js included) already silently consume unrecognized OSC sequences rather than rendering their raw bytes, so this requires no new handling on the frontend.
- **`SessionSummary`/the registry's `cwd: String` field is reused, not replaced** — it already exists (set once, at session-creation time, since Milestone A). This plan makes it live (updated whenever the scanner finds a new value) rather than adding a new column/field.
- **`Response::CwdChanged { id: String, cwd: String }`** is a new protocol variant, emitted per-session exactly like `Output`/`SessionExited` already are.
- **Baseline-on-Attach**: the daemon sends one `CwdChanged` for a session's *current* known cwd (whatever's already in the registry — launch directory or a previously-seen OSC 7 value) immediately whenever it processes an `Attach` request for that session, *before* scrollback replay. This is the *only* way the frontend learns a session's cwd at startup — there is deliberately no separate query command, since every session the frontend ever knows about was necessarily `Attach`ed to get there (both at launch, for the whole resolved tree, and on-demand, since `create_session` already sends its own `Attach` per an earlier plan's fix).
- **No cwd polling fallback** — if a session's shell never emits OSC 7 (unconfigured shell), its tab simply keeps showing its launch directory (today, always `$HOME`) or, in the empty-map case before the very first baseline event arrives, the existing session-id-fragment fallback. This is an accepted, explicit tradeoff — not a bug to work around in this plan.
- **`cwdBySessionId` entries are never cleaned up** when a session closes — an in-memory map entry per session that ever existed in one app run is not a meaningful memory concern at this app's realistic session counts, and cleanup would be needless complexity. Do not add removal logic.
- **The tab's full-path tooltip is a custom-built component** (`Tooltip.svelte`), not the native `title=` attribute — a from-scratch hover panel with a short delay, distinct from the plain `title=` attributes an earlier plan already added to icon-only toolbar buttons (that usage is fine and unrelated; this one specifically needs to be a real UI element per the design spec).
- **GUI behavior has no automated coverage** in the agent environment (no synthetic-input capability) — this is a documented, standing limitation of every Svelte-component task in this project so far. `npm run check`/`npm run build` are the automated floor for frontend tasks touching `.svelte` files. Rust-side daemon behavior (the scanner, the registry, the socket-level integration) *does* get real automated coverage — this project has consistently held Rust/daemon code to "spawn a real daemon, real sockets, no mocks" discipline, and this plan follows that.
- Work happens directly on `main` (no worktree) — an explicit, standing preference for every plan in this project so far.

---

### Task 1: OSC 7 byte scanner (pure, daemon-side)

**Files:**
- Create: `crates/daemon/src/osc.rs`
- Modify: `crates/daemon/src/main.rs` (add `mod osc;`)

**Interfaces:**
- Produces: `OscCwdScanner::new() -> Self`, `OscCwdScanner::feed(&mut self, bytes: &[u8]) -> Vec<String>` — returns every cwd path successfully parsed out of a complete OSC 7 sequence found across this and prior `feed()` calls (state persists between calls, so a sequence split across two PTY reads is still found). Consumed by Task 3's `spawn_pump` wiring.

This is the highest-risk correctness surface in this plan — it parses arbitrary, continuously-arriving PTY output byte-by-byte with state that must survive being split at any boundary. Treat it with the same rigor Milestone A's UTF-8-chunking logic in `server.rs` already gets — this task's tests specifically probe every possible split point, not just the happy path.

- [ ] **Step 1: Write the failing tests**

Create `crates/daemon/src/osc.rs` with just this test module first (the implementation comes in Step 3):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn osc7(path: &str) -> Vec<u8> {
        let mut bytes = b"\x1b]7;file://host".to_vec();
        bytes.extend_from_slice(path.as_bytes());
        bytes.push(0x07);
        bytes
    }

    #[test]
    fn parses_a_whole_sequence_fed_in_one_chunk() {
        let mut scanner = OscCwdScanner::new();
        let result = scanner.feed(&osc7("/Users/alice/project"));
        assert_eq!(result, vec!["/Users/alice/project".to_string()]);
    }

    #[test]
    fn parses_a_sequence_split_at_every_byte_boundary() {
        let full = osc7("/Users/alice/project");
        for split_at in 0..=full.len() {
            let mut scanner = OscCwdScanner::new();
            let mut found = scanner.feed(&full[..split_at]);
            found.extend(scanner.feed(&full[split_at..]));
            assert_eq!(
                found,
                vec!["/Users/alice/project".to_string()],
                "failed when split at byte {split_at}"
            );
        }
    }

    #[test]
    fn ignores_bytes_before_and_after_the_sequence() {
        let mut scanner = OscCwdScanner::new();
        let mut bytes = b"some shell output before\r\n".to_vec();
        bytes.extend(osc7("/tmp"));
        bytes.extend_from_slice(b"more output after\r\n");
        let result = scanner.feed(&bytes);
        assert_eq!(result, vec!["/tmp".to_string()]);
    }

    #[test]
    fn supports_st_terminator_as_well_as_bel() {
        let mut scanner = OscCwdScanner::new();
        let mut bytes = b"\x1b]7;file://host/tmp".to_vec();
        bytes.extend_from_slice(b"\x1b\\"); // ST terminator
        let result = scanner.feed(&bytes);
        assert_eq!(result, vec!["/tmp".to_string()]);
    }

    #[test]
    fn recovers_from_an_esc_inside_the_payload_that_is_not_actually_st() {
        // A lone ESC not followed by backslash must be treated as ordinary
        // payload content, not misinterpreted as the start of a terminator
        // -- the scanner should still find the real BEL that follows.
        let mut scanner = OscCwdScanner::new();
        let mut bytes = b"\x1b]7;file://host/tmp".to_vec();
        bytes.push(0x1b); // a stray ESC that is NOT followed by '\'
        bytes.extend_from_slice(b"x");
        bytes.push(0x07); // the real terminator
        let result = scanner.feed(&bytes);
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn decodes_percent_encoded_characters_in_the_path() {
        let mut scanner = OscCwdScanner::new();
        let result = scanner.feed(&osc7("/Users/alice/my%20project"));
        assert_eq!(result, vec!["/Users/alice/my project".to_string()]);
    }

    #[test]
    fn finds_multiple_sequences_across_separate_feed_calls() {
        let mut scanner = OscCwdScanner::new();
        let first = scanner.feed(&osc7("/tmp/a"));
        let second = scanner.feed(&osc7("/tmp/b"));
        assert_eq!(first, vec!["/tmp/a".to_string()]);
        assert_eq!(second, vec!["/tmp/b".to_string()]);
    }

    #[test]
    fn abandons_a_sequence_that_never_terminates_without_growing_forever() {
        let mut scanner = OscCwdScanner::new();
        let mut huge = b"\x1b]7;file://host/".to_vec();
        huge.extend(std::iter::repeat(b'a').take(10_000));
        let result = scanner.feed(&huge);
        assert!(result.is_empty());
        // The scanner must have recovered to idle and be ready to find a
        // fresh, well-formed sequence afterward -- not stuck.
        let result2 = scanner.feed(&osc7("/tmp/recovered"));
        assert_eq!(result2, vec!["/tmp/recovered".to_string()]);
    }

    #[test]
    fn ignores_a_payload_that_does_not_look_like_a_file_uri() {
        let mut scanner = OscCwdScanner::new();
        let mut bytes = b"\x1b]7;not-a-file-uri".to_vec();
        bytes.push(0x07);
        let result = scanner.feed(&bytes);
        assert!(result.is_empty());
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd crates/daemon && cargo test osc::`
Expected: FAIL to compile — `OscCwdScanner` doesn't exist yet.

- [ ] **Step 3: Implement `OscCwdScanner`**

Add this above the test module in `crates/daemon/src/osc.rs`:

```rust
const OSC7_PREFIX: &[u8] = b"\x1b]7;";
const MAX_PAYLOAD_LEN: usize = 4096;

/// Watches a stream of raw PTY output bytes for OSC 7 sequences
/// (`ESC ]7;file://<host><path>` terminated by BEL or ST), which shell
/// prompts can be configured to emit on every new prompt to report the
/// shell's current working directory. Never mutates or strips the bytes
/// it's fed -- callers forward the original stream unchanged; this only
/// watches. State is carried across `feed()` calls so a sequence split
/// across separate PTY reads (which don't align with escape-sequence
/// boundaries) is still found correctly.
pub struct OscCwdScanner {
    state: ScanState,
}

enum ScanState {
    /// Not currently inside anything resembling an OSC 7 sequence.
    Idle,
    /// Matched the first `matched` bytes of OSC7_PREFIX so far.
    MatchingPrefix { matched: usize },
    /// Inside the OSC 7 payload (the `file://...` URI), accumulating bytes
    /// until a BEL or ST (ESC \) terminator. `saw_esc` tracks whether the
    /// immediately preceding byte was an ESC that might be the start of ST.
    ReadingPayload { payload: Vec<u8>, saw_esc: bool },
}

impl OscCwdScanner {
    pub fn new() -> Self {
        Self { state: ScanState::Idle }
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut found = Vec::new();
        for &b in bytes {
            match &mut self.state {
                ScanState::Idle => {
                    if b == OSC7_PREFIX[0] {
                        self.state = ScanState::MatchingPrefix { matched: 1 };
                    }
                }
                ScanState::MatchingPrefix { matched } => {
                    if b == OSC7_PREFIX[*matched] {
                        *matched += 1;
                        if *matched == OSC7_PREFIX.len() {
                            self.state = ScanState::ReadingPayload { payload: Vec::new(), saw_esc: false };
                        }
                    } else if b == OSC7_PREFIX[0] {
                        self.state = ScanState::MatchingPrefix { matched: 1 };
                    } else {
                        self.state = ScanState::Idle;
                    }
                }
                ScanState::ReadingPayload { payload, saw_esc } => {
                    if *saw_esc {
                        if b == b'\\' {
                            if let Some(path) = Self::parse_payload(payload) {
                                found.push(path);
                            }
                            self.state = ScanState::Idle;
                        } else {
                            // The prior ESC wasn't actually a terminator --
                            // keep it as ordinary payload content and
                            // process this byte normally.
                            payload.push(0x1b);
                            *saw_esc = false;
                            if b == 0x07 {
                                if let Some(path) = Self::parse_payload(payload) {
                                    found.push(path);
                                }
                                self.state = ScanState::Idle;
                            } else if b == 0x1b {
                                *saw_esc = true;
                            } else if payload.len() >= MAX_PAYLOAD_LEN {
                                self.state = ScanState::Idle;
                            } else {
                                payload.push(b);
                            }
                        }
                    } else if b == 0x07 {
                        if let Some(path) = Self::parse_payload(payload) {
                            found.push(path);
                        }
                        self.state = ScanState::Idle;
                    } else if b == 0x1b {
                        *saw_esc = true;
                    } else if payload.len() >= MAX_PAYLOAD_LEN {
                        self.state = ScanState::Idle;
                    } else {
                        payload.push(b);
                    }
                }
            }
        }
        found
    }

    fn parse_payload(payload: &[u8]) -> Option<String> {
        let text = std::str::from_utf8(payload).ok()?;
        let without_scheme = text.strip_prefix("file://")?;
        let path_start = without_scheme.find('/')?;
        Some(percent_decode(&without_scheme[path_start..]))
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
```

- [ ] **Step 4: Register the module**

Open `crates/daemon/src/main.rs`. Add `mod osc;` alongside the existing `mod pty; mod registry; mod server;` lines at the top of the file (the module isn't used anywhere yet — that's Task 3 — so expect an `unused` warning until then; that's fine, don't add `#[allow(dead_code)]` or similar, just proceed).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd crates/daemon && cargo test osc::`
Expected: PASS — all 9 tests green, including the full-boundary-split test running the scanner from scratch at every split point in the sequence.

- [ ] **Step 6: Commit**

```bash
git add crates/daemon/src/osc.rs crates/daemon/src/main.rs
git commit -m "feat(daemon): add OSC 7 cwd-tracking byte scanner"
```

---

### Task 2: Protocol variant + registry plumbing

**Files:**
- Modify: `crates/protocol/src/lib.rs`
- Modify: `crates/daemon/src/registry.rs`

**Interfaces:**
- Produces: `Response::CwdChanged { id: String, cwd: String }` (new `Response` variant); `Registry::update_cwd(&self, id: &str, cwd: &str) -> anyhow::Result<()>`; `Registry::get(&self, id: &str) -> anyhow::Result<Option<SessionRecord>>`. Both consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Open `crates/protocol/src/lib.rs`. Add this test to the existing `#[cfg(test)] mod tests` block at the bottom of the file, alongside `response_roundtrips_through_json_line`:

```rust
    #[test]
    fn cwd_changed_response_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let resp = Response::CwdChanged {
            id: "s1".to_string(),
            cwd: "/Users/alice/project".to_string(),
        };
        write_message(&mut buf, &resp).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Response = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Response::CwdChanged { id, cwd } => {
                assert_eq!(id, "s1");
                assert_eq!(cwd, "/Users/alice/project");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd crates/protocol && cargo test cwd_changed`
Expected: FAIL to compile — `Response::CwdChanged` doesn't exist yet.

- [ ] **Step 3: Add the protocol variant**

Add `CwdChanged` to the `Response` enum, alongside `Output`/`SessionExited`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Response {
    SessionCreated { id: String },
    SessionList { sessions: Vec<SessionSummary> },
    Output { id: String, data: String },
    SessionExited { id: String, exit_code: i32 },
    CwdChanged { id: String, cwd: String },
    Ok,
    Error { message: String },
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd crates/protocol && cargo test cwd_changed`
Expected: PASS.

- [ ] **Step 5: Write the failing registry tests**

Open `crates/daemon/src/registry.rs`. Add these two tests to the existing `#[cfg(test)] mod tests` block, alongside `update_status_persists`:

```rust
    #[test]
    fn update_cwd_persists() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();

        registry.update_cwd("s1", "/Users/alice/new-project").unwrap();

        let sessions = registry.list().unwrap();
        assert_eq!(sessions[0].cwd, "/Users/alice/new-project");
    }

    #[test]
    fn get_returns_the_matching_record_or_none() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();

        let found = registry.get("s1").unwrap();
        assert_eq!(found.map(|r| r.id), Some("s1".to_string()));

        let missing = registry.get("does-not-exist").unwrap();
        assert!(missing.is_none());
    }
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `cd crates/daemon && cargo test registry::`
Expected: FAIL to compile — `update_cwd`/`get` don't exist on `Registry` yet.

- [ ] **Step 7: Implement `update_cwd` and `get`**

Add to `impl Registry` in `crates/daemon/src/registry.rs`, alongside `update_status`/`list`:

```rust
    pub fn update_cwd(&self, id: &str, cwd: &str) -> anyhow::Result<()> {
        self.conn.execute(
            "UPDATE sessions SET cwd = ?1 WHERE id = ?2",
            params![cwd, id],
        )?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> anyhow::Result<Option<SessionRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_path, cwd, command, status, restored FROM sessions WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], |row| {
            let status_str: String = row.get(4)?;
            let restored: i64 = row.get(5)?;
            Ok(SessionRecord {
                id: row.get(0)?,
                workspace_path: row.get(1)?,
                cwd: row.get(2)?,
                command: row.get(3)?,
                status: SessionStatus::from_str(&status_str),
                restored: restored != 0,
            })
        })?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd crates/daemon && cargo test registry::`
Expected: PASS — all registry tests green, including the 2 new ones.

- [ ] **Step 9: Commit**

```bash
git add crates/protocol/src/lib.rs crates/daemon/src/registry.rs
git commit -m "feat(protocol,daemon): add CwdChanged response + registry cwd plumbing"
```

---

### Task 3: Wire the scanner into the daemon's relay loop + Attach baseline

**Files:**
- Modify: `crates/daemon/src/server.rs`

**Interfaces:**
- Consumes: Task 1's `OscCwdScanner`; Task 2's `Response::CwdChanged`, `Registry::update_cwd`, `Registry::get`.
- Produces: nothing new consumed by later tasks — this is the daemon-side integration point; Task 4 relays what this task emits, but does so by matching on the already-existing `Response::CwdChanged` variant, not by calling anything from this file directly.

This task has no isolated unit tests of its own (the logic being added is either already covered by Task 1's scanner tests or is genuine socket/thread integration) — verification is the 2 new integration tests below, which spawn a real daemon over a real Unix socket exactly like this file's existing test module already does (no mocks, matching this project's established daemon-testing discipline).

- [ ] **Step 1: Write the failing integration tests**

Open `crates/daemon/src/server.rs`. Add these two tests to the existing `#[cfg(test)] mod tests` block, following the exact pattern of the file's existing `attach_from_a_new_connection_streams_output_of_an_existing_session` test (same `start_test_server()`/`request()` helpers, same style):

```rust
    #[test]
    fn attach_sends_a_baseline_cwd_changed_with_the_launch_directory() {
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

        let mut reader = BufReader::new(stream2.try_clone().unwrap());
        let resp: Response = read_message(&mut reader).unwrap().unwrap();
        match resp {
            Response::CwdChanged { id: rid, cwd } => {
                assert_eq!(rid, id);
                assert_eq!(cwd, "/tmp");
            }
            other => panic!("expected CwdChanged as the first message after Attach, got {other:?}"),
        }
    }

    #[test]
    fn attach_relays_cwd_changed_when_pty_output_contains_osc7() {
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
                data: "printf '\\033]7;file://host/tmp/from-osc7\\007'\n".to_string(),
            },
        )
        .unwrap();

        let mut reader = BufReader::new(stream2.try_clone().unwrap());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut found = false;
        while std::time::Instant::now() < deadline {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::CwdChanged { id: rid, cwd } = resp {
                if rid == id && cwd == "/tmp/from-osc7" {
                    found = true;
                    break;
                }
            }
        }
        assert!(found, "never saw the expected CwdChanged for the printf'd OSC 7 sequence");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd crates/daemon && cargo test cwd_changed`
Expected: FAIL — `attach_sends_a_baseline_cwd_changed_...` fails because `attach()` doesn't send anything yet; `attach_relays_cwd_changed_when_pty_output_contains_osc7` times out (`assert!(found, ...)` fails) because nothing scans for OSC 7 yet.

- [ ] **Step 3: Send the baseline `CwdChanged` on Attach**

Open `crates/daemon/src/server.rs`. Add `use crate::osc::OscCwdScanner;` to the top-of-file imports, alongside the existing `use crate::pty::PtySession;`/`use crate::registry::{...}` lines.

In `SessionManager::attach`, add the baseline send as the very first thing the method does, before the existing scrollback-replay logic:

```rust
    pub fn attach(self: &Arc<Self>, id: &str, writer: Arc<Mutex<UnixStream>>) {
        // Send the session's current known cwd immediately, before anything
        // else -- this gives a fresh Attach's frontend an instant baseline
        // (launch directory, or the last OSC-7-reported directory) without
        // needing a separate query command; live updates arrive the same
        // way, via the same CwdChanged variant, as OSC 7 sequences are seen.
        if let Ok(Some(record)) = self.registry.lock().unwrap().get(id) {
            let _ = write_message(
                &mut *writer.lock().unwrap(),
                &Response::CwdChanged { id: id.to_string(), cwd: record.cwd },
            );
        }

        // Replay buffered output BEFORE registering the writer, so a
        // concurrently-running pump thread (this session may already be
        // attached elsewhere) can't interleave live output ahead of history.
        let buffered: Vec<u8> = {
```

(Everything from `// Replay buffered output...` onward is the method's existing body, unchanged — only the new block above it is added.)

- [ ] **Step 4: Wire the scanner into `spawn_pump`'s read loop**

In `spawn_pump`, add a scanner instance right before the `loop { match reader.read(&mut buf) { ... } }` loop starts (near the existing `let mut pending: Vec<u8> = Vec::new();` line):

```rust
            let mut buf = [0u8; 4096];
            let mut pending: Vec<u8> = Vec::new();
            let mut osc_scanner = OscCwdScanner::new();
```

Inside the `Ok(n) => { ... }` match arm, right after the existing scrollback-buffer block (the one that does `buffers.entry(id.clone())...ring.pop_front();`) and before the `pending.extend_from_slice(&buf[..n]);` line, add:

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

(This scans the raw bytes just read — independent of the existing UTF-8 chunking logic just below it, which operates on the same `buf[..n]` for a different purpose. The OSC 7 sequence is always ASCII, so scanning raw bytes here doesn't need to wait for UTF-8 boundary resolution.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd crates/daemon && cargo test cwd_changed`
Expected: PASS — both new tests green.

Run: `cd crates/daemon && cargo test`
Expected: PASS — full daemon test suite green, no regressions in the existing Attach/output-relay tests.

- [ ] **Step 6: Commit**

```bash
git add crates/daemon/src/server.rs
git commit -m "feat(daemon): scan PTY output for OSC 7 cwd updates, send baseline on Attach"
```

---

### Task 4: Tauri backend event relay

**Files:**
- Modify: `app/src-tauri/src/session.rs`

**Interfaces:**
- Consumes: `Response::CwdChanged` (Task 2, already shipped in the daemon by Task 3).
- Produces: a new Tauri event, `"cwd-changed"`, payload `(id: String, cwd: String)` — same tuple-payload convention as the existing `"pty-output"`/`"session-exited"` events. Consumed by Task 6's frontend listener.

There is no new automated test for this task — it's a one-arm addition to an already-tested event-relay match block, mirroring the existing `Output`/`SessionExited` arms exactly; verification is `cargo build`/`cargo test` (no regressions) plus a careful manual trace, the same treatment this project gave analogous one-line relay additions before.

- [ ] **Step 1: Add the relay arm**

Open `app/src-tauri/src/session.rs`. Find the `match resp { ... }` block inside `bootstrap`'s background reader thread (it has arms for `Response::Output`, `Response::SessionExited`, `Response::Error`, and a catch-all `_ => {}`). Add a `Response::CwdChanged` arm before the catch-all:

```rust
            match resp {
                Response::Output { id, data } => {
                    let _ = reader_app_handle.emit("pty-output", (id, data));
                }
                Response::SessionExited { id, exit_code } => {
                    let _ = reader_app_handle.emit("session-exited", (id, exit_code));
                }
                Response::CwdChanged { id, cwd } => {
                    let _ = reader_app_handle.emit("cwd-changed", (id, cwd));
                }
                Response::Error { message } => {
                    let _ = reader_app_handle.emit("daemon-error", message);
                }
                _ => {}
            }
```

- [ ] **Step 2: Verify**

Run: `cd app/src-tauri && cargo build`
Expected: builds cleanly (this also picks up Tasks 1-3's daemon-side changes, since `app` depends on the `protocol` crate which now has the `CwdChanged` variant — confirm no `match` exhaustiveness warnings anywhere else in this file, since Rust would flag any other unmatched-variant `match` on `Response` if one exists elsewhere in the codebase; there shouldn't be one, but check).

Run: `cd app/src-tauri && cargo test`
Expected: PASS — full existing test suite green.

- [ ] **Step 3: Commit**

```bash
git add app/src-tauri/src/session.rs
git commit -m "feat(app): relay CwdChanged as a cwd-changed Tauri event"
```

---

### Task 5: `Tooltip.svelte` — standalone hover-tooltip component

**Files:**
- Create: `app/src/lib/Tooltip.svelte`

**Interfaces:**
- Produces: `Tooltip.svelte` component, props `{ text: string; children: Snippet }` — wraps arbitrary trigger content, shows a floating panel with `text` after a short hover delay. Zero dependency on this plan's other pieces (no `layoutState`, no cwd-tracking anywhere in this file) — reusable anywhere a custom hover tooltip is needed. Consumed by Task 7's `Pane.svelte` integration.

- [ ] **Step 1: Implement `Tooltip.svelte`**

Create `app/src/lib/Tooltip.svelte`:

```svelte
<script lang="ts">
  import type { Snippet } from "svelte";

  let { text, children }: { text: string; children: Snippet } = $props();

  let visible = $state(false);
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const HOVER_DELAY_MS = 400;

  function handleMouseEnter(): void {
    timeoutId = setTimeout(() => {
      visible = true;
    }, HOVER_DELAY_MS);
  }

  function handleMouseLeave(): void {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    visible = false;
  }
</script>

<span class="tooltip-wrapper" onmouseenter={handleMouseEnter} onmouseleave={handleMouseLeave}>
  {@render children()}
  {#if visible}
    <span class="tooltip-bubble">{text}</span>
  {/if}
</span>

<style>
  .tooltip-wrapper {
    position: relative;
    display: inline-flex;
    min-width: 0;
  }
  .tooltip-bubble {
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-bottom: 4px;
    padding: 4px 8px;
    background: #000;
    color: #fff;
    font-size: 0.75em;
    font-family: monospace;
    white-space: nowrap;
    border-radius: 4px;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
    pointer-events: none;
    z-index: 100;
  }
</style>
```

(`min-width: 0` on `.tooltip-wrapper` matters when it wraps a truncating child — without it, an `inline-flex` container can refuse to shrink below its content's natural width, defeating the child's own `text-overflow: ellipsis`. Task 7's usage relies on this.)

- [ ] **Step 2: Verify**

Run: `cd app && npm run check`
Expected: no type errors.

Run: `cd app && npm run build`
Expected: builds cleanly.

No automated GUI test exists for this task (per Global Constraints) — this component isn't reachable in the running app until Task 7 uses it. Note in your report that hover-delay timing, positioning, and visual appearance are unverified pending a human at the keyboard.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/Tooltip.svelte
git commit -m "feat(app): add standalone Tooltip component"
```

---

### Task 6: `layoutState.ts`'s `cwdBySessionId` + `cwd-changed` listener

**Files:**
- Modify: `app/src/lib/layoutState.ts`
- Modify: `app/src/lib/layoutState.test.ts`
- Modify: `app/src/lib/confirmClose.test.ts`

**Interfaces:**
- Produces: `LayoutState.cwdBySessionId: Record<string, string>` (new field on the existing state shape); `handleCwdChanged(sessionId: string, cwd: string): void` (new exported action, mirrors `handleSessionExited`'s existing pattern of being both the event listener's callback AND independently unit-testable). Consumed by Task 7's `Pane.svelte`.

**Important — this is a breaking change to an existing, shared type.** `LayoutState` gains a new *required* field, so every place in the codebase that currently constructs a full `LayoutState` object literal (not via the `...s` spread pattern most actions already use) needs that literal updated, or `npm run check` will fail with a missing-property error. Two test files do this: `layoutState.test.ts`'s `beforeEach`/state-setup helper, and `confirmClose.test.ts`'s `setTree` helper (from an earlier plan). Both need `cwdBySessionId: {}` added to their literal(s) — this step is not optional polish, it's required for the build to pass.

- [ ] **Step 1: Write the failing tests**

Open `app/src/lib/layoutState.test.ts`. Add `handleCwdChanged` to the existing named-import list (alongside `handleSessionExited`, etc.). Update every full `LayoutState` object literal in this file's `beforeEach`/helper functions to include `cwdBySessionId: {}` (find every place a full state object is constructed with `status`/`errorMessage`/`tree`/`focusedSessionId` all listed out — those need the new field added too; places that only ever `.update((s) => ({ ...s, ... }))` don't, since the spread already carries it forward).

Add this `describe` block:

```typescript
describe("handleCwdChanged", () => {
  it("records the cwd for a session", () => {
    layoutState.set({
      status: "ready",
      errorMessage: "",
      tree: null,
      focusedSessionId: null,
      cwdBySessionId: {},
    });
    handleCwdChanged("a", "/Users/alice/project");
    expect(get(layoutState).cwdBySessionId).toEqual({ a: "/Users/alice/project" });
  });

  it("updates an existing session's cwd without disturbing others", () => {
    layoutState.set({
      status: "ready",
      errorMessage: "",
      tree: null,
      focusedSessionId: null,
      cwdBySessionId: { a: "/old/path", b: "/other/path" },
    });
    handleCwdChanged("a", "/new/path");
    expect(get(layoutState).cwdBySessionId).toEqual({ a: "/new/path", b: "/other/path" });
  });
});
```

Open `app/src/lib/confirmClose.test.ts`. Find its `setTree` helper (constructs a full `LayoutState` via `layoutState.set({...})`) and add `cwdBySessionId: {}` to the literal it builds.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npm test`
Expected: FAIL — `handleCwdChanged` isn't exported yet, and (separately) `npm run check` would also fail on the two now-incomplete `LayoutState` literals until Step 3 adds the field to the type and Step 1's edits above add it to both test files' literals. If your editor/TS server flags the test file literals as errors before you've finished this step, that's expected and will resolve once Step 3 lands.

- [ ] **Step 3: Implement `cwdBySessionId` and `handleCwdChanged`**

Open `app/src/lib/layoutState.ts`. Update the `LayoutState` interface and `initialState`:

```typescript
export interface LayoutState {
  status: "connecting" | "ready" | "error";
  errorMessage: string;
  tree: LayoutNode | null;
  focusedSessionId: string | null;
  cwdBySessionId: Record<string, string>;
}

const initialState: LayoutState = {
  status: "connecting",
  errorMessage: "",
  tree: null,
  focusedSessionId: null,
  cwdBySessionId: {},
};
```

Add this function anywhere among the other exported actions (e.g. right after `handleSessionExited`):

```typescript
// Shared by the "cwd-changed" event listener in bootstrap() and this
// file's own tests -- mirrors handleSessionExited's pattern of being both
// an event callback and independently testable. Entries are never removed
// when a session closes; a stale in-memory map entry per session that ever
// existed in one app run is not a meaningful memory concern.
export function handleCwdChanged(sessionId: string, cwd: string): void {
  layoutState.update((s) => ({ ...s, cwdBySessionId: { ...s.cwdBySessionId, [sessionId]: cwd } }));
}
```

In `bootstrap()`, add a fourth listener alongside the existing three (`layout-ready`/`session-exited`/`daemon-error`):

```typescript
  unlisteners.push(
    await listen<[string, string]>("cwd-changed", (event) => {
      handleCwdChanged(event.payload[0], event.payload[1]);
    })
  );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && npm run check`
Expected: no type errors — confirms both test files' `LayoutState` literals are complete.

Run: `cd app && npm test`
Expected: PASS — full suite green, including the 2 new `handleCwdChanged` tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/layoutState.ts app/src/lib/layoutState.test.ts app/src/lib/confirmClose.test.ts
git commit -m "feat(app): track live session cwd via a new cwd-changed listener"
```

---

### Task 7: `folderName` helper + `Pane.svelte` tab-label integration

**Files:**
- Create: `app/src/lib/paths.ts`
- Create: `app/src/lib/paths.test.ts`
- Modify: `app/src/lib/Pane.svelte`

**Interfaces:**
- Consumes: `layoutState.ts`'s `cwdBySessionId` (Task 6, read-only via `$layoutState`); `Tooltip.svelte` (Task 5).
- Produces: `folderName(cwd: string): string` (pure, tested). Nothing here is consumed by any later task — this is the last task in this plan.

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/paths.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { folderName } from "./paths";

describe("folderName", () => {
  it("returns the last path segment", () => {
    expect(folderName("/Users/alice/my-project")).toBe("my-project");
  });

  it("handles a trailing slash", () => {
    expect(folderName("/Users/alice/my-project/")).toBe("my-project");
  });

  it("returns the path itself when given just the root", () => {
    expect(folderName("/")).toBe("/");
  });

  it("handles a single-segment path", () => {
    expect(folderName("/tmp")).toBe("tmp");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npm test`
Expected: FAIL — `paths.ts` doesn't exist yet.

- [ ] **Step 3: Implement `folderName`**

Create `app/src/lib/paths.ts`:

```typescript
export function folderName(cwd: string): string {
  const segments = cwd.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : cwd;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && npm test`
Expected: PASS — all tests in `paths.test.ts` green, plus the full existing suite.

- [ ] **Step 5: Wire into `Pane.svelte`'s tab label**

Open `app/src/lib/Pane.svelte`. Add imports:

```typescript
import Tooltip from "./Tooltip.svelte";
import { folderName } from "./paths";
```

Add this function near the file's other `$derived`/helper declarations:

```typescript
function tabLabel(sessionId: string): string {
  const cwd = $layoutState.cwdBySessionId[sessionId];
  return cwd ? folderName(cwd) : sessionId.slice(0, 8);
}

function tabTooltip(sessionId: string): string {
  return $layoutState.cwdBySessionId[sessionId] ?? sessionId;
}
```

Replace the tab button's contents — currently `{sessionId.slice(0, 8)}` directly followed by the close `<span>` — with the label wrapped in `Tooltip`:

```svelte
      <button class="tab" class:active={sessionId === active} onclick={() => switchToTab(sessionId)}>
        <Tooltip text={tabTooltip(sessionId)}>
          <span class="tab-label">{tabLabel(sessionId)}</span>
        </Tooltip>
        <span
          class="close"
          aria-label="Close Tab"
          title="Close Tab"
          onclick={async (e) => {
            e.stopPropagation();
            if (await confirmTabClose(sessionId)) {
              closeSession(sessionId);
            }
          }}
        >
          <X size={12} />
        </span>
      </button>
```

(Everything else about the tab button — `class:active`, the `onclick`, the surrounding `{#each}` — is unchanged. The `aria-label`/`title` on the close span were added by an earlier plan's final-review fix and must stay exactly as they are.)

Add a `.tab-label` rule to the `<style>` block, alongside the existing `.tab`/`.close`/`.new-tab` rules:

```css
  .tab-label {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
```

- [ ] **Step 6: Verify**

Run: `cd app && npm run check`
Expected: no new type errors (this file's existing a11y/deprecation warnings from prior plans are fine to leave).

Run: `cd app && npm run build`
Expected: builds cleanly.

Run: `cd app && npm test`
Expected: full suite green (this task's new `paths.test.ts` plus everything else).

No automated GUI test exists for this task. Note in your report that actual tab-label truncation, tooltip appearance/positioning, and the label updating live as OSC 7 sequences arrive are all unverified pending a human at the keyboard — this is the first point where the whole cwd-tracking feature (Tasks 1-7) is reachable end-to-end in the running app.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/paths.ts app/src/lib/paths.test.ts app/src/lib/Pane.svelte
git commit -m "feat(app): show live session cwd as the tab label, with a full-path tooltip"
```

## Self-Review Notes

- **Spec coverage:** every element of spec section 2 maps to a task —
  daemon-side OSC 7 parsing with chunk-boundary safety (Task 1), the
  `cwd`-field-reuse and new `CwdChanged` event (Task 2), the pump-loop
  wiring plus the Attach-baseline design that avoids a separate seed
  command (Task 3), the Tauri event relay (Task 4), the custom tooltip
  component (Task 5), the frontend `cwdBySessionId` store field and
  listener (Task 6), and the tab-label rendering with truncation + tooltip
  (Task 7).
- **Placeholder scan:** none — every step has complete, concrete code,
  including the two integration tests that exercise the real daemon over a
  real socket rather than describing what a test "should" check.
- **Type consistency:** `OscCwdScanner::feed` (Task 1) is called with the
  exact same signature from `spawn_pump` (Task 3). `Response::CwdChanged`
  (Task 2) is matched by that exact variant name/shape in both Task 3's
  emit sites and Task 4's relay arm. `handleCwdChanged(sessionId, cwd)`
  (Task 6) matches the event payload shape Task 4 emits
  (`(id, cwd)` tuple). `folderName` (Task 7) and `cwdBySessionId` (Task 6)
  are consumed with their exact defined signatures in `Pane.svelte`.
- **Cross-cutting fix carried forward:** Task 7's `Pane.svelte` diff
  explicitly preserves the `aria-label`/`title="Close Tab"` attributes an
  earlier plan's final-review fix added to the tab-close control — a prior
  plan's whole-branch review caught their absence as a real regression, and
  this plan's diff must not reintroduce that gap by copy-pasting from an
  older version of this file.
