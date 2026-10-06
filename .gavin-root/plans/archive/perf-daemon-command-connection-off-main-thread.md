---
order: 17408
kind: task
title: "[perf] Daemon command connection: move the family off the main thread as one unit"
labels: bug
parent: perf-main-thread-command-audit.md
status: Done
---
Every request/response daemon command (get_board, get_orchestration,
set_orchestration, get_gavin_tree, list_managed_sessions, card_runs,
tool_runs, set_rail_run, set_step_run, set_plan_frontmatter_field,
archive_card, end_orphan, kill_session, …) is a plain `fn`, and all of them
share ONE blocking connection with no read timeout. This card is the
prerequisite for moving any of them off the main thread.

## Evidence (2026-09-26)

- `CommandConnection(pub Mutex<Stream>)` (app/src-tauri/src/session.rs:2618).
  `send_command` (:2696-2702) locks it, writes, then blocks reading one
  line, holding the lock across the round trip. `Stream` is a blocking
  `UnixStream` with no read or write timeout (crates/protocol/src/transport.rs:137-139;
  the only `set_read_timeout` in the app is daemon.rs:283, the Shutdown path).
- `send_command_reconnecting_at` (:3044-3056) retries once and RESENDS the
  request — a duplicated write for CreateSession-type requests. The
  reconnect sends no Hello, so the connection drops to the `local` role.
- The daemon handles one connection's requests strictly in order on one
  thread (crates/daemon/src/server.rs:5242-5390), so one slow handler
  delays every later request.
- Worst case today: a wedged handler blocks the main thread with no bound.
  Down/restarting daemon fails fast (ECONNREFUSED/EPIPE, <1 ms).
- Measured main-thread cost now: `set_orchestration` 0.26 s/min,
  `list_managed_sessions` 0.1–0.2 s/min (polled every 5 s by
  memoryState.ts, every 4 s by AppHubView, every 2 s by
  SessionsManagerModal), `get_board` 0.1 s/min.

## Why not just `spawn_blocking` each command

The mutex becomes the queue: an off-thread GetGavinTree or EndOrphan
holding it makes every still-sync command wait on the MAIN thread instead —
the freeze moves, it does not go away. And a pthread mutex is not FIFO, so
racing tasks reorder writes like `set_step_run` ("done" overtaken by an
earlier "running" re-runs finished work).

## Fix

