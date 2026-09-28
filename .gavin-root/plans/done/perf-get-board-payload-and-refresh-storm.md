---
order: 14336
kind: task
title: "[perf] get_board ships every launch prompt, on every tree push"
labels: bug
parent: perf-main-thread-command-audit.md
status: Done
---
`get_board` (app/src-tauri/src/session.rs:5106) returns every `card_sessions`
row WITH its full launch prompt, and the app re-fetches it on every
gavin-tree push for every watched workspace. It also has a size cliff that
will stop the board loading.

## Evidence (2026-09-26)

- Measured daemon round trip: 14 ms for a 440 KB reply (gavin), 450 KB
  (mandragora), plus debug-build deserialise + re-serialise to the webview
  (est. +10–30 ms), on the main thread.
- The gavin board holds 288 bindings; 325 KB of their text is the
  `command` column (launch prompts). It only grows.
- Triggers: `refreshBoard` on every `gavin-tree-changed` for all 9 watched
  workspaces (app/src/lib/core/gavinState.ts:77) — every card write by any
  agent pushes one; window focus × each mounted board surface
  (KanbanBoard.svelte:101-102, BoardPane.svelte:64-67,
  CardTabPane.svelte:60-63); tab mounts; after deletes/archives.
- **Cliff:** a protocol line is capped at `MAX_LINE_BYTES` = 1 MiB
  (crates/protocol/src/lib.rs:12, enforced :3288-3292). Past it
  `read_message` fails, `send_command_reconnecting` resends GetBoard, that
  fails too, and the board stops loading. Extrapolated: ~650 bindings for
  gavin, ~440 for mandragora.

## Fix

1. Stop shipping `command` in the Board read. Fetch a binding's launch
   command only where it is used (Re-launch / resume), by (workspace, path).
   This is a protocol change: new request type + `min_version_for` entry,
   and a `FEATURE_MIN_VERSION` + `featureBlockedReason` consumer on every
   surface that re-launches (CLAUDE.md, "The compat gate is per request
   TYPE").
2. Coalesce `refreshBoard` per workspace (one in flight + a dirty flag), so
   a burst of tree pushes costs one read.
3. Moving the command off the main thread belongs to the command-connection
   card — do not `spawn_blocking` it alone (shared mutex).
4. `refreshBoard` (app/src/lib/board/kanbanState.ts:93) needs a per-workspace token before its
   answers can arrive out of order.

## Verify

A daemon test that a board with N large bindings serialises under a fixed
size. A frontend test that N pushes in one tick issue one read. Then check
the reply size with a read-only GetBoard round trip against the dev daemon.

## Progress

Items 3 and 4 already landed on `perf/main-thread-commands` (458f5a77 command
lanes, aeb98c63 per-workspace board epochs).

- [x] Daemon: the board read leaves `command` out; `GetCardSession` (v43) returns one binding whole
- [x] Host: `card_session` command, falling back to GetBoard against a pre-v43 daemon; the board the webview gets carries no command
- [x] App: board binding type without `command`; Re-launch reads the command by (workspace, path)
- [x] App: coalesce board reads per workspace (one in flight, one trailing)
- [x] Tests: N large bindings serialise under a fixed size; N pushes in one tick issue one read
- [x] Verify: read-only GetBoard round trip against the dev daemon
- [ ] Human test: In an app built from this branch, Re-launch a card from its card menu (once on the current daemon, once after restarting it at v43): the agent starts with that card's original prompt, not a bare shell

## Outcome (2026-09-26, uncommitted on perf/main-thread-commands — the rail's commit step takes it)

- Protocol v43: `CardSession.command` is `serde(default, skip_serializing_if
  = None)`; the daemon's `read_board` no longer SELECTs `command`, so
  `GetBoard` and `GetBoardByRoot` (gavin-mcp's `gavin_get_board` and
  `gavin_get_orchestration`) carry none. New `GetCardSession { workspace_id,
  path }` → `Response::CardSession { card_session: Option<CardSession> }`,
  the one read with the command (`KanbanStore::card_session`, which the
  claim path already used). `min_version_for` 43; the agent role denies it.
- Host: `card_session` command. Against a daemon before 43 (decided per
  route, so an ssh host's own version) it reads that daemon's `GetBoard`,
  which still carries the command, and picks the card out. So Re-launch
  works across the skew. That is why there is **no** `FEATURE_MIN_VERSION`
  entry or `featureBlockedReason` consumer, a deliberate departure from
  Fix 1: nothing is blocked, so nothing is greyed. `get_board` strips
  `command` from any board before the webview gets it.
- App: `CardSession` (board) has no `command`; `CardSessionRecord` does.
  `relaunchCard`, the only reader, fetches the binding by card after its
  gates. A null or failed read returns an error rather than launching a
  bare shell. `linkCardSessionAction` keeps the command off the optimistic
  board entry.
- Coalescing: `fetchBoard` and `refreshBoard` share one per-workspace
  reader. One read is in flight at a time. Callers in the same task join it
  (it leaves after a microtask, not a timer), and later callers mark it for
  one trailing read. The epochs from aeb98c63 still guard against saves.
- Measured, read-only, on the same data: the shared dev daemon (v41)
  answered gavin's board with 512,826 B in 15.8 ms and mandragora's with
  456,035 B in 13.7 ms. A v43 daemon under a temp `$HOME`, on a snapshot
  of the same `kanban.sqlite`, answered 115,235 B in 5.1 ms and 85,597 B
  in 3.8 ms, with `GetCardSession` about 1 KB. gavin now holds 311
  bindings (386 KB of commands), up from 288 this morning. The rest is
  about 370 B per binding, so the 1 MiB cliff moves from about 650 runs to
  about 2,800.
- Tests: protocol gate and wire shape; daemon size bound (400 bindings
  with 1.6 MiB of commands serialise identically to none, under 160 KB),
  single-binding read, request round trip; host parity path, v42 fallback
  (only `GetBoard` reaches the wire), and board stripping; app coalescing
  (20 refreshes in one task → 1 read; 3 during a read → 1 trailing;
  per-workspace; fetch + refresh → 1), a gavinState push burst (14 pushes
  over 2 workspaces → 2 reads), and Re-launch via `cardSession` (null and
  error refuse). All new app tests were red against the old code.
  `cargo test --workspace`, `npm test`, `npm run check` and `npm run build`
  are green.
- Not done: bindings for finished cards are never pruned, which is why
  gavin carries 311 of them. That is the remaining growth, now about 370
  B per run.

