---
order: 31744
kind: task
title: "[perf] On an ssh workspace every routed command is a main-thread network wait"
labels: bug
parent: perf-main-thread-command-audit.md
status: Done
---
For an ssh workspace, file, git and session commands route over the link's
`RemoteLink.command: Mutex<Stream>` (app/src-tauri/src/remote.rs:296-311) —
a synchronous network round trip per call, on the main thread, with no read
timeout. No ssh workspace is configured on this machine today, so this is
latent — but it is every command at once when one is.

## Evidence (2026-09-26)

- Link streams are `Stream::pair` pumps: `peer_path()` is None, so no
  reconnect and no read timeout. A dropped network blocks until ssh gives
  up: `ServerAliveInterval=15` × `ServerAliveCountMax=3` (remote.rs:113-121)
  ≈ 45 s; unbounded if ssh is alive but the host daemon is stuck.
- Affected: `read_file_for_viewer`, `write_file_for_editor` (editor
  autosave every typing pause), `attachment_status`, `list_directory`,
  `create_file`, `create_directory`, `rename_path`, `trash_entry`,
  `setup_agent_integration` (12+ round trips in sequence), every git
  command via `run_git_over_link` (git/run.rs:45), `get_session_baselines`
  (session.rs:3243-3255), `list_managed_sessions` and `list_queued_inputs`
  (loop over EVERY link — the 5 s memory poll would freeze the UI every
  5 s for up to 45 s on one flaky host), `gavin_root_exists`
  (ScanGavinRoot = a full host scan).
- The link mutex is also taken off-main by `get_git_baselines` and
  `git_run_changes`, so a main-thread command can wait behind a remote git.

## Fix

Ride on the other cards' conversions (fileviewer, git, command
connection) and add, for links specifically: a per-request read deadline,
per-link worker queues instead of one mutex, and parallel per-link queries
with their own timeouts for the loops (`list_managed_sessions`,
`list_queued_inputs`, `get_session_baselines`).

## Verify

Needs a real ssh host: link a workspace, drop the network (e.g. pause the
VM), and confirm the window stays live while the link times out.

## State when picked up (2026-09-26, perf/main-thread-commands @ 68be0be1)

The command-lane card already gave each link a worker-owned lane with a
per-request deadline (`RemoteLink.command: CommandLane`), and the
fileviewer/git/lane cards made `read_file_for_viewer`, `list_directory`,
`gavin_root_exists`, the three loops and most git commands async. Still
plain `fn` and still reaching a link: `write_file_for_editor`,
`attachment_status`, `create_file`, `create_directory`, `rename_path`,
`trash_entry`, `setup_agent_integration`, and ten git commands through
`run_git`/`read_file_over_link` (`git_merged_branches`, `git_stash_files`,
`git_worktree_prune`, `git_head_sha`, `gavin_git_tracking`,
`set_gavin_git_tracking`, the three ignore-file commands) plus
`git_cancel_op`'s link arm. `list_managed_sessions` still awaits links one
after another, and no loop has a bound of its own. On a link, a timeout
keeps the connection and owes the late answer, so every request queued
behind a wedged host waits out a full deadline of its own (600 s for any
`RunGit`, reads included), and a read that times out mid-line loses the
bytes it read.

## Progress

