# Daemon version compatibility and OTA updates

Date: 2026-08-24
Status: design

## Problem

Gavin ships three binaries with independent process lifetimes:

| Binary | Lifetime | Who controls it |
|---|---|---|
| `Gavin.app` | user opens/closes the window | the updater |
| `gavin-daemon` | outlives the app, owns every PTY | itself |
| `gavin-mcp` | one process per Claude Code session | Claude Code |

Today the app and `gavin-mcp` both demand an exact protocol match
(`app/src-tauri/src/session.rs:562`, `crates/gavin-mcp/src/main.rs:33`).
Anything else is a hard `bail!`, and the app's only recovery is a single
button — "Restart daemon & retry" (`app/src/routes/+page.svelte:106`) —
which `pkill -x gavin-daemon`s (`app/src-tauri/src/daemon.rs:59`).

That restart is destructive. PTYs are children of the daemon
(`crates/daemon/src/pty.rs:17`), and `recover()`
(`crates/daemon/src/server.rs:974`) re-spawns *fresh* shells from
registry records. It restores tab identity, not process state. Every
running agent dies.

In development this is an occasional annoyance after a rebuild. **Under
OTA it becomes the normal path on every single update**, because of a
property that is deliberate: the daemon outlives the app, so closing the
window leaves your agents running. That feature is exactly what
guarantees a freshly-updated app meets a stale daemon.

Four things that are dev-only shortcuts today and become production
problems:

1. `pkill -x gavin-daemon` is name-based — it would kill daemons
   belonging to other installs and other versions on the same machine.
2. `run_server` refuses to start when one is already listening
   (`crates/daemon/src/server.rs:1503`), so a single fixed socket path
   means two daemons can never coexist.
3. `agent_setup.rs:223` writes an **absolute** `gavin-mcp` path into
   `.mcp.json` files inside the user's own repos — outside anything the
   updater manages.
4. `tauri.conf.json` has no updater plugin and no `externalBin` entry.
   The three binaries currently just happen to land in the same
   `target/` directory.

## Goals

- A user with running agents is never forced to choose between updating
  and keeping their work.
- Updates are user-initiated and unobtrusive. Nothing is forced,
  nothing is modal.
- A stale daemon inside a supported version window is usable, not an
  error screen.
- A running Claude session's `gavin-mcp` survives a daemon upgrade
  without the user restarting anything.

## Non-goals

- Session survival across a daemon restart (PTY handoff / re-parenting).
  That would make this whole problem disappear, and it is a much larger
  piece of work. Explicitly deferred.
- Tolerating a daemon *newer* than the client. Once updates are
  choreographed this should not occur; it stays a hard error.
- Auto-updating without user action.

## Design

### 1. The versioning contract

Two constants in `crates/protocol/src/lib.rs`:

```rust
pub const PROTOCOL_VERSION: u32 = 12;        // bumps on ANY wire change
pub const MIN_COMPATIBLE_VERSION: u32 = 5;   // bumps ONLY on a breaking change
```

`PROTOCOL_VERSION` goes 11 → 12 because this work is itself a wire
change: it adds `Request::Shutdown` (§6) and the `#[serde(other)]`
catch-all on `Request` (below).

A client at version `P` accepts a daemon at version `D` when
`MIN_COMPATIBLE <= D <= P`. This three-way gate replaces the equality
check -- but Phase 1 (this branch) wires it into the **app only**:

| Band | Behaviour |
|---|---|
| `D == P` | normal operation |
| `MIN_COMPATIBLE <= D < P` | connect; gate features; show a banner |
| `D < MIN_COMPATIBLE` | today's hard error, unchanged |
| `D > P` | hard error (app), re-exec (`gavin-mcp`, see §3) |

