---
order: 14336
kind: plan
title: "[perf] Commands that freeze the UI: audit of every Tauri command"
labels: bug
status: To Do
---
Every host command was audited on 2026-09-26 for what it can block on, how
long, and how often the frontend calls it. Line numbers are as of main
880e7e3c plus the uncommitted `pr_status` fix
([fix-ui-freezes-from-main-thread-gh-calls.md](./done/fix-ui-freezes-from-main-thread-gh-calls.md)).

## Why this is one family

Tauri 2 runs a plain `#[tauri::command] pub fn` inline on the MAIN thread
(`ExecutionContext::Blocking`). While it runs the window takes no events:
the cursor spins, keystrokes into a terminal queue and replay afterwards,
and only Core-Animation spinners keep moving. So a command's latency, times
how often the UI calls it, is frozen-window time. Nearly every command in
the app (all of session.rs, git/, fileviewer.rs, …) is a plain `fn`. The
suites cannot see any of this: nothing runs under Tauri.

The fix pattern is `async` + `tauri::async_runtime::spawn_blocking`
(`get_git_baselines`, `pr_status`, `git_run_changes`, `typesafe_verdict`),
pinned by `app/src/lib/guards/mainThreadCommands.test.ts`. Two things make
it more than a mechanical rewrite:

1. **The daemon command connection is one `Mutex<Stream>` with no read
   timeout** (`CommandConnection`, session.rs:2618; `send_command` :2696
   holds the lock across the round trip). Moving ONE daemon command off
   the main thread turns that mutex into the queue: every still-sync
   command behind it now waits on the main thread instead. Daemon-side
   commands move as a family — see the command-connection card.
2. **The main thread was an accidental serialiser.** Once calls run
   concurrently, answers arrive out of order and bursts run in parallel.
   Every store-writing caller needs a supersession token, and pollers need
   single-flight.

## How it was measured

- `sample <Gavin pid> 60 1 -mayDie -file out.txt`, then main-thread samples
  tallied by the first `app_lib::<module>::<command>` frame under the
  invoke closure. ~1.2 ms per sample.
- A `ps` loop over the app pid's children (`gh pr view|git `) for a
  timeline, which `sample` does not give.
- Read-only timings of the underlying git / CLI / daemon round trips.

Measured main-thread time per minute (dev build, 10 workspaces, ~24
sessions): before the `pr_status` fix `pr_status` 12.3 s (gone after it);
then with a Git view open `git_repo_info` 2.9–3.0 s, `git_refs` 1.9–2.2 s,
`git_status` 0.7–1.5 s, `agent_usage` 1.1–1.6 s, `watchman_status`
0.2–1.2 s, `git_merge_tool_name` 0.4 s, `set_orchestration` 0.26 s,
`list_managed_sessions` 0.1–0.2 s, `get_board` 0.1 s.

## Cards, by expected payoff

HANGS = measured or routinely ≥100 ms on a common trigger. MIGHT-HANG =
long under plausible conditions (hooks, network, big repos, a wedged
program, ssh).

