# Terminal Core — Session Status Detection — Part 1 (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the daemon the ability to detect, per session, three live states (`idle`/`working`/`waiting_for_input`) from raw PTY output, persist them (reusing Milestone A's already-existing `SessionStatus`/`update_status`), and relay live transitions to the Tauri app — with zero frontend/Svelte changes (that's Part 2).

**Architecture:** A new pure, byte-fed `StatusScanner` (`crates/daemon/src/status.rs`) mirrors the existing `OscCwdScanner`'s conventions exactly, watching for OSC 133 shell-integration markers (idle/working) and a bare terminal BEL (waiting-for-input). Wired into `spawn_pump` (`crates/daemon/src/server.rs`) alongside the existing cwd scanner. A second mechanism — an output-activity heuristic with a 2-second quiet-period timeout — covers idle/working for sessions that never emit OSC 133, implemented as a small companion thread per session (since the pump's blocking read loop has no way to notice "nothing happened for 2 seconds" on its own). A new `Response::StatusChanged` event (mirroring `Response::CwdChanged`) carries transitions to the Tauri app, which relays it to the frontend as a Tauri event.

**Tech Stack:** Rust, the existing `crates/daemon`/`crates/protocol`/`app/src-tauri` crates. No new dependencies.

## Global Constraints

- No Svelte/frontend files are touched by this plan — Part 2 (a separate, later plan) builds the UI/notifications against the event this plan produces.
- `crates/daemon/src/registry.rs` is **not modified at all** — `SessionStatus` and `Registry::update_status` already exist from Milestone A and are already fully wired through `SessionRecord` → `SessionSummary` → `ListSessions`; this plan only calls what's already there.
- `crates/daemon/src/osc.rs` (the existing cwd scanner) is **not modified**.
- **OSC sequences are tracked generically** (any OSC number, not just 133) specifically so a BEL terminating some *other* OSC sequence — OSC 7's own cwd report legally uses BEL as an alternative terminator too — is never misclassified as a standalone attention-bell. Only when the accumulated OSC number is specifically `133` is the payload parsed as a status command.
- OSC 133 command mapping: `A`/`B` (prompt start / command start) → `Idle`. `C` (command executed) → `Working`. `D` (command finished, optionally followed by `;<exit-code digits>`, exit code value is not parsed/used — the transition is `Idle` either way).
- A bare BEL byte — seen while *not* inside any OSC sequence — is always `WaitingForInput`, regardless of current state.
- Output-activity heuristic (any new PTY bytes → `Working`; `HEURISTIC_QUIET_PERIOD` = 2 seconds with no further output → `Idle`) applies **only** to a session that has never yet seen a valid OSC 133 marker. The *first* valid OSC 133 marker ever observed for a session is a permanent, one-way switch to OSC-133-only detection for that session's remaining lifetime — the heuristic is never consulted again afterward. Bare-BEL detection is completely independent of this switch and always active regardless.
- `Response::StatusChanged` is **never** sent for `Exited` — the existing `Response::SessionExited` event already covers session death; this plan must not add a `StatusChanged` emission anywhere near the existing `update_status(&id, SessionStatus::Exited)` call at the end of `spawn_pump`'s read loop, which stays exactly as it is today.
- Every task must leave `cargo build` and `cargo test` (run from the repo root, covering `app`, `crates/daemon`, `crates/protocol`) fully green before its commit.

---

### Task 1: `status.rs` — the pure `StatusScanner`

**Files:**
- Create: `crates/daemon/src/status.rs`
- Modify: `crates/daemon/src/lib.rs` (add `pub mod status;` alongside the existing `pub mod osc;` — read this file first to find the exact existing module-declaration line and add the new one immediately after it, same style)

**Interfaces:**
- Produces: `pub enum StatusEvent { Idle, Working, WaitingForInput }` (derives `Debug, Clone, Copy, PartialEq, Eq`), `pub struct StatusScanner` with `pub fn new() -> Self` and `pub fn feed(&mut self, bytes: &[u8]) -> Vec<StatusEvent>`.

This task is fully self-contained and independently testable — no dependency on `server.rs` or any other task in this plan, exactly like `osc.rs`'s own `OscCwdScanner`.

- [ ] **Step 1: Write `status.rs`**