> **Phase 1 is app-only.** `gavin-mcp` (`crates/gavin-mcp/src/main.rs:33`)
> still demands strict equality (`version == PROTOCOL_VERSION`) and bails
> otherwise -- it was not brought into this window. The consequence is
> concrete, not theoretical: against a v9 daemon the app connects
> degraded and gates its own requests, while `gavin-mcp` refuses to
> connect at all, so every one of its 14 request types fails, including
> the 9 that are plain v1 requests (`CreateGavinContext`, `CreatePlan`,
> `GetBoardByRoot`, `GetProtocolVersion`, `InitGavinRoot`, `ReadPrd`,
> `ScanGavinRoot`, `SetPlanFrontmatterField`, `SpawnAgentSession`) and
> would work fine against that daemon unmodified. Its refusal message
> also tells the user to `pkill gavin-daemon` and relaunch -- the
> destructive restart, killing every running agent, that this whole
> feature exists to stop recommending. Tracked as a follow-up card,
> `.gavin-root/plans/gavin-mcp-compat-window.md`; gating `gavin-mcp` the
> same way is a separate decision, deliberately left to a human rather
> than implemented alongside this branch.

#### Client-side capability gating is the load-bearing mechanism

The obvious way to make a mismatched connection safe is to make the
daemon tolerant: a `#[serde(other)]` catch-all on `Request`, replying
`Response::Unsupported` instead of dropping the socket. Today an
unrecognised `type` tag is a hard `serde_json::from_str` error in
`read_message` (`crates/protocol/src/lib.rs:626`), which
`handle_connection` (`crates/daemon/src/server.rs:1537`) propagates with
`?`, breaking the loop and closing the connection. The accept loop
prints `connection error` and moves on. **One unknown request kills the
whole connection**, and with it every push that connection carried.

But daemon tolerance only protects against daemons built *after* it
ships. Every v11 daemon already in the wild still closes the socket, so
`MIN_COMPATIBLE` could only ever be set to the version that introduced
the tolerance. A compat window built that way starts empty and stays
empty for months.

The mechanism that works retroactively is the mirror image. The client
carries a table of which `Request` variant was introduced in which
protocol version, and against a `D`-version daemon it never sends
anything newer. This needs no daemon change at all, so it works against
daemons that already exist.

The table below is **derived from the diffs**, by extracting the
`Request` enum's variants at each version-bumping commit and diffing
consecutive sets.

| Version | `Request` variants introduced |
|---|---|
| v1 | `Attach`, `CreateGavinContext`, `CreatePlan`, `CreateSession`, `DeleteBoard`, `GetBoard`, `GetBoardByRoot`, `GetGavinTree`, `GetProtocolVersion`, `InitGavinRoot`, `KillSession`, `ListSessions`, `ReadPrd`, `ResizeSession`, `ScanGavinRoot`, `SetBoard`, `SetPlanFrontmatterField`, `SpawnAgentSession`, `UnwatchGavinRoot`, `WatchGavinRoot`, `WriteInput` |
| v2, v3 | *(none — type and semantic changes only)* |
| v4 | `PromoteChecklistItem`, `SetChecklistItem` |
| v5 | `LinkCardSession`, `UnlinkCardSession` |
| v6 | `DeleteCardFile` |
| v7 | `SetRootConfigField` |
| v8 | `AddExternalGavinContext`, `RemoveExternalGavinContext` |
| v9 | *(none)* |
| v10 | `GetOrchestration`, `GetOrchestrationByRoot`, `GitDirtyPaths`, `NameSession`, `SetOrchestration`, `SetOrchestrationByRoot`, `SetRailRun`, `SetStepRun` |
| v11 | `DeleteTool`, `GetTools`, `GetToolsByRoot`, `SaveTool` |

**No `Request` variant has ever been removed or renamed.** Every bump
was purely additive on the request side, which is what makes client-side
gating viable at all.

