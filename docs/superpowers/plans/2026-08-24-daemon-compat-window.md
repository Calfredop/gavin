# Daemon Compatibility Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the app keep working against an older `gavin-daemon` inside a supported version window, instead of forcing a destructive restart that kills every running agent.

**Architecture:** Two protocol constants define a window (`MIN_COMPATIBLE_VERSION..=PROTOCOL_VERSION`). The client learns the daemon's version at connect, then refuses to put any request on the wire that the daemon predates — a table generated from an exhaustive `match` over `Request`. Because that gating is client-side, it works against daemons that already exist in the wild. Daemon-side tolerance of unknown requests is added too, as defense in depth for future versions.

**Tech Stack:** Rust (protocol crate, daemon, Tauri backend), Svelte 5 + TypeScript (frontend), `cargo test`, `vitest`.

**Spec:** `docs/superpowers/specs/2026-08-24-daemon-version-compat-ota-design.md`

## Global Constraints

- `PROTOCOL_VERSION` goes **10 → 12**. This work is itself a wire change (adds `Request::Shutdown` and the `Unknown` catch-all).
- `MIN_COMPATIBLE_VERSION` is `5`. Derived, not chosen — v4→v5 changed `Response::Board`'s shape. Do not lower it without re-running the audit in the spec's §1.
- **v11 is deliberately skipped, not a typo.** This branch is based on v10. A separate, uncommitted orchestration merge claims v11 (it adds `SaveTool`, `GetTools`, `GetToolsByRoot`, `DeleteTool`). Reserving v11 for it means the two lines of work can land in either order without a version collision.
- **Do not reference the v11 tool requests anywhere in this plan's code.** They do not exist on this branch and will not compile. When the orchestration merge lands, `min_version_for`'s exhaustive `match` will refuse to build until someone adds `=> 11` arms for those four variants — which is the intended forcing function, not a bug.
- No `Request` variant may ever be removed or renamed. The whole design rests on the request side being append-only.
- A daemon *newer* than the client stays a hard error in the app. Only `gavin-mcp` handles that case, in the Phase 2 plan.
- Rust: `cargo test -p <crate>`. Frontend: `cd app && npm test`.

---

### Task 1: Protocol constants and the introduced-version table