```rust
use std::time::Duration;

/// Cap on how many bytes of a single OSC sequence's number or payload
/// this scanner will accumulate before giving up and resetting to Idle --
/// the same runaway-sequence protection OscCwdScanner already has.
const MAX_SEQUENCE_LEN: usize = 256;

/// Emitted by `StatusScanner::feed` for each status-relevant signal found
/// in a chunk of raw PTY output, in the order they occurred.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusEvent {
    Idle,
    Working,
    WaitingForInput,
}

/// Watches a stream of raw PTY output bytes for two independent signals:
/// OSC 133 shell-integration markers (A/B/C/D -> idle/working) and a bare
/// terminal BEL byte outside of any escape sequence (-> waiting_for_input).
///
/// OSC sequences are tracked GENERICALLY (any number, not just 133) --
/// this is deliberate, not incidental complexity. OSC 7 (cwd, see
/// osc.rs) and OSC 133 both legally use BEL as an alternative terminator
/// to ESC \ -- a BEL that's actually terminating some other OSC sequence
/// must never be misclassified as a standalone attention-bell. Only when
/// the accumulated OSC number is specifically "133" is the payload
/// parsed as a status command.
///
/// Never mutates or strips the bytes it's fed -- callers forward the
/// original stream unchanged; this only watches. State is carried across
/// `feed()` calls so a sequence split across separate PTY reads is still
/// found correctly.
pub struct StatusScanner {
    state: ScanState,
}

enum ScanState {
    /// Not currently inside any escape sequence.
    Idle,
    /// Just saw ESC; don't yet know if this is an OSC introducer (`]`)
    /// or some other escape sequence entirely (e.g. CSI `[`).
    SawEsc,
    /// Inside an OSC sequence: accumulating the OSC number until the
    /// first `;`, then the payload until a BEL or ST (ESC \) terminator.
    InOsc { number: Vec<u8>, in_payload: bool, payload: Vec<u8>, saw_esc: bool },
}

impl StatusScanner {
    pub fn new() -> Self {
        Self { state: ScanState::Idle }
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<StatusEvent> {
        let mut found = Vec::new();
        for &b in bytes {
            match &mut self.state {
                ScanState::Idle => {
                    if b == 0x1b {
                        self.state = ScanState::SawEsc;
                    } else if b == 0x07 {
                        // A bare BEL, not terminating anything -- the
                        // standalone terminal bell.
                        found.push(StatusEvent::WaitingForInput);
                    }
                }
                ScanState::SawEsc => {
                    if b == b']' {
                        self.state = ScanState::InOsc {
                            number: Vec::new(),
                            in_payload: false,
                            payload: Vec::new(),
                            saw_esc: false,
                        };
                    } else if b == 0x1b {
                        // A stray repeated ESC before the introducer --
                        // stay watching for ']', using this ESC as the
                        // new potential start rather than dropping to
                        // Idle and losing a real sequence that follows.
                    } else {
                        // Not an OSC introducer (e.g. CSI, or any other
                        // escape sequence) -- this scanner doesn't need
                        // to track those, since none of them use BEL/ST
                        // as a terminator the way OSC does.
                        self.state = ScanState::Idle;
                    }
                }
                ScanState::InOsc { number, in_payload, payload, saw_esc } => {
                    if *saw_esc {
                        if b == b'\\' {
                            Self::emit_if_133(number, payload, &mut found);
                            self.state = ScanState::Idle;
                        } else {
                            // The prior ESC wasn't actually the start of
                            // ST -- keep it as ordinary content and
                            // process this byte normally.
                            if *in_payload && payload.len() < MAX_SEQUENCE_LEN {
                                payload.push(0x1b);
                            }
                            *saw_esc = false;
                            if b == 0x07 {
                                Self::emit_if_133(number, payload, &mut found);
                                self.state = ScanState::Idle;
                            } else if b == 0x1b {
                                *saw_esc = true;
                            } else {
                                Self::push_byte(number, in_payload, payload, b);
                            }
                        }
                        continue;
                    }
                    if b == 0x07 {
                        Self::emit_if_133(number, payload, &mut found);
                        self.state = ScanState::Idle;
                    } else if b == 0x1b {
                        *saw_esc = true;
                    } else if !*in_payload && b == b';' {
                        *in_payload = true;
                    } else {
                        Self::push_byte(number, in_payload, payload, b);
                    }
                }
            }
        }
        found
    }

    fn push_byte(number: &mut Vec<u8>, in_payload: &mut bool, payload: &mut Vec<u8>, b: u8) {
        if *in_payload {
            if payload.len() < MAX_SEQUENCE_LEN {
                payload.push(b);
            }
        } else if b.is_ascii_digit() {
            if number.len() < MAX_SEQUENCE_LEN {
                number.push(b);
            }
        } else {
            // Malformed OSC-number syntax (a non-digit before any ';')
            // -- be lenient: start treating everything as payload from
            // here, so the terminator is still found correctly even
            // though this sequence won't be recognized as OSC 133.
            *in_payload = true;
            if payload.len() < MAX_SEQUENCE_LEN {
                payload.push(b);
            }
        }
    }

    fn emit_if_133(number: &[u8], payload: &[u8], found: &mut Vec<StatusEvent>) {
        if number != b"133" {
            return;
        }
        let Some(&command) = payload.first() else { return };
        match command {
            b'A' | b'B' => found.push(StatusEvent::Idle),
            b'C' => found.push(StatusEvent::Working),
            b'D' => found.push(StatusEvent::Idle),
            _ => {}
        }
    }
}

/// How long a session must go without any new PTY output before the
/// output-activity heuristic (used only while a session has never seen a
/// valid OSC 133 marker) considers it idle again. Re-exported from this
/// module since it's the detection layer's own concept, even though the
/// actual timer mechanism lives in server.rs (see that file's own
/// heuristic-timer wiring, added in Task 3 of this plan).
pub const HEURISTIC_QUIET_PERIOD: Duration = Duration::from_secs(2);

#[cfg(test)]
mod tests {
    use super::*;

    fn osc133(command: &str) -> Vec<u8> {
        let mut bytes = b"\x1b]133;".to_vec();
        bytes.extend_from_slice(command.as_bytes());
        bytes.push(0x07);
        bytes
    }

    #[test]
    fn prompt_start_a_maps_to_idle() {
        let mut scanner = StatusScanner::new();
        assert_eq!(scanner.feed(&osc133("A")), vec![StatusEvent::Idle]);
    }

    #[test]
    fn command_start_b_maps_to_idle() {
        let mut scanner = StatusScanner::new();
        assert_eq!(scanner.feed(&osc133("B")), vec![StatusEvent::Idle]);
    }

    #[test]
    fn command_executed_c_maps_to_working() {
        let mut scanner = StatusScanner::new();
        assert_eq!(scanner.feed(&osc133("C")), vec![StatusEvent::Working]);
    }

    #[test]
    fn command_finished_d_without_exit_code_maps_to_idle() {
        let mut scanner = StatusScanner::new();
        assert_eq!(scanner.feed(&osc133("D")), vec![StatusEvent::Idle]);
    }

    #[test]
    fn command_finished_d_with_exit_code_still_maps_to_idle() {
        let mut scanner = StatusScanner::new();
        assert_eq!(scanner.feed(&osc133("D;42")), vec![StatusEvent::Idle]);
    }

    #[test]
    fn bare_standalone_bel_maps_to_waiting_for_input() {
        let mut scanner = StatusScanner::new();
        let mut bytes = b"some shell output\r\n".to_vec();
        bytes.push(0x07);
        bytes.extend_from_slice(b"more output\r\n");
        assert_eq!(scanner.feed(&bytes), vec![StatusEvent::WaitingForInput]);
    }

    #[test]
    fn osc7_sequence_terminated_by_bel_is_not_misclassified_as_a_standalone_bell() {
        // The specific regression this scanner's generic-OSC-tracking
        // exists to prevent: OSC 7 (cwd reporting, see osc.rs) legally
        // uses BEL as its own terminator too. A naive bare-BEL detector
        // would fire waiting_for_input on every single shell prompt that
        // uses BEL-terminated OSC 7 -- this must not happen.
        let mut scanner = StatusScanner::new();
        let mut bytes = b"\x1b]7;file://host/tmp".to_vec();
        bytes.push(0x07);
        assert_eq!(scanner.feed(&bytes), vec![]);
    }

    #[test]
    fn an_osc_number_other_than_133_or_7_is_structurally_tracked_but_produces_no_event() {
        let mut scanner = StatusScanner::new();
        let mut bytes = b"\x1b]9;some notification text".to_vec();
        bytes.push(0x07);
        assert_eq!(scanner.feed(&bytes), vec![]);
    }

    #[test]
    fn supports_st_terminator_as_well_as_bel() {
        let mut scanner = StatusScanner::new();
        let mut bytes = b"\x1b]133;C".to_vec();
        bytes.extend_from_slice(b"\x1b\\");
        assert_eq!(scanner.feed(&bytes), vec![StatusEvent::Working]);
    }

    #[test]
    fn recovers_from_an_esc_inside_the_payload_that_is_not_actually_st() {
        let mut scanner = StatusScanner::new();
        let mut bytes = b"\x1b]133;C".to_vec();
        bytes.push(0x1b); // a stray ESC that is NOT followed by '\'
        bytes.extend_from_slice(b"x");
        bytes.push(0x07); // the real terminator
        assert_eq!(scanner.feed(&bytes), vec![StatusEvent::Working]);
    }

    #[test]
    fn parses_a_sequence_split_at_every_byte_boundary() {
        let full = osc133("C");
        for split_at in 0..=full.len() {
            let mut scanner = StatusScanner::new();
            let mut found = scanner.feed(&full[..split_at]);
            found.extend(scanner.feed(&full[split_at..]));
            assert_eq!(found, vec![StatusEvent::Working], "failed when split at byte {split_at}");
        }
    }

    #[test]
    fn finds_multiple_sequences_across_separate_feed_calls() {
        let mut scanner = StatusScanner::new();
        assert_eq!(scanner.feed(&osc133("C")), vec![StatusEvent::Working]);
        assert_eq!(scanner.feed(&osc133("D")), vec![StatusEvent::Idle]);
    }

    #[test]
    fn abandons_a_sequence_that_never_terminates_without_growing_forever() {
        let mut scanner = StatusScanner::new();
        let mut huge = b"\x1b]133;C".to_vec();
        huge.extend(std::iter::repeat(b'x').take(10_000));
        let result = scanner.feed(&huge);
        assert!(result.is_empty());
        // The scanner must have recovered to idle and be ready to find a
        // fresh, well-formed sequence afterward -- not stuck.
        assert_eq!(scanner.feed(&osc133("C")), vec![StatusEvent::Working]);
    }

    #[test]
    fn a_stray_repeated_esc_before_the_introducer_does_not_lose_the_real_sequence() {
        let mut scanner = StatusScanner::new();
        let mut bytes = vec![0x1b, 0x1b]; // stray double ESC
        bytes.extend(osc133("C"));
        assert_eq!(scanner.feed(&bytes), vec![StatusEvent::Working]);
    }

    #[test]
    fn a_non_osc_escape_sequence_does_not_swallow_a_later_standalone_bell() {
        // ESC [ ... is a CSI sequence (e.g. cursor movement), not OSC --
        // this scanner must recognize it isn't an OSC introducer and
        // return to Idle in time to still catch a real bell afterward.
        let mut scanner = StatusScanner::new();
        let mut bytes = b"\x1b[2J".to_vec(); // CSI: clear screen
        bytes.push(0x07); // a real, later, standalone bell
        assert_eq!(scanner.feed(&bytes), vec![StatusEvent::WaitingForInput]);
    }

    #[test]
    fn ignores_bytes_before_and_after_a_sequence() {
        let mut scanner = StatusScanner::new();
        let mut bytes = b"some shell output before\r\n".to_vec();
        bytes.extend(osc133("D"));
        bytes.extend_from_slice(b"more output after\r\n");
        assert_eq!(scanner.feed(&bytes), vec![StatusEvent::Idle]);
    }
}
```

- [ ] **Step 2: Register the module**

In `crates/daemon/src/lib.rs`, find the existing `pub mod osc;` line and add `pub mod status;` immediately after it.

- [ ] **Step 3: Run the tests**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin && source "$HOME/.cargo/env"; cargo test -p gavin-daemon --lib status::`
Expected: PASS — 15 tests, all green.

- [ ] **Step 4: Verify the whole workspace still builds and tests pass**

Run: `cargo build && cargo test`
Expected: PASS, no warnings about `StatusScanner`/`StatusEvent`/`HEURISTIC_QUIET_PERIOD` being unused (they're `pub`, and this file's own tests reference them — nothing else in the workspace uses them yet, which is fine).

- [ ] **Step 5: Commit**

```bash
git add crates/daemon/src/status.rs crates/daemon/src/lib.rs
git commit -m "feat(daemon): add status.rs, the pure OSC 133 / bare-BEL status scanner"
```

---

### Task 2: `Response::StatusChanged` in the protocol crate

**Files:**
- Modify: `crates/protocol/src/lib.rs`

**Interfaces:**
- Produces: a new `Response` variant `StatusChanged { id: String, status: String }`.

- [ ] **Step 1: Add the variant**

In `crates/protocol/src/lib.rs`, find the `Response` enum. Add a new variant immediately after the existing `CwdChanged { id: String, cwd: String },` line:

```rust
    StatusChanged { id: String, status: String },
```

- [ ] **Step 2: Add a roundtrip test**

In the same file's `#[cfg(test)] mod tests` block, add this test immediately after the existing `cwd_changed_response_roundtrips_through_json_line` test:

```rust
    #[test]
    fn status_changed_response_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let resp = Response::StatusChanged {
            id: "s1".to_string(),
            status: "working".to_string(),
        };
        write_message(&mut buf, &resp).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Response = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Response::StatusChanged { id, status } => {
                assert_eq!(id, "s1");
                assert_eq!(status, "working");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }
```

- [ ] **Step 3: Run the tests**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin && source "$HOME/.cargo/env"; cargo test -p protocol`
Expected: PASS — 6 tests (5 existing + 1 new).

- [ ] **Step 4: Verify the whole workspace still builds**

Run: `cargo build`
Expected: clean. `app/src-tauri/src/session.rs`'s relay loop (`bootstrap()`'s `match resp { ... }`, around line 532) already ends in a catch-all `_ => {}` arm after its explicit `Output`/`SessionExited`/`CwdChanged`/`Error` arms, so the new `StatusChanged` variant this task adds falls into that catch-all with zero code changes required here — Task 5 later adds an explicit arm for it, but nothing in this task needs to. `crates/daemon/src/server.rs` never matches on `Response` at all (it only constructs `Response` values), so it's entirely unaffected by this task either. The build must be clean with no further action.

- [ ] **Step 5: Commit**

```bash
git add crates/protocol/src/lib.rs
git commit -m "feat(protocol): add Response::StatusChanged"
```

---

### Task 3: Wire `StatusScanner` and the output-activity heuristic timer into `spawn_pump`

**Files:**
- Modify: `crates/daemon/src/server.rs`

**Interfaces:**
- Consumes: `StatusScanner`/`StatusEvent`/`HEURISTIC_QUIET_PERIOD` from `crate::status` (Task 1); `Response::StatusChanged` from `protocol` (Task 2); the existing `Registry::update_status`, `SessionStatus` (unchanged, from `crate::registry`).
- Produces: a new private `HeuristicState` struct, a new private `spawn_heuristic_idle_timer` function, a new private `persist_and_emit_status` function — all `server.rs`-internal (not `pub`, no other file needs them).

This is the largest task in this plan — the reactive OSC-133/BEL handling and the heuristic timer share one flag (`seen_osc133`) and can't be correctly reviewed or tested in isolation from each other, so they're one task rather than two.

- [ ] **Step 1: Add imports**

In `crates/daemon/src/server.rs`, replace the top-of-file imports:

```rust
use protocol::{read_message, write_message, Request, Response, SessionSummary};
use crate::osc::OscCwdScanner;
use crate::pty::PtySession;
use crate::registry::{Registry, SessionRecord, SessionStatus};
use std::collections::{HashMap, VecDeque};
use std::io::{BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::{Arc, Mutex};
use uuid::Uuid;
```

with:

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

- [ ] **Step 2: Add the heuristic-timer types and helper functions**

Immediately after the existing `const OUTPUT_BUFFER_CAP: usize = 64 * 1024;` line, add:

```rust
/// How often the heuristic idle-timeout companion thread (see
/// spawn_heuristic_idle_timer) wakes to check whether a session has gone
/// quiet -- granularity of HEURISTIC_QUIET_PERIOD, not a hard
/// real-time guarantee.
const HEURISTIC_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Shared between a session's pump thread and its heuristic idle-timeout
/// companion thread (spawn_heuristic_idle_timer). The pump thread's
/// blocking `reader.read()` loop has no way to notice "N seconds of
/// silence" on its own -- it only wakes when bytes actually arrive -- so
/// a separate thread is needed to detect that condition and fire the
/// idle transition itself.
struct HeuristicState {
    last_activity: Mutex<Instant>,
    /// Set true the first time this session's StatusScanner reports any
    /// OSC 133 marker -- once true, the heuristic (both the reactive
    /// "bytes arrived -> working" check in the pump loop below, and the
    /// companion thread's idle-timeout check) permanently stops applying
    /// for this session, per the one-way switching rule.
    seen_osc133: AtomicBool,
    /// Only meaningful while `!seen_osc133`. True = the heuristic
    /// currently considers this session Working. Both the pump thread
    /// and the companion thread read and write this, so neither fires a
    /// redundant or conflicting transition.
    heuristic_working: AtomicBool,
    /// Set false right before the pump thread's final Exited update, so
    /// the companion thread stops polling promptly once the session ends
    /// rather than spinning forever on a dead session.
    running: AtomicBool,
}

/// Persists a status transition and, if a client is currently attached,
/// relays it live via Response::StatusChanged -- the same
/// persist-then-relay shape spawn_pump's existing cwd handling already
/// uses for Response::CwdChanged, factored out here since this plan adds
/// three separate call sites for it (OSC 133 events, bare-BEL events, and
/// the heuristic timer).
fn persist_and_emit_status(manager: &Arc<SessionManager>, id: &str, status: SessionStatus) {
    let status_str = status.as_str();
    if let Err(e) = manager.registry.lock().unwrap().update_status(id, status) {
        eprintln!("failed to persist status for session {id}: {e}");
    }
    let target = manager.attached_writers.lock().unwrap().get(id).cloned();
    if let Some(w) = target {
        let _ = write_message(
            &mut *w.lock().unwrap(),
            &Response::StatusChanged { id: id.to_string(), status: status_str.to_string() },
        );
    }
}

/// Spawned once per session pump (see spawn_pump), alongside it. Polls
/// `heuristic.last_activity` every HEURISTIC_POLL_INTERVAL; once
/// HEURISTIC_QUIET_PERIOD has elapsed with no new output AND this session
/// has never seen a valid OSC 133 marker, fires an Idle transition.
/// Exits promptly once the session either switches permanently to
/// OSC-133-only detection (seen_osc133) or ends (running set false).
fn spawn_heuristic_idle_timer(manager: &Arc<SessionManager>, id: String, heuristic: Arc<HeuristicState>) {
    let manager = Arc::clone(manager);
    std::thread::spawn(move || loop {
        std::thread::sleep(HEURISTIC_POLL_INTERVAL);
        if !heuristic.running.load(Ordering::SeqCst) {
            return;
        }
        if heuristic.seen_osc133.load(Ordering::SeqCst) {
            // Permanently switched to OSC-133-only detection -- nothing
            // left for this thread to ever do for this session again.
            return;
        }
        if !heuristic.heuristic_working.load(Ordering::SeqCst) {
            // Already considered idle; nothing to re-check.
            continue;
        }
        let quiet_for = heuristic.last_activity.lock().unwrap().elapsed();
        if quiet_for >= HEURISTIC_QUIET_PERIOD {
            heuristic.heuristic_working.store(false, Ordering::SeqCst);
            persist_and_emit_status(&manager, &id, SessionStatus::Idle);
        }
    });
}
```

- [ ] **Step 3: Wire into `spawn_pump`**

Find the `fn spawn_pump` function. Replace this block (the pump-thread setup, right after acquiring `reader`):

```rust
            let mut buf = [0u8; 4096];
            // Bytes read but not yet forwarded because they end mid-way
            // through a multi-byte UTF-8 character — carried to the next
            // read instead of being lossily corrupted at the chunk boundary.
            let mut pending: Vec<u8> = Vec::new();
            let mut osc_scanner = OscCwdScanner::new();

            loop {
```

with:

```rust
            let mut buf = [0u8; 4096];
            // Bytes read but not yet forwarded because they end mid-way
            // through a multi-byte UTF-8 character — carried to the next
            // read instead of being lossily corrupted at the chunk boundary.
            let mut pending: Vec<u8> = Vec::new();
            let mut osc_scanner = OscCwdScanner::new();
            let mut status_scanner = StatusScanner::new();
            let heuristic = Arc::new(HeuristicState {
                last_activity: Mutex::new(Instant::now()),
                seen_osc133: AtomicBool::new(false),
                heuristic_working: AtomicBool::new(false), // sessions start Idle
                running: AtomicBool::new(true),
            });
            spawn_heuristic_idle_timer(&manager, id.clone(), Arc::clone(&heuristic));

            loop {
```

Then, inside the `Ok(n) => { ... }` arm, find the existing block:

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

                        pending.extend_from_slice(&buf[..n]);
```

and insert the new status-handling block between the existing `osc_scanner` loop and the `pending.extend_from_slice(&buf[..n]);` line, so it reads:

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

                        *heuristic.last_activity.lock().unwrap() = Instant::now();
                        if !heuristic.seen_osc133.load(Ordering::SeqCst)
                            && !heuristic.heuristic_working.swap(true, Ordering::SeqCst)
                        {
                            // Was idle (or never yet working), now has
                            // fresh output -- fire Working. swap() both
                            // reads the old value and sets the new one
                            // atomically, so a concurrent companion-thread
                            // idle check can't race this into firing twice.
                            persist_and_emit_status(&manager, &id, SessionStatus::Working);
                        }

                        for event in status_scanner.feed(&buf[..n]) {
                            match event {
                                StatusEvent::Idle => {
                                    heuristic.seen_osc133.store(true, Ordering::SeqCst);
                                    persist_and_emit_status(&manager, &id, SessionStatus::Idle);
                                }
                                StatusEvent::Working => {
                                    heuristic.seen_osc133.store(true, Ordering::SeqCst);
                                    persist_and_emit_status(&manager, &id, SessionStatus::Working);
                                }
                                StatusEvent::WaitingForInput => {
                                    persist_and_emit_status(&manager, &id, SessionStatus::WaitingForInput);
                                }
                            }
                        }

                        pending.extend_from_slice(&buf[..n]);
```

Finally, find the existing line right before the read loop's closing brace (where `exit_code`/the final `update_status(..Exited)` call already lives):

```rust
            let exit_code = manager.exit_code_for(&id).ok().flatten().unwrap_or(-1);
            if let Err(e) = manager.registry.lock().unwrap().update_status(&id, SessionStatus::Exited) {
```

Insert `heuristic.running.store(false, Ordering::SeqCst);` on its own line immediately *before* that `let exit_code = ...` line, so the companion thread is told to stop before (not after) the exit-handling proceeds:

```rust
            heuristic.running.store(false, Ordering::SeqCst);
            let exit_code = manager.exit_code_for(&id).ok().flatten().unwrap_or(-1);
            if let Err(e) = manager.registry.lock().unwrap().update_status(&id, SessionStatus::Exited) {
```

- [ ] **Step 4: Add integration tests**

In `crates/daemon/src/server.rs`'s existing `#[cfg(test)] mod tests` block, add these tests immediately after the existing `attach_relays_cwd_changed_when_pty_output_contains_osc7` test:

```rust
    #[test]
    fn relays_status_changed_when_pty_output_contains_an_osc_133_command_executed_marker() {
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
                data: "printf '\\033]133;C\\007'\n".to_string(),
            },
        )
        .unwrap();

        let mut reader = BufReader::new(stream2.try_clone().unwrap());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut found = false;
        while std::time::Instant::now() < deadline {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::StatusChanged { id: rid, status } = resp {
                if rid == id && status == "working" {
                    found = true;
                    break;
                }
            }
        }
        assert!(found, "never saw the expected StatusChanged{{status:\"working\"}} for the printf'd OSC 133 C marker");
    }

    #[test]
    fn relays_status_changed_when_pty_output_contains_a_bare_bel() {
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
            &Request::WriteInput { id: id.clone(), data: "printf '\\007'\n".to_string() },
        )
        .unwrap();

        let mut reader = BufReader::new(stream2.try_clone().unwrap());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut found = false;
        while std::time::Instant::now() < deadline {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::StatusChanged { id: rid, status } = resp {
                if rid == id && status == "waiting_for_input" {
                    found = true;
                    break;
                }
            }
        }
        assert!(found, "never saw the expected StatusChanged{{status:\"waiting_for_input\"}} for the printf'd bare BEL");
    }

    #[test]
    fn heuristic_fires_working_promptly_then_idle_after_a_real_quiet_period() {
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
        // Plain output with no OSC 133 markers at all -- this session
        // stays in heuristic mode for its whole life.
        write_message(
            &mut stream2,
            &Request::WriteInput { id: id.clone(), data: "echo heuristic_test\n".to_string() },
        )
        .unwrap();

        let mut reader = BufReader::new(stream2.try_clone().unwrap());
        let mut statuses: Vec<String> = Vec::new();
        // HEURISTIC_QUIET_PERIOD is 2 real seconds; give this a generous
        // deadline (this project's tests already accept multi-second real
        // waits for timing-dependent behavior, e.g. the existing OSC 7
        // test's 5-second deadline -- no time-mocking is used anywhere in
        // this codebase).
        let deadline = std::time::Instant::now() + Duration::from_secs(6);
        let mut saw_working_then_idle = false;
        while std::time::Instant::now() < deadline {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::StatusChanged { id: rid, status } = resp {
                if rid == id {
                    statuses.push(status.clone());
                    if statuses.contains(&"working".to_string()) && status == "idle" {
                        saw_working_then_idle = true;
                        break;
                    }
                }
            }
        }
        assert!(
            saw_working_then_idle,
            "expected a \"working\" StatusChanged followed eventually by \"idle\", got: {statuses:?}"
        );
    }

    #[test]
    fn heuristic_permanently_stops_once_a_real_osc_133_marker_has_been_seen() {
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
        // A real OSC 133 "C" marker, followed by plain output with no
        // further markers -- once this session has seen OSC 133 once,
        // the heuristic must never fire again, even after a full quiet
        // period elapses.
        write_message(
            &mut stream2,
            &Request::WriteInput {
                id: id.clone(),
                data: "printf '\\033]133;C\\007'; echo done_working\n".to_string(),
            },
        )
        .unwrap();

        let mut reader = BufReader::new(stream2.try_clone().unwrap());
        let mut saw_working = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline && !saw_working {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::StatusChanged { id: rid, status } = resp {
                if rid == id && status == "working" {
                    saw_working = true;
                }
            }
        }
        assert!(saw_working, "never saw the initial \"working\" from the OSC 133 C marker");

        // Wait well past HEURISTIC_QUIET_PERIOD (2s) with no further OSC
        // 133 marker -- if the heuristic incorrectly re-activated, it
        // would fire a spurious "idle" here. Drain anything that arrives
        // in a bounded window afterward and assert none of it is that.
        std::thread::sleep(Duration::from_secs(3));
        reader.get_ref().set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        loop {
            match read_message::<_, Response>(&mut reader) {
                Ok(Some(Response::StatusChanged { id: rid, status })) if rid == id => {
                    assert_ne!(status, "idle", "heuristic fired a spurious idle after OSC 133 was already seen");
                }
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => break, // nothing more arrived within the timeout, as expected
            }
        }
    }
```

- [ ] **Step 5: Run the tests**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin && source "$HOME/.cargo/env"; cargo test -p gavin-daemon`
Expected: PASS — all existing daemon tests plus the 4 new ones in this task (the heuristic tests will each take a few real seconds to run, matching this project's existing timing-test style).

- [ ] **Step 6: Verify the whole workspace still builds and tests pass**

Run: `cargo build && cargo test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/daemon/src/server.rs
git commit -m "feat(daemon): wire StatusScanner and the output-activity heuristic timer into spawn_pump"
```

---

### Task 4: Synthetic baseline `StatusChanged` on `Attach`

**Files:**
- Modify: `crates/daemon/src/server.rs`

**Interfaces:**
- Consumes: `Response::StatusChanged` (Task 2); the existing `Registry::get` (unchanged, from `crate::registry`), which already returns a `SessionRecord` whose `.status: SessionStatus` field this task reads (no new registry method needed).

- [ ] **Step 1: Extend `attach()`'s existing baseline block**

Find this exact block inside `attach()`:

```rust
        let baseline_cwd = self.registry.lock().unwrap().get(id).ok().flatten().map(|r| r.cwd);
        if let Some(cwd) = baseline_cwd {
            let _ = write_message(
                &mut *writer.lock().unwrap(),
                &Response::CwdChanged { id: id.to_string(), cwd },
            );
        }
```

Replace it with:

```rust
        // Both baselines (cwd and status) come from the same single
        // registry lookup, extending the existing lock-across-blocking-io
        // rule the comment above this block already established: the
        // lookup is bound to an owned value in its own `let` first,
        // rather than inlined into the `if let` scrutinee, so the
        // MutexGuard temporary doesn't get lifetime-extended across the
        // blocking writes below.
        let baseline_record = self.registry.lock().unwrap().get(id).ok().flatten();
        if let Some(record) = baseline_record {
            let _ = write_message(
                &mut *writer.lock().unwrap(),
                &Response::CwdChanged { id: id.to_string(), cwd: record.cwd },
            );
            let _ = write_message(
                &mut *writer.lock().unwrap(),
                &Response::StatusChanged { id: id.to_string(), status: record.status.as_str().to_string() },
            );
        }
```

(The doc comment already present immediately above this block, explaining *why* the lookup is hoisted into its own `let`, stays as-is above your edit — this step only replaces the code, not the pre-existing explanatory comment above it.)

- [ ] **Step 2: Add a test**

In `crates/daemon/src/server.rs`'s test module, add this test immediately after the existing `attach_sends_a_baseline_cwd_changed_with_the_launch_directory` test:

```rust
    #[test]
    fn attach_sends_a_baseline_status_changed_immediately_after_the_baseline_cwd_changed() {
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

        let first: Response = read_message(&mut reader).unwrap().unwrap();
        assert!(matches!(first, Response::CwdChanged { .. }), "expected CwdChanged first, got {first:?}");

        let second: Response = read_message(&mut reader).unwrap().unwrap();
        match second {
            Response::StatusChanged { id: rid, status } => {
                assert_eq!(rid, id);
                assert_eq!(status, "idle");
            }
            other => panic!("expected StatusChanged as the second message after Attach, got {other:?}"),
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
git commit -m "feat(daemon): send a baseline StatusChanged alongside the existing baseline CwdChanged on Attach"
```

---

### Task 5: Relay `StatusChanged` to the frontend as a Tauri event

**Files:**
- Modify: `app/src-tauri/src/session.rs`

**Interfaces:**
- Consumes: `Response::StatusChanged` (Task 2).
- Produces: a new Tauri event `"session-status-changed"`, payload `(id: String, status: String)` (a 2-tuple, matching the existing `"cwd-changed"` event's exact payload shape).

- [ ] **Step 1: Add the relay arm**

Find `bootstrap()`'s relay-loop `match resp { ... }` statement (inside the `std::thread::spawn` closure that reads daemon messages). Locate this exact arm:

```rust
                Response::CwdChanged { id, cwd } => {
                    let _ = reader_app_handle.emit("cwd-changed", (id, cwd));
                }
```

Add a new arm immediately after it:

```rust
                Response::StatusChanged { id, status } => {
                    let _ = reader_app_handle.emit("session-status-changed", (id, status));
                }
```

- [ ] **Step 2: Verify the whole workspace builds**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin && source "$HOME/.cargo/env"; cargo build`
Expected: clean build. (This match statement already has a catch-all `_ => {}` arm for other `Response` variants it doesn't relay — confirm your added arm sits alongside the other explicit arms, above any catch-all, exactly like the existing `CwdChanged` arm does.)

- [ ] **Step 3: Run the tests**

Run: `cargo test`
Expected: PASS — this change has no dedicated new test (it's a one-line addition to an existing, already-tested relay pattern with no new branching logic of its own to exercise; the daemon-side tests from Tasks 3-4 already prove `Response::StatusChanged` is correctly produced and delivered over the socket, which is the input this relay arm consumes).

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/src/session.rs
git commit -m "feat(app): relay Response::StatusChanged as the session-status-changed Tauri event"
```