> The v10 band is not a simple single-commit ambiguity. Seven of its
> eight variants (`GetOrchestration`, `GetOrchestrationByRoot`,
> `GitDirtyPaths`, `SetOrchestration`, `SetOrchestrationByRoot`,
> `SetRailRun`, `SetStepRun`) landed on the wire across three commits over
> three days -- `6821fc8`, `c7ecfce`, `35b26dd` (2026-08-21) -- while
> `PROTOCOL_VERSION` stood still at 8 through all of them: real wire
> changes shipped with no bump. Only `NameSession` genuinely arrived with
> the commit that finally moved the constant, `374eb7d` (2026-08-24,
> "agent tab naming (v9) and archive-aware plan writes (v10)"), which
> jumped it straight 8 → 10 -- which is why the table has no v9 entry at
> all.
>
> That gap is exactly what makes the table's derivation method
> trustworthy rather than merely lucky: it diffs the `Request` enum's
> variant set at each *version-bumping* commit, so a variant always lands
> in the bucket keyed by whatever `PROTOCOL_VERSION` had reached by the
> next bump after it shipped -- never in an earlier one. **The derivation
> always attributes a variant to a version greater than or equal to its
> true introduction, never less — it errs conservatively by
> construction.** A client gating on this table can refuse a variant to a
> daemon slightly newer than strictly necessary; it will never send a
> variant to a daemon too old to parse it, even when the commit history
> that introduced it forgot to bump the version that says so.

#### Where the floor comes from

`MIN_COMPATIBLE_VERSION = 5` is derived, not chosen. Walking the bumps
backwards for *shape* changes — removed or retyped fields, in `Request`
and `Response` alike — exactly one breaking change exists:

- **v4 → v5** (`b51c415`): `Response::Board { columns, labels }` gained
  `card_sessions`, with no `#[serde(default)]`. A v4 daemon replies with
  a two-field `Board` and a v5+ client fails to deserialize it. This is
  the response-direction break warned about below, and it is what sets
  the floor.
- **v6 through v11** changed no shapes. The only structural edit in that
  range is v11 adding `tool_id` and `tool_params` to `Step`, and both
  carry `#[serde(default)]` (`crates/protocol/src/lib.rs:422-430`), so a
  v10 daemon's `Step` JSON still parses.

That yields a seven-version window, v5 through v11.

> **Residual risk:** this audit detects *structural* change. A field that
> kept its shape but changed meaning would not show up. Nothing in the
> reviewed diffs suggests one, but the window rests on that assumption.

If the floor ever needs to go lower, adding `#[serde(default)]` to
`Response::Board::card_sessions` would make v4 parse as well. Not worth
doing now — v3 was a large card-model rewrite, so the next barrier is
close behind.

Daemon-side tolerant parsing is still worth building, as defense in
depth for future versions, but it is not what makes this work.

#### Response compatibility

Compatibility runs in both directions. The app deserialises the
daemon's `Response`, and `#[serde(default)]` appears on only ~9 fields
across the whole protocol. If a bump changed a variant's shape rather
than adding one, the *app* is the side that fails to parse and drops the
connection. The audit must cover `Response` as well as `Request`.

#### Supporting changes

- The app's `CommandConnection` (`session.rs:552`) gets the
  reconnect-on-error that `gavin-mcp` already has
  (`SocketTransport::request`, `main.rs:61-72`). Without it, one failure
  poisons that connection permanently, because nothing reconnects it.
- The negotiated capability set flows to the frontend as a store, so
  gated UI disables itself with a tooltip naming the version it needs,
  rather than failing on click.

### 2. Update delivery

`tauri-plugin-updater` v2, with `pubkey` and `endpoints` in
`tauri.conf.json` and signed artifacts produced in CI.

Packaging adds `externalBin` entries for `gavin-daemon` and `gavin-mcp`,
so they ship inside `Contents/MacOS/` beside the app binary. This is
what keeps the existing sibling lookups working unchanged:
`resolve_daemon_binary_path` (`daemon.rs:11`) and
`resolve_mcp_binary_path` (`agent_setup.rs:205`) both join against
`current_exe().parent()`.

> **Assumption to verify:** Tauri's `externalBin` appends a target-triple
> suffix to source filenames and is expected to strip it when bundling.
> If it does not, both sibling lookups break. Verify before building on
> this.

In-place bundle replacement also keeps the absolute `gavin-mcp` paths
already written into users' `.mcp.json` files valid, and is what makes
the re-exec in §3 possible.

### 3. gavin-mcp self re-exec

When `SocketTransport::connect` sees a daemon newer than itself,
`gavin-mcp` `exec()`s `current_exe()` — the path the update has already
replaced with the new binary.

This is cheap because `handle_line` (`main.rs:555`) is **stateless**.
`initialize` echoes the requested `protocolVersion` and returns static
capabilities; nothing persists between calls. The only per-process state
is `root` (re-derived from cwd, which `exec` inherits) and a lazily
established socket. The MCP client's handshake does not need replaying:
the next `tools/call` behaves identically against a fresh process.