**Files:**
- Modify: `crates/protocol/src/lib.rs:15` (the `PROTOCOL_VERSION` const)
- Test: `crates/protocol/src/lib.rs` (the existing `#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: nothing.
- Produces: `pub const MIN_COMPATIBLE_VERSION: u32`, and `pub fn min_version_for(req: &Request) -> u32` returning the protocol version at which `req`'s variant was introduced.

- [ ] **Step 1: Write the failing tests**

Add to the existing `mod tests` in `crates/protocol/src/lib.rs`:

```rust
#[test]
fn the_window_floor_is_never_above_the_current_version() {
    assert!(MIN_COMPATIBLE_VERSION <= PROTOCOL_VERSION);
}

#[test]
fn v1_requests_are_available_to_the_oldest_supported_daemon() {
    // ListSessions has existed since v1, so any daemon in the window serves it.
    assert_eq!(min_version_for(&Request::ListSessions), 1);
    assert_eq!(min_version_for(&Request::GetProtocolVersion), 1);
}

#[test]
fn later_variants_report_the_version_that_introduced_them() {
    assert_eq!(min_version_for(&Request::SetChecklistItem {
        plan_path: "/p.md".into(), item: "x".into(), checked: true,
    }), 4);
    assert_eq!(min_version_for(&Request::DeleteCardFile { path: "/p.md".into() }), 6);
    assert_eq!(min_version_for(&Request::NameSession {
        session_id: "s-1".into(), name: "login flow".into(),
    }), 10);
}

#[test]
fn no_variant_claims_a_version_beyond_the_current_one() {
    // Guards the table against a typo that would make a request unsendable.
    assert!(min_version_for(&Request::ListSessions) <= PROTOCOL_VERSION);
}
```

> The literal field names/types in `SetChecklistItem`, `DeleteCardFile` and `NameSession` must match the current definitions in this file. Read them before writing the test rather than trusting this snippet.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p protocol`
Expected: FAIL — `cannot find function min_version_for`, `cannot find value MIN_COMPATIBLE_VERSION`.

- [ ] **Step 3: Add the constant and the table**

In `crates/protocol/src/lib.rs`, beside `PROTOCOL_VERSION`:

```rust
/// The oldest daemon this client can still talk to. Bumped ONLY when a
/// change breaks the wire for an older peer -- adding a Request variant
/// does not, because clients gate on `min_version_for`.
///
/// 5 is derived, not chosen: v4 -> v5 added `card_sessions` to
/// Response::Board with no serde default, so a v4 daemon's reply cannot
/// be parsed by a v5+ client. See the design doc's audit.
pub const MIN_COMPATIBLE_VERSION: u32 = 5;

/// The protocol version that introduced `req`'s variant.
///
/// Deliberately an exhaustive match with no `_` arm: adding a Request
/// variant must not compile until its version is recorded here, because
/// a missing entry would let the app send it to a daemon too old to
/// parse it -- which closes the connection outright.
pub fn min_version_for(req: &Request) -> u32 {
    match req {
        Request::Attach { .. }
        | Request::CreateGavinContext { .. }
        | Request::CreatePlan { .. }
        | Request::CreateSession { .. }
        | Request::DeleteBoard { .. }
        | Request::GetBoard { .. }
        | Request::GetBoardByRoot { .. }
        | Request::GetGavinTree { .. }
        | Request::GetProtocolVersion
        | Request::InitGavinRoot { .. }
        | Request::KillSession { .. }
        | Request::ListSessions
        | Request::ReadPrd { .. }
        | Request::ResizeSession { .. }
        | Request::ScanGavinRoot { .. }
        | Request::SetBoard { .. }
        | Request::SetPlanFrontmatterField { .. }
        | Request::SpawnAgentSession { .. }
        | Request::UnwatchGavinRoot { .. }
        | Request::WatchGavinRoot { .. }
        | Request::WriteInput { .. } => 1,

        Request::PromoteChecklistItem { .. } | Request::SetChecklistItem { .. } => 4,

        Request::LinkCardSession { .. } | Request::UnlinkCardSession { .. } => 5,

        Request::DeleteCardFile { .. } => 6,

        Request::SetRootConfigField { .. } => 7,

        Request::AddExternalGavinContext { .. } | Request::RemoveExternalGavinContext { .. } => 8,

        // 374eb7d bumped v9 and v10 together; attributed to 10, the
        // conservative direction (never sent to a v9 daemon).
        Request::GetOrchestration { .. }
        | Request::GetOrchestrationByRoot { .. }
        | Request::GitDirtyPaths { .. }
        | Request::NameSession { .. }
        | Request::SetOrchestration { .. }
        | Request::SetOrchestrationByRoot { .. }
        | Request::SetRailRun { .. }
        | Request::SetStepRun { .. } => 10,

        // v11 is reserved for the orchestration merge's tool requests
        // (SaveTool, GetTools, GetToolsByRoot, DeleteTool). They do not
        // exist on this branch. When that work lands, this match stops
        // compiling until its `=> 11` arm is added -- by design.
    }
}
```

> If the compiler reports a non-exhaustive match, a variant exists that this table predates. Add it at the current `PROTOCOL_VERSION` — never with a `_` arm.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p protocol`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/protocol/src/lib.rs
git commit -m "feat(protocol): MIN_COMPATIBLE_VERSION and the introduced-version table"
```

---

### Task 2: Tolerant request parsing, Shutdown, and the v12 bump

**Files:**
- Modify: `crates/protocol/src/lib.rs` (the `Request` and `Response` enums, `PROTOCOL_VERSION`)
- Test: `crates/protocol/src/lib.rs` (`mod tests`)

**Interfaces:**
- Consumes: `min_version_for` from Task 1.
- Produces: `Request::Unknown` (deserialize-only catch-all), `Request::Shutdown`, `Response::Unsupported { request_type: String, min_version: u32 }`, `PROTOCOL_VERSION == 12`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn an_unrecognised_request_type_parses_as_unknown_instead_of_erroring() {
    // The whole point: a future request must not be a parse error, because
    // handle_connection turns a parse error into a closed connection.
    let line = r#"{"type":"SomeFutureRequest","field":1}"#;
    let parsed: Request = serde_json::from_str(line).unwrap();
    assert!(matches!(parsed, Request::Unknown));
}

#[test]
fn malformed_json_is_still_an_error() {
    assert!(serde_json::from_str::<Request>("{not json").is_err());
}

#[test]
fn shutdown_is_a_v12_request() {
    assert_eq!(min_version_for(&Request::Shutdown), 12);
}

#[test]
fn protocol_version_is_twelve_until_a_breaking_change_bumps_it() {
    assert_eq!(PROTOCOL_VERSION, 12);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p protocol`
Expected: FAIL — unknown variants `Unknown` and `Shutdown`; version assertion fails at 10.

- [ ] **Step 3: Implement**

Set `pub const PROTOCOL_VERSION: u32 = 12;`.

Add to `Request` (the `Unknown` arm must be last):

```rust
    /// Asks the daemon to exit cleanly. Added in v12 so the app can stop
    /// a daemon it owns without `pkill`, which cannot distinguish this
    /// install's daemon from another's.
    Shutdown,
    /// Catch-all for a request from a NEWER client. Deserialize-only:
    /// never constructed or sent by us. Exists so an unrecognised
    /// `type` tag is a value rather than a parse error -- read_message
    /// propagates parse errors with `?`, which drops the whole
    /// connection and every push riding on it.
    #[serde(other)]
    Unknown,
```

Add to `Response`:

```rust
    /// Sent instead of dropping the connection when a request's `type`
    /// is unrecognised. `min_version` is advisory: this daemon cannot
    /// know which version introduced a variant it has never heard of,
    /// so it reports its own version as the ceiling it can serve.
    Unsupported { request_type: String, min_version: u32 },
```

Extend `min_version_for` with `Request::Shutdown => 12`, and:

```rust
        // Never sent -- it only exists to absorb a newer peer's request.
        // u32::MAX keeps it un-sendable if it ever reaches a send path.
        Request::Unknown => u32::MAX,
```

Also update the existing `protocol_version_is_*` test if one remains from v11.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p protocol`
Expected: PASS.

- [ ] **Step 5: Fix the fallout in the daemon and app**

`cargo build` will now fail wherever `Request` is matched exhaustively. Leave the real handling to Task 3; for now add explicit arms so the workspace compiles:

Run: `cargo build 2>&1 | grep -A 5 "non-exhaustive"`
Expected: a short list of match sites, in `crates/daemon/src/server.rs`.

- [ ] **Step 6: Commit**

```bash
git add crates/protocol/src/lib.rs crates/daemon/src/server.rs
git commit -m "feat(protocol): tolerant request parsing, Shutdown, protocol v12"
```

---

### Task 3: The daemon answers instead of hanging up

**Files:**
- Modify: `crates/daemon/src/server.rs:1532-1560` (`handle_connection`), and `handle_request`
- Test: `crates/daemon/src/server.rs` (`mod tests`)

**Interfaces:**
- Consumes: `Request::Unknown`, `Request::Shutdown`, `Response::Unsupported` from Task 2.
- Produces: a daemon that replies `Unsupported` to an unknown request and keeps the connection open.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn an_unknown_request_gets_a_reply_and_leaves_the_connection_usable() {
    let dir = tempfile::tempdir().unwrap();
    let manager = test_manager(&dir);

    // The regression this guards: before v12, an unparseable line closed
    // the socket, so the *next* request never got an answer at all.
    let unsupported = handle_request(&manager, Request::Unknown);
    assert!(matches!(unsupported, Response::Unsupported { .. }));

    let after = handle_request(&manager, Request::GetProtocolVersion);
    assert!(matches!(after, Response::ProtocolVersion { version } if version == protocol::PROTOCOL_VERSION));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p gavin-daemon an_unknown_request_gets_a_reply`
Expected: FAIL — `handle_request` has no arm for `Request::Unknown`.

- [ ] **Step 3: Implement**

In `handle_request`, add:

```rust
        Request::Unknown => Response::Unsupported {
            request_type: "unknown".to_string(),
            min_version: protocol::PROTOCOL_VERSION,
        },
```

In `handle_connection` (`server.rs:1536`), intercept `Shutdown` beside the existing `Attach` and `WatchGavinRoot` interceptions:

```rust
        if matches!(req, Request::Shutdown) {
            // Reply first so the caller knows it was heard, then exit the
            // whole process -- not just this connection's thread.
            let _ = write_message(&mut *writer.lock().unwrap(), &Response::Ok);
            std::process::exit(0);
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p gavin-daemon`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/daemon/src/server.rs
git commit -m "feat(daemon): reply Unsupported rather than dropping the connection"
```

---

### Task 4: Classify the daemon's version into a band

**Files:**
- Modify: `app/src-tauri/src/session.rs:554-568` (`verify_daemon_protocol`)
- Test: `app/src-tauri/src/session.rs` (`mod tests`)

**Interfaces:**
- Consumes: `MIN_COMPATIBLE_VERSION`, `PROTOCOL_VERSION`.
- Produces: `pub struct DaemonCompat { pub daemon_version: u32, pub app_version: u32, pub degraded: bool }`, `pub fn classify(daemon: u32, app: u32, floor: u32) -> Result<DaemonCompat, String>`, and `verify_daemon_protocol` returning `anyhow::Result<DaemonCompat>`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn an_exactly_matching_daemon_is_not_degraded() {
    let c = classify(12, 12, 5).unwrap();
    assert_eq!(c.daemon_version, 12);
    assert!(!c.degraded);
}

#[test]
fn an_older_daemon_inside_the_window_is_usable_but_degraded() {
    let c = classify(9, 12, 5).unwrap();
    assert!(c.degraded);
    assert_eq!(c.daemon_version, 9);
}

#[test]
fn the_floor_itself_is_inside_the_window() {
    assert!(classify(5, 12, 5).is_ok());
}

#[test]
fn a_daemon_below_the_floor_is_rejected() {
    let err = classify(4, 12, 5).unwrap_err();
    assert!(err.contains("too old"), "message should say what to do: {err}");
}

#[test]
fn a_daemon_newer_than_the_app_is_rejected() {
    let err = classify(13, 12, 5).unwrap_err();
    assert!(err.contains("newer"));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p app classify`
Expected: FAIL — `cannot find function classify`.

> The Tauri crate's package name is `app` (its lib is `app_lib`, its binary `Gavin`) — see `app/src-tauri/Cargo.toml:2`. That is why every `cargo test` here uses `-p app`.

- [ ] **Step 3: Implement**

```rust
/// What the app negotiated with the daemon it just connected to.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonCompat {
    pub daemon_version: u32,
    pub app_version: u32,
    /// True when the daemon is older than us but still inside the
    /// window: usable, with the newer requests gated off.
    pub degraded: bool,
}

/// Pure so the bands are testable without a daemon. Split out of
/// `verify_daemon_protocol`, which owns the I/O.
pub fn classify(daemon: u32, app: u32, floor: u32) -> Result<DaemonCompat, String> {
    if daemon > app {
        return Err(format!(
            "the gavin daemon is newer than this app (v{daemon} vs v{app}) — update the app"
        ));
    }
    if daemon < floor {
        return Err(format!(
            "the gavin daemon is too old to use (v{daemon}, minimum v{floor}) — restart it"
        ));
    }
    Ok(DaemonCompat { daemon_version: daemon, app_version: app, degraded: daemon < app })
}
```

Rewrite `verify_daemon_protocol` to return `anyhow::Result<DaemonCompat>`:

```rust
fn verify_daemon_protocol(command_conn: &Mutex<UnixStream>) -> anyhow::Result<DaemonCompat> {
    const UNREACHABLE: &str = "the gavin daemon is too old to talk to this app — restart it (quit gavin, then relaunch)";
    match send_command(command_conn, &Request::GetProtocolVersion) {
        Ok(Response::ProtocolVersion { version }) => {
            classify(version, protocol::PROTOCOL_VERSION, protocol::MIN_COMPATIBLE_VERSION)
                .map_err(|e| anyhow::anyhow!(e))
        }
        // A daemon too old to parse the probe closes the connection.
        // Preserved from the 2026-08-07 stale-daemon incident: this
        // failure SHAPE has to map to the same named state as an
        // explicit too-low version, not to a mystery.
        Ok(_) | Err(_) => anyhow::bail!(UNREACHABLE),
    }
}
```

Store the returned `DaemonCompat` in Tauri state so later tasks can read it. Add beside the existing `CommandConnection` state registration in `lib.rs`:

```rust
pub struct DaemonCompatState(pub Mutex<Option<DaemonCompat>>);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p app`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/session.rs app/src-tauri/src/lib.rs
git commit -m "feat(app): classify the daemon's protocol version into a support band"
```

---

### Task 5: Stop poisoning the command connection

**Files:**
- Modify: `app/src-tauri/src/session.rs:570-576` (`send_command`)
- Test: `app/src-tauri/src/session.rs` (`mod tests`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `send_command` that reconnects once and retries before failing.

Rationale: `gavin-mcp` has had this since it was written (`crates/gavin-mcp/src/main.rs:61-72`); the app never got it. Without it, a single failed command leaves `CommandConnection` closed forever, because nothing reconnects it — which turns one gated request into a permanently dead app.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn a_command_retries_once_on_a_closed_connection() {
    // Serve two connections: the first closes immediately (simulating a
    // daemon that hung up), the second answers properly.
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("retry.sock");
    let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();

    let server = std::thread::spawn(move || {
        let (first, _) = listener.accept().unwrap();
        drop(first);
        let (mut second, _) = listener.accept().unwrap();
        let mut reader = std::io::BufReader::new(second.try_clone().unwrap());
        let _req: Option<Request> = protocol::read_message(&mut reader).unwrap();
        protocol::write_message(&mut second, &Response::ProtocolVersion { version: 12 }).unwrap();
    });

    let conn = CommandConnection(Mutex::new(UnixStream::connect(&sock).unwrap()));
    let resp = send_command_reconnecting(&conn, &sock, &Request::GetProtocolVersion).unwrap();
    assert!(matches!(resp, Response::ProtocolVersion { version: 12 }));
    server.join().unwrap();
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p app a_command_retries_once`
Expected: FAIL — `cannot find function send_command_reconnecting`.

- [ ] **Step 3: Implement**

```rust
/// One reconnect per call, mirroring gavin-mcp's SocketTransport. The
/// daemon may have restarted, or hung up on a request it could not
/// parse; either way the connection is dead and nothing else revives it.
fn send_command_reconnecting(
    conn: &CommandConnection,
    socket_path: &Path,
    req: &Request,
) -> anyhow::Result<Response> {
    match send_command(&conn.0, req) {
        Ok(resp) => Ok(resp),
        Err(_) => {
            *conn.0.lock().unwrap() = UnixStream::connect(socket_path)?;
            send_command(&conn.0, req)
        }
    }
}
```

Route the app's command sites through this instead of `send_command`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p app`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/session.rs
git commit -m "fix(app): reconnect the command connection once before failing"
```

---

### Task 6: Refuse to put a too-new request on the wire

**Files:**
- Modify: `app/src-tauri/src/session.rs:538-540` (`send_request`)
- Test: `app/src-tauri/src/session.rs` (`mod tests`)

**Interfaces:**
- Consumes: `min_version_for` (Task 1), `DaemonCompat` (Task 4).
- Produces: `pub fn gate(req: &Request, compat: &DaemonCompat) -> Result<(), String>`.

This is the task that makes a degraded connection actually safe. Everything else is scaffolding around it.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn a_request_the_daemon_predates_is_refused_before_it_is_sent() {
    let compat = DaemonCompat { daemon_version: 9, app_version: 12, degraded: true };
    let too_new = Request::NameSession { session_id: "s-1".into(), name: "x".into() };
    let err = gate(&too_new, &compat).unwrap_err();
    assert!(err.contains("v10"), "should name the version needed: {err}");
    assert!(err.contains("v9"), "should name the version running: {err}");
}

#[test]
fn a_request_the_daemon_understands_passes() {
    let compat = DaemonCompat { daemon_version: 9, app_version: 12, degraded: true };
    assert!(gate(&Request::ListSessions, &compat).is_ok());
}

#[test]
fn an_exact_match_gates_nothing() {
    let compat = DaemonCompat { daemon_version: 12, app_version: 12, degraded: false };
    let newest = Request::NameSession { session_id: "s-1".into(), name: "x".into() };
    assert!(gate(&newest, &compat).is_ok());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p app gate`
Expected: FAIL — `cannot find function gate`.

- [ ] **Step 3: Implement**

```rust
/// The wire guard. An older daemon cannot PARSE a request it predates,
/// and a parse error there closes the whole connection (see
/// handle_connection) -- taking every push with it. So the check has to
/// happen here, before the bytes leave, not as error handling after.
pub fn gate(req: &Request, compat: &DaemonCompat) -> Result<(), String> {
    let needed = protocol::min_version_for(req);
    if needed > compat.daemon_version {
        return Err(format!(
            "this needs daemon protocol v{needed}, but the running daemon is v{} — restart the daemon to use it",
            compat.daemon_version
        ));
    }
    Ok(())
}
```

Apply it in `send_request`:

```rust
fn send_request(
    writer: &Arc<Mutex<UnixStream>>,
    req: &Request,
    compat: &DaemonCompat,
) -> anyhow::Result<()> {
    gate(req, compat).map_err(|e| anyhow::anyhow!(e))?;
    write_message(&mut *writer.lock().unwrap(), req)
}
```

Thread `DaemonCompat` (from `DaemonCompatState`) through every `send_request` and command call site the compiler flags.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p app`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/session.rs
git commit -m "feat(app): gate requests an older daemon cannot parse"
```

---

### Task 7: Surface the degraded state in the UI

**Files:**
- Create: `app/src/lib/DaemonCompatBanner.svelte`
- Modify: `app/src-tauri/src/lib.rs` (register a `daemon_compat` command)
- Modify: `app/src/lib/backend.ts` (add `daemonCompat()`)
- Modify: `app/src/lib/layoutState.ts` (a `daemonCompat` store)
- Modify: `app/src/routes/+page.svelte:102-107` (render the banner)
- Test: `app/src/lib/daemonCompat.test.ts`

**Interfaces:**
- Consumes: `DaemonCompat` from Task 4 (serialized camelCase: `daemonVersion`, `appVersion`, `degraded`).
- Produces: `export const daemonCompat: Writable<DaemonCompat | null>`, and `export function compatMessage(c: DaemonCompat | null, runningAgents: number): string | null`.

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/daemonCompat.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { compatMessage } from "./daemonCompat";

describe("compatMessage", () => {
  it("says nothing when the daemon matches", () => {
    expect(compatMessage({ daemonVersion: 12, appVersion: 12, degraded: false }, 3)).toBeNull();
  });

  it("says nothing when there is no daemon yet", () => {
    expect(compatMessage(null, 0)).toBeNull();
  });

  it("names both versions when degraded", () => {
    const msg = compatMessage({ daemonVersion: 9, appVersion: 12, degraded: true }, 0)!;
    expect(msg).toContain("v9");
    expect(msg).toContain("v12");
  });

  it("warns about the cost of restarting when agents are running", () => {
    const msg = compatMessage({ daemonVersion: 9, appVersion: 12, degraded: true }, 3)!;
    expect(msg).toContain("3");
  });

  it("does not pluralise a single agent", () => {
    const msg = compatMessage({ daemonVersion: 9, appVersion: 12, degraded: true }, 1)!;
    expect(msg).toContain("1 running agent");
    expect(msg).not.toContain("1 running agents");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npm test -- daemonCompat`
Expected: FAIL — cannot resolve `./daemonCompat`.

- [ ] **Step 3: Implement**

Create `app/src/lib/daemonCompat.ts`:

```ts
export type DaemonCompat = {
  daemonVersion: number;
  appVersion: number;
  degraded: boolean;
};

/// Null means "show nothing" -- the banner is for the degraded case only,
/// so a matching daemon stays completely silent.
export function compatMessage(c: DaemonCompat | null, runningAgents: number): string | null {
  if (!c || !c.degraded) return null;
  const base = `Running against an older daemon (v${c.daemonVersion}; this app speaks v${c.appVersion}). Some features are unavailable.`;
  if (runningAgents === 0) return base;
  const noun = runningAgents === 1 ? "1 running agent" : `${runningAgents} running agents`;
  return `${base} Restarting it will end ${noun}.`;
}
```

Add the Tauri command in `app/src-tauri/src/lib.rs`, reading `DaemonCompatState`:

```rust
#[tauri::command]
fn daemon_compat(app_handle: AppHandle) -> Option<session::DaemonCompat> {
    *app_handle.state::<session::DaemonCompatState>().0.lock().unwrap()
}
```

Register it in the `invoke_handler!` list beside `session::restart_daemon`.

Add to `backend.ts`, following the existing wrapper style in that file:

```ts
export async function daemonCompat(): Promise<DaemonCompat | null> {
  return await invoke<DaemonCompat | null>("daemon_compat");
}
```

Create `DaemonCompatBanner.svelte` rendering `compatMessage(...)` when non-null, with a "Restart daemon" button calling the existing `retryConnect` from `layoutState.ts:370`, and a dismiss control. Follow the styling of an existing banner-ish surface — `app/src/lib/BoardSelectionBar.svelte` uses `var(--surface-overlay)` and is the closest precedent.

Render it in `+page.svelte` inside the `{:else}` branch at line 108 — **not** in the error branch. A degraded daemon is a working app with a caveat, not an error screen.

- [ ] **Step 4: Gate the affordances whose requests are unavailable**

Without this the banner is cosmetic: the user still clicks into
Orchestration, the gate from Task 6 rejects the request, and they get a
failure instead of an explanation. Add to `daemonCompat.ts`:

```ts
/// Mirrors protocol::min_version_for for the UI's benefit. Only the
/// versions the UI actually branches on need entries here.
export const FEATURE_MIN_VERSION = {
  orchestration: 10,
  // `tools: 11` belongs here once the orchestration merge lands and
  // ToolLibraryDialog.svelte exists. It does not on this branch.
} as const;

export type Feature = keyof typeof FEATURE_MIN_VERSION;

/// Null when available; otherwise the reason to show as a tooltip.
export function featureBlockedReason(c: DaemonCompat | null, f: Feature): string | null {
  if (!c) return null; // not connected yet — don't pre-emptively grey things out
  const needed = FEATURE_MIN_VERSION[f];
  if (c.daemonVersion >= needed) return null;
  return `Needs daemon v${needed}; the running daemon is v${c.daemonVersion}. Restart the daemon to enable this.`;
}
```

Add the matching tests to `daemonCompat.test.ts`:

```ts
import { featureBlockedReason } from "./daemonCompat";

describe("featureBlockedReason", () => {
  const v9 = { daemonVersion: 9, appVersion: 12, degraded: true };

  it("blocks orchestration on a v9 daemon", () => {
    expect(featureBlockedReason(v9, "orchestration")).toContain("v10");
  });

  it("stops blocking orchestration at exactly v10", () => {
    const v10 = { daemonVersion: 10, appVersion: 12, degraded: true };
    expect(featureBlockedReason(v10, "orchestration")).toBeNull();
  });

  it("blocks nothing on a matching daemon", () => {
    const v12 = { daemonVersion: 12, appVersion: 12, degraded: false };
    expect(featureBlockedReason(v12, "orchestration")).toBeNull();
  });

  it("blocks nothing before a connection exists", () => {
    expect(featureBlockedReason(null, "orchestration")).toBeNull();
  });
});
```

Apply it at the entry point, disabling the control and using the
returned string as its `title`:

- `app/src/lib/OrchestrationHubView.svelte` — the `orchestration` feature

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd app && npm test -- daemonCompat`
Expected: PASS.

- [ ] **Step 6: Check types**

Run: `cd app && npm run check`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/daemonCompat.ts app/src/lib/daemonCompat.test.ts \
        app/src/lib/DaemonCompatBanner.svelte app/src/lib/backend.ts \
        app/src/lib/layoutState.ts app/src/routes/+page.svelte \
        app/src/lib/OrchestrationHubView.svelte \
        app/src-tauri/src/lib.rs
git commit -m "feat(app): banner and gating for a degraded daemon connection"
```

---

### Task 8: End-to-end proof against a genuinely older daemon

**Files:**
- Test: `app/src-tauri/tests/compat_window.rs` (create)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing — this is the verification gate for the plan.

- [ ] **Step 1: Write the failing test**

```rust
// A fake daemon pinned to v9: answers the probe, then records what it
// receives. Proves the app never puts a v10+ request on the wire, which
// is the property the whole window rests on.
#[test]
fn the_app_never_sends_a_request_a_v9_daemon_cannot_parse() {
    let compat = DaemonCompat { daemon_version: 9, app_version: 12, degraded: true };

    let too_new = [
        Request::NameSession { session_id: "s-1".into(), name: "x".into() },
        Request::SetStepRun {
            step_id: "s1".into(),
            state: "running".into(),
            session_id: None,
            reason: None,
        },
    ];
    for req in too_new {
        assert!(gate(&req, &compat).is_err(), "{req:?} should be gated at v9");
    }

    let fine = [Request::ListSessions, Request::GetBoard { workspace_id: "w".into() }];
    for req in fine {
        assert!(gate(&req, &compat).is_ok(), "{req:?} should pass at v9");
    }
}
```

- [ ] **Step 2: Run it**

Run: `cargo test -p app --test compat_window`
Expected: PASS once Tasks 1–6 are in.

- [ ] **Step 3: Manual smoke**

Build a daemon pinned low and confirm the real app degrades rather than erroring:

```bash
# In a scratch checkout, set PROTOCOL_VERSION = 9, build, and run it:
cargo build -p gavin-daemon
pkill -x gavin-daemon; ./target/debug/gavin-daemon &
cd app && npm run tauri dev
```

Expected: the app **connects**. The banner names v9 and v12. Terminal sessions work. The Orchestration affordance is disabled with a tooltip naming v10. No error overlay.

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/tests/compat_window.rs
git commit -m "test(app): prove the compat window gates the right requests"
```

---

## Done when

- A v9 daemon yields a working app with a banner, not an error screen.
- A v4 daemon still yields today's error screen.
- No request that a connected daemon predates can reach the wire.
- `cargo test` and `npm test` are green.