- One worker thread per connection (local + each ssh link) that owns the
  `Stream`, fed by a FIFO of `(Request, oneshot reply)`. Commands become
  `async fn … -> Result<T, String>`: compute the `Route` (Send + 'static),
  enqueue, await the oneshot. They already return `Result`.
- A read deadline per request (generous for EndOrphan), and fail fast while
  a restart is swapping the connection.
- Give slow reads (GetGavinTree, SessionProcesses, ScanGavinRoot) a second
  connection; the daemon serves one thread per connection (server.rs:5075).
- Reconnect should re-Hello (role + compat) rather than run as `local`.
- Frontend tokens needed before answers can arrive after newer pushes:
  `refreshBoard` (app/src/lib/board/kanbanState.ts:93),
  `refreshOrchestration` (orchestrationState.ts:416), `refreshGavinTree`
  (app/src/lib/core/gavinState.ts:102 — no guard at all). Already guarded:
  AppHubView `sessionsEpoch`, SessionsManagerModal `epoch`, memoryState
  `polling`, turnVerdictDriver, runHistoryState, toolRunsState.
- Whole-state writes (`set_board`, `set_orchestration`) and last-write-wins
  rows rely on FIFO order — the worker preserves it.

## Verify

Rust tests: requests from N tasks reach the daemon in enqueue order; a
wedged fake daemon times out instead of blocking; a reconnect re-Hellos.
Add the converted commands to `OFF_MAIN_THREAD` in
`app/src/lib/guards/mainThreadCommands.test.ts` (extend the guard to
accept the worker-queue shape, not only `spawn_blocking`).

## Progress

- [x] `command_lane.rs`: one worker thread per connection owning the `Stream`, FIFO of (Request, oneshot); per-request read deadline; drop-and-redial on timeout; redial re-probes the version and re-Hellos; fail fast while a restart swaps the connection; unsolicited device pushes skipped
- [x] Local daemon gets two lanes (main + reads: GetGavinTree, SessionProcesses, ScanGavinRoot); each ssh link one lane
- [x] Every command on the command connection becomes `async fn` (route → enqueue → await), none left as a plain `fn`
- [x] Frontend: supersession tokens on refreshBoard / refreshOrchestration / refreshGavinTree (and the first loads); write order documented as the callers' contract rather than chained
- [x] Rust tests: FIFO order from N threads, wedged daemon times out, redial re-Hellos
- [x] Guard: converted commands in `OFF_MAIN_THREAD`, worker-queue shape accepted, no sync command left on the lane
- [ ] Human test: In the app built from perf/main-thread-commands: move a card on the board, start and pause a rail, open the Sessions manager, then Restart daemon from Settings — the window never freezes, and the board, rails and Sessions manager all work again after the restart without relaunching the app.

## Outcome (2026-09-26, uncommitted on perf/main-thread-commands — the rail's commit step takes it)

- `app/src-tauri/src/command_lane.rs`: `CommandLane` (one worker thread
  owns the `Stream`; unbounded FIFO of `(Request, oneshot)`; `submit`
  gates and never blocks) and `DaemonLanes` (main + reads lane, compat).
  `CommandConnection` is now two lanes; each `RemoteLink.command` is one.
  46 commands in session.rs became `async fn`: route → `lanes_for(..)` →
  `.request(req).await`. Only config getters/setters, `write_input` /
  `resize_session` / `snapshot_session` / `watch_gavin_root` (streaming
  writer) and `restart_daemon` / `stop_daemon` stay sync.
- Deadlines (`deadline_for`): 30 s default, RunGit/RunGitEnv 600 s,
  tree reads and TrashWorkspacePath 120 s, EndOrphan 60 s. EndOrphan
  stays on the MAIN lane as the card said; the end-orphan card can move
  it to the reads lane if its 2 s grace per orphan matters there.
- Local lane timeout: drop the connection; the next request redials with
  a version probe (a different daemon version refuses) and a `Hello`.
  A failure after the write is never resent (the old CreateSession
  duplicate). Link lane (no redial): a timeout keeps the connection and
  drops the owed late answer when it arrives.
- Restart: `reconnect` begins a swap (requests fail fast with "restarting"),
  and `finish_swap` hands each lane its new connection through the FIFO.
  A request gated for a different daemon version than the lane is on is
  refused. `restart_daemon` itself is still sync — its own card.
- Device pushes arriving on an `app` command connection are skipped (a
  test reads the daemon's `push_to_apps` calls so a new broadcast fails it).
- NOT done, deliberately: per-workspace write chains. Enqueue order is the
  order commands reach `submit`, not invoke order (Tauri spawns async
  commands on a multi-thread runtime); every ordered writer already awaits
  its previous write, and chaining would break the board's overlapping-save
  semantics. Documented in the module header.
- Frontend: supersession epochs on `refreshBoard`, `refreshOrchestration`,
  `refreshGavinTree` and the first loads (`fetchBoard`, `fetchOrchestration`),
  bumped by every push, save and read.
- Verified: cargo test --workspace, npm test / check / build green; lane
  tests 70 runs at `--test-threads=32` under load ~30 with no failure after
  fixing a macOS EINVAL-after-peer-close read bug the stress loop found;
  a real v42 daemon under an isolated `$HOME` answered both lanes, and with
  `require_local_token` on, CreateSession succeeded after the daemon was
  restarted underneath (re-Hello) while an untokened connection got
  `Forbidden`. The guard test fails any command reaching a lane that is a
  plain `fn` or blocks with `.ask(`.