- [x] [Git view refresh runs 14 git processes on the main thread](./done/perf-git-view-refresh-off-main-thread.md) — HANGS
- [x] [The Git watcher refreshes on gitignored paths](./done/perf-git-watcher-ignores-gitignore.md) — HANGS (amplifier)
- [x] [agent_usage probes every profile on the main thread](./done/perf-agent-usage-off-main-thread.md) — HANGS
- [x] [get_board ships every launch prompt, on every tree push](./done/perf-get-board-payload-and-refresh-storm.md) — HANGS, and a 1 MiB cliff
- [x] [watchman_status and watchman_forget spawn the watchman CLI on the main thread](./done/perf-watchman-off-main-thread.md) — HANGS
- [x] [One non-reading terminal can stall every terminal's input](./done/perf-terminal-input-head-of-line.md) — MIGHT-HANG
- [x] [Daemon command connection: move the family off the main thread as one unit](./done/perf-daemon-command-connection-off-main-thread.md) — MIGHT-HANG, prerequisite
- [x] [superpowers_status runs `claude plugin list` on every Settings visit](./done/perf-superpowers-off-main-thread.md) — HANGS
- [x] [Git actions run git, hooks and signing on the main thread](./done/perf-git-actions-off-main-thread.md) — HANGS / MIGHT-HANG
- [x] [Worktree add and remove run on the main thread](./done/perf-git-worktree-add-remove-off-main-thread.md) — HANGS
- [x] [The worktree switcher re-reads every worktree on every refresh](./done/perf-worktree-switcher-refacts-every-refresh.md) — HANGS while open
- [x] [Conflict resolution runs ~15 git processes per click](./done/perf-git-conflict-family-off-main-thread.md) — HANGS
- [ ] [get_gavin_tree waits on a rescan that sleeps under the lock](./perf-gavin-tree-rescan-sleeps-under-lock.md) — MIGHT-HANG
- [x] [Moving a plan card re-reads every card](./done/perf-plan-relocation-rereads-every-card.md) — MIGHT-HANG
- [x] [File viewer reads whole files and lists folders uncapped](./done/perf-file-viewer-unbounded-reads.md) — MIGHT-HANG
- [x] [card_run_tokens parses whole transcripts on the main thread](./done/perf-card-run-tokens-off-main-thread.md) — MIGHT-HANG
- [x] [agent_model_catalog runs `opencode models` at startup](./done/perf-agent-model-catalog-off-main-thread.md) — HANGS once per launch
- [ ] [Every window runs its own pollers](./perf-pollers-run-once-per-app.md) — amplifier
- [x] [The delete wizard walks the whole workspace on the main thread](./done/perf-workspace-delete-scan-off-main-thread.md) — HANGS on large roots
- [x] [end_orphan waits 2 s per orphan on the main thread](./done/perf-end-orphan-off-main-thread.md) — MIGHT-HANG
- [x] [Restart daemon runs the whole reconnect on the main thread](./done/perf-restart-daemon-off-main-thread.md) — MIGHT-HANG
- [x] [On an ssh workspace every routed command is a main-thread network wait](./done/perf-ssh-routes-off-main-thread.md) — MIGHT-HANG
- [ ] [open_workspace_window deadlocks on Windows as a sync command](./fix-open-workspace-window-windows-deadlock.md) — MIGHT-HANG (Windows)

## Audited FINE

Kept sync on purpose: the config getters/setters (`persist_workspaces`,
1–3 ms; making them async would let an older layout overwrite a newer one
and two non-atomic writes tear `config.json`), `write_input` /
`resize_session` themselves (~0.1 ms; see the head-of-line card for why
they must stay ordered), `create_session` (5–15 ms), `kill_session` (the
2026-09-04 `retire` fix is in), `session_screen`, `resolve_path_under_cursor`
(<2 ms per hover), `system_memory`, `git_watch`/`git_unwatch`,
`git_cancel_op`, `worktree_setup` (its caller has no token), pairing and
device commands, the tool/tool-run/group-template stores, card file writes
other than plan relocation, and the small git reads (`git_head_sha`,
`gavin_git_tracking`, ignore-file edits).

## Not hangs, found on the way

- `persist_workspaces` rewrites `config.json` non-atomically
  (`std::fs::write`, config.rs:1019) and re-parses the whole 124 KB file
  on every save to carry `typesafe` (session.rs:120); `session_names`
  (1,377 entries) is never pruned. A crash mid-write loads as
  `AppConfig::default()` — every workspace gone.
- A connection reopened by `send_command_reconnecting` sends no Hello, so
  it runs with the `local` role; with `require_local_token` on,
  CreateSession and EndOrphan are then refused. Fixed with the command lanes: a redial re-probes and says Hello.
- The daemon pushes device events to every `app` connection, and the
  command connection identifies as `app` (session.rs:2815): a push there
  would be read as a reply and desync request/response. Fixed with the
  command lanes: a lane skips the three device pushes.
- `session_screen` is not routed, so an ssh session's screen is read from
  the local daemon.
- `set_orchestration` replies only after pushing the whole plan
  (server.rs:2376-2396).