- [x] File + agent commands: `write_file_for_editor`, `attachment_status`, `create_file`, `create_directory`, `rename_path`, `trash_entry`, `setup_agent_integration` async off the main thread; read-modify-writes that the main thread used to serialise keep a lock (agent integration) or a per-path queue (editor writes, frontend)
- [x] Git commands: the ten sync ones + `git_cancel_op` async; `.gitignore` read-modify-writes serialised
- [x] Loops: `list_managed_sessions` asks every link at once; all three give a link a bound of its own and answer without the host that misses it
- [x] Lane: a request whose caller stopped waiting is never sent; a link that owes a late answer fails new requests fast instead of each waiting a deadline; a timed-out read keeps its partial line
- [x] Link deadlines: a plain `run_git` on a host gets a read-sized deadline, only hook-running actions keep 600 s
- [x] Guards: new commands in `OFF_MAIN_THREAD`; structural check that no command reaching a link is a plain `fn`
- [x] Tests: lane (skip abandoned, fail-fast while owed, partial line survives a timeout), loops' bound, write queue order; `cargo test`, `npm test`/`check`/`build`
- [ ] Human test: In the app built from perf/main-thread-commands, with a workspace linked to a real ssh host: open a file in the editor and the Git tab, then drop the network (pause the VM or pull the host's link) and keep typing, switching tabs and opening the Sessions manager for a minute — the window never freezes, saves and git reads fail with an error instead of hanging, local sessions keep updating, and after the network returns and the workspace reconnects its tabs are still there.

## Outcome (2026-09-26, uncommitted on perf/main-thread-commands)

- **No command waits on a host on the main thread.** 18 commands became
  `async`: the six file commands and `setup_agent_integration` hand their
  work to the blocking pool (`trash_entry` spends its confirm token
  first, before anything waits); the ten git commands and
  `git_cancel_op` go through `off_main_thread`. What the main thread used
  to serialise by accident keeps its order on purpose: one integration
  run at a time (`INTEGRATION_RUNS`), one `.gitignore` edit at a time
  (`git::ignore::IGNORE_EDITS`, also taken by `set_gavin_git_tracking`),
  and one path's editor writes in call order (`keyedQueue.ts`, used by
  `backend.writeFileForEditor` — the autosave fires again on the next
  typing pause whether or not the last write answered, and without it
  the older text could land last). Still sync, deliberately:
  `git_watch`/`git_unwatch`, `write_input`, `resize_session`,
  `snapshot_session`, `watch_gavin_root` — they only write to the link's
  streaming connection and never wait for an answer.
- **Loops.** `remote::ask_every_link` (over `command_lane::ask_each`)
  asks every host at once, alongside the local daemon, each bounded by a
  5 s budget; a host that misses it is left out, as a failing host
  already was. `list_managed_sessions` no longer awaits hosts one by one.
  `get_session_baselines` now answers `{ sessions, hosts }`, and
  `reconcileLayoutSessions` sweeps an ssh workspace only when its host
  is ready AND in `hosts`. Before, a ready host whose read failed had
  every one of its tabs closed as stale on the next reload; a budget
  would have made that routine.
- **Lane, for links.** A request whose caller stopped waiting is skipped,
  never sent (so a poll every 2-5 s against a stuck host does not become
  a backlog). While a link owes a late answer, a new request gets 250 ms
  for it and is then refused unsent ("has not yet answered an earlier
  request…") instead of waiting a deadline of its own behind it; the
  lane recovers by itself once the answer arrives. A read that times out
  mid-line keeps what it read (`Conn::partial`): before, the rest of that
  line failed to parse and took the link's command connection down.
- **Deadlines.** A plain `run_git` on a host waits 30 s
  (`GIT_LINK_TIMEOUT`); only the hook-running actions keep their 600 s
  (`run_git_action`'s own timeout). Before, every `RunGit` — a
  `git status` included — held the link's only connection up to 10 min.
- **Verified.** `cargo test --workspace` and `npm test` / `check` /
  `build` green in a detached worktree at 68be0be1 + this diff. The
  guard (`mainThreadCommands.test.ts`) is 35 red against HEAD, green
  now; it adds a structural check that finds link-asking `RemoteLink`
  methods in remote.rs and fails any command calling one from a plain
  `fn`, plus every git command. The lane tests ran 40× at
  `--test-threads=32` and 60× in four parallel loops at load ~45 with no
  failure. Against a real `gavin-daemon bridge` pumped exactly as a link
  pumps ssh, to an isolated daemon under a temp `$HOME` stopped with
  SIGSTOP: healthy round trip <1 ms; the stalled request timed out at its
  3 s deadline; the next was refused unsent in 251 ms; `ask_each`
  returned in 252 ms without the host; after SIGCONT the late answer was
  read off and the next request answered in 0.3 ms.
- **Not done here.** A link still has one command connection, so a
  legitimately long host git action (a slow pre-commit hook) holds every
  other request on that host behind it — async now, but queued. A second
  ssh process per host was rejected by the lane card; ssh multiplexing
  would make it cheap if that ever matters. Found on the way and filed
  separately: a git stdout over ~300 KB on a link exceeds the 1 MiB
  protocol line and drops the link's command connection
  ([fix-link-gitrun-line-cap.md](../fix-link-gitrun-line-cap.md)).