Three details make it correct:

1. **The in-flight request.** `exec` replaces the image, so the line
   being handled is lost and the client hangs on that id. Pass it
   forward in an environment variable; the new process handles it before
   reading stdin.
2. **Buffered stdin.** `stdin.lock().lines()` (`main.rs:602`) wraps a
   `BufReader` that may hold pipelined bytes not yet consumed. Those
   live in userspace and are discarded by `exec` — unread bytes still in
   the pipe are fine, but anything already read into the buffer is gone.
   The read loop must stop over-reading, or carry the buffered remainder
   forward alongside the in-flight line. **This is the one real
   correctness trap in the feature.**
3. **Loop guard.** A generation counter in the environment, refusing to
   exec more than once, so a broken or mis-versioned binary cannot spin.

If exec fails for any reason (binary missing, permissions), fall back to
returning a clear tool error naming the problem, rather than the current
cryptic bail.

### 4. Update UI

The sidebar footer's Settings row (`app/src/lib/Sidebar.svelte:874`) is
currently `disabled title="Coming soon"`. The update control is its
first live element, following the `IconButton` pattern already used by
the `theme-row` directly below it.

- A background check on launch and periodically sets an
  `updateAvailable` store. Silent when there is nothing to report.
- When an update exists, an `IconButton` appears in the Settings row.
  Absent entirely otherwise — no permanent badge.
- Clicking opens a small panel: version, release notes, and **the count
  of running agents a restart would end**.
- Confirming downloads, installs, stops the daemon, and relaunches.
- Not clicking does nothing, indefinitely. The user keeps the old
  version for as long as they like. This is the primary answer to
  "let me keep using the older version" — the old version is never taken
  away, so mismatch never has to be tolerated in the common case.

### 5. Stale daemon at launch

The residual case: the user updates, quits without relaunching, and the
daemon keeps running old code. Later they launch the new app and it
finds a stale daemon holding live agents.

The overlay at `+page.svelte:102` splits by band:

- `D < MIN_COMPATIBLE` — today's error screen, one button, unchanged.
- `MIN_COMPATIBLE <= D < P` — not an error at all. The app connects and
  shows a dismissible banner offering "Restart daemon", labelled with the
  count of agents that would end. Gated features disable themselves from
  the capability store.

### 6. Daemon lifecycle in production

- Replace `pkill -x gavin-daemon` with a pidfile written beside the
  socket, so only *this* install's daemon is targeted.
- Add `Request::Shutdown` for a polite stop, retaining `pkill` purely as
  the last-resort fallback for a daemon too old to parse anything —
  which is the case it was originally written for.
- Keep the socket path stable and single. Discovery of the running
  daemon depends on it; per-install socket paths would break the very
  detection this design relies on.

## Testing

- An exhaustive `match` over `Request` producing its introduced-version,
  so a new variant cannot be added without a table entry.
- `MIN_COMPATIBLE_VERSION <= PROTOCOL_VERSION` as an invariant test.
- Integration tests running a daemon pinned to a lower version:
  the app connects, gates the right features, and never puts a too-new
  request on the wire.
- A re-exec test covering the buffered-stdin case (§3, detail 2):
  two requests written in one pipe flush, with the version mismatch
  detected on the first, asserting the second still gets a reply.
- A test that the capability store disables the expected UI affordances
  for a given `D`.

## Open items

1. ~~**The audit.**~~ **Done 2026-08-24.** Result folded into §1:
   `MIN_COMPATIBLE_VERSION = 5`, window v5–v11, request side purely
   additive throughout.
2. **`externalBin` suffix stripping** (§2), which both sibling lookups
   depend on.
3. **Update endpoint hosting and signing key custody** — where the
   manifest lives and who holds the private key. Out of scope for the
   code, but blocking for shipping.
4. **v11 is uncommitted.** `HEAD` is at v10; the v11 bump lives in this
   worktree's in-flight orchestration merge. The plan assumes v11 lands
   first, since it renumbers what this work calls v12.
