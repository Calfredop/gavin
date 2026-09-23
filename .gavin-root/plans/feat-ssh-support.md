---
order: 1024
title: [feat] ssh support
status: In Progress
---
Gavin should be able to support workspaces via ssh. We need to make sure that the implementation works even if we are working on a macos system, and connect to a windows or linux machine.

## Design

`docs/superpowers/specs/2026-09-22-ssh-workspaces-design.md` — the daemon runs where the workspace lives; the desktop drives it over `ssh <host> gavin-daemon bridge`, presenting that daemon's own token so the connection is role `app` through the existing gate. Read it before re-deriving anything below.

## Checklist

- [x] Design spec: `docs/superpowers/specs/2026-09-22-ssh-workspaces-design.md`
- [x] Daemon: `gavin-daemon bridge` subcommand (`crates/daemon/src/bridge.rs`) — connect-or-spawn the host's own daemon, banner line with the daemon token / host OS / home, stdio relay; out-of-process tests in `crates/daemon/tests/bridge.rs`
- [x] App config: `Workspace.ssh` (`SshConfig { host, daemonPath? }`) in `config.rs` and the frontend `Workspace` type, round-tripping through the workspaces save
- [x] App: `remote.rs` — `RemoteLink` over an `ssh` child (banner, `Stream::pair()` pumps, version probe, token `Hello`, relay), `RemoteLinks` / `SessionHosts` state, `connect_remote_workspace` command, bootstrap skipping ssh workspaces on the local daemon and linking them after `workspaces-ready`, events `remote-link-ready` / `remote-link-lost`
- [x] App: route the session, board, tree, orchestration and tool commands to the link owning the session / workspace / root / path; the link's `home` as the cwd fallback; `gavin_root_exists` answered by the host daemon; the sessions manager reading every link
- [x] Host-side install note: `docs/ssh-workspaces.md` — what to put on a Linux or Windows host and how to name it in the workspace's ssh settings
- [x] [Frontend: ssh workspace creation and Reconnect (host, root on the host, optional daemon path), the remote badge, gating of the local-only surfaces (Git tab, Files tab, file viewer, agent setup, worktrees, delete wizard) with a message naming the limitation, and the `remote-link-*` events](./archive/frontend-ssh-workspaces.md)
- [x] [Card runs on ssh workspaces: `compose_agent_prompt` and `setup_agent_integration` (MCP config) done on the host, where the agent and `gavin-mcp` run](./archive/card-runs-on-ssh-workspaces-compose-agent-prompt-and-setup-agent-integration-mcp-config-done-on-the-host-where-the-agent-and-gavin-mcp-run.md)
- [x] [Git tab and Files tab over ssh](./archive/git-tab-and-files-tab-over-ssh.md)
- [x] [Network git sync and conflict resolution over ssh](./done/ssh-git-sync-and-conflicts.md) — the four things that stayed on the desktop when the Git tab landed
- [ ] [Verify from macOS against a Linux host and a Windows host; fold what breaks back into the spec](./verify-from-macos-against-a-linux-host-and-a-windows-host-fold-what-breaks-back-into-the-spec.md)
- [x] Checks: `cargo test -p gavin-daemon --test bridge`, `cargo test -p app`, `cd app && npm test && npm run check`; commit the touched files only

## Status

Landed on `feat/ssh-support` as `d68f34d` (2026-09-22): the bridge, the config field, `remote.rs`, the routing, the install note and the spec. Checks: bridge tests 5/5 and unit 4/4; `cargo test -p app` 506 green with only the Windows baseline reds; vitest and svelte-check at their recorded baselines; `npm run build` green. The four nested tasks are what remains; the frontend one must land first, and its stale-tab rule (skip ssh workspaces in `staleLayoutTabIds` until `remote-link-ready`) is what keeps remote tabs from being closed at startup.

The frontend landed as `aeed732`: "Open workspace over ssh…" in the sidebar corner and "Over ssh…" on a rootless root control, the link store fed by `remote-link-ready` / `remote-link-lost`, the sidebar mark and the strip banner with Reconnect, the stale-tab skip, and the shared limitation notice on every surface that runs against this machine's disk (gated at the launch seam too). Checks: vitest and svelte-check at their recorded baselines, `npm run build` green.

Card runs landed as `6a5d7d2`: protocol v40 adds `ReadWorkspaceFile`, `WriteWorkspaceFile` and `StatWorkspacePaths` (confined to the root and its extra contexts; agent and remote roles denied); the Tauri host's `read_file_for_viewer`, `write_file_for_editor`, `attachment_status` and `setup_agent_integration` route to the link for an ssh root, the latter through a `WorkspaceFiles` trait with local and remote implementations; the bridge banner names the host's `gavin-mcp`; the Run pill and the launch seam gate on the HOST daemon's version (`FEATURE_MIN_VERSION.sshCardRuns`). Spec: `docs/superpowers/specs/2026-09-22-ssh-card-runs-design.md`. Checks at their baselines (protocol 3 Linux-XDG reds, app 11 Windows reds, vitest 13/21, svelte-check 6), bridge and new daemon tests green, `npm run build` green. The bump takes effect only after a rebuild and daemon restart, which is the human's call; every running `gavin-mcp` then fails closed until it is rebuilt too.

The Git tab and Files tree over ssh landed as `ed97220`: protocol v41 adds `RunGit` (a git subcommand in a confined cwd, argv never a shell, app-only) and `ListWorkspaceDir`; the app routes at the run layer through a git router in `remote.rs`, so status/diff/stage/commit/log/branches/stash and the Files tree/open/edit work on the host. Network sync (fetch/pull/push), the git watcher, conflicts and tree create/rename/trash stay gated -- filed as [ssh-git-sync-and-conflicts.md](./done/ssh-git-sync-and-conflicts.md). Spec: `docs/superpowers/specs/2026-09-22-ssh-git-files-design.md`. Checks at their baselines (protocol 3 XDG reds, app 11 Windows reds, vitest 13/21, svelte-check 6), daemon bridge/git tests green, `npm run build` green.

**Where this stands, 2026-09-22 (board audit).** `feat/ssh-support` is
**merged into `main`** — `git merge-base --is-ancestor feat/ssh-support main`
passes and the branch is 0 commits ahead. So everything ticked above is on
`main`, and the worktree `gavin-feat-ssh-support` is 85 commits behind it: the
rail's first step has to bring `main` in before any further work.

Two items remain, and the checklist above now carries both (it listed only the
verification one before — the sync/conflicts task was mentioned in prose and had
no box). The audit re-checked all four of `ssh-git-sync-and-conflicts`'s items
against `main` and every one is still open; it also found two gaps that card did
not name, now written into it.

**The version numbers in the two paragraphs above were off by one** and are
corrected here: the card-runs bump is **v40** (`ReadWorkspaceFile` /
`WriteWorkspaceFile` / `StatWorkspacePaths`), the Git-tab bump is **v41**
(`RunGit` / `ListWorkspaceDir`). v39 went to `SessionScreen` on the turn-verdict
branch. `PROTOCOL_VERSION` on `main` is 41, so the next bump anywhere takes 42.

**Sync, the watcher, conflicts and the tree's mutations landed as
`40c401c9` (2026-09-23)** on `feat/ssh-support`, finishing
[ssh-git-sync-and-conflicts.md](./done/ssh-git-sync-and-conflicts.md) — all
six items, the four it named and the two the board audit added. Spec:
`docs/superpowers/specs/2026-09-23-ssh-git-sync-and-conflicts-design.md`.

The split the design turns on: **conflicts and `.gitignore` needed no
bump at all.** Both reach past git to the disk, and the v40 file requests
have carried that since the card-runs card — so routing their `std::fs`
calls through a new `read_repo_file`/`write_repo_file` seam in
`git/run.rs` makes the 3-pane and the ignore editor work against a **v41**
host. That is also the fix for both audit findings: `git_conflict` was
reachable over ssh and misreading, and the Changes menu's "Ignore this
file" was ungated. Neither wanted a gate — they wanted to read the right
machine.

The rest is **protocol v42**, eight new request types: `RunGitStreaming` +
`CancelGitOp` (fetch/pull/push), `WatchGitWorktree` /
`UnwatchGitWorktree` (live refresh), `RunGitEnv` (cherry-pick and
`--continue`, which need GIT_EDITOR), and `CreateWorkspacePath` /
`RenameWorkspacePath` / `TrashWorkspacePath` (the Files tree). Three
decisions worth keeping:

- **The streaming op rides the STREAMING connection**, beside `Attach` and
  `WatchGavinRoot`, because a fetch holds the command mutex for minutes
  and would queue every other request to that host behind it. Its cancel
  stays on the command connection precisely so it is not queued behind
  the op it cancels. `ops.rs::run_op` parks on the done push, so
  `git_fetch` returns as it always did and the progress row reads one
  `git-op-progress` event whichever machine drew the lines.
- **The watcher moved to the host, never a poll** — `git_status.rs`
  records what a cadenced `git status` does to `index.lock`, and a
  network round trip only makes that worse. Host watchers belong to the
  CONNECTION, so a dropped link takes them with it; `rewatch_git_roots`
  re-asks on relink, because the tab's effect keys on its cwd and a
  reconnect does not change one.
- **Trash on a host is the HOST's Trash**, not `rm`: the daemon takes the
  same `trash` dependency the app has, with the same per-OS features. The
  card offered `rm` with a confirmation or leaving delete out; both give
  up "nothing gavin removes is unrecoverable", on the machine the human is
  least able to check.

`RunGitEnv` is a separate request and **not** a widened `RunGit`, for the
reason CLAUDE.md warns about: `min_version_for` gates types, so an `env`
field would be dropped in silence by a v41 host and a cherry-pick would
hang on an editor nobody can see. Its environment is an allow-list of one
key.

Gate: `FEATURE_MIN_VERSION.sshGitSync = 42` via `sshSyncBlocked`, read by
the toolbar's three sync buttons, the Files tree's new/rename/trash, and
the two surfaces that set GIT_EDITOR (cherry-pick in `GitGraph`, Continue
in `GitHubView`). `PROTOCOL_VERSION` is **42** on this branch; the next bump
anywhere takes 43.

**Corrected 2026-09-23:** that sentence first read "`PROTOCOL_VERSION` on
`main` is now 42", which is not true and misleads whoever picks the next
number. `main` (`c51990b9`) is **41**. 42 lives only on `40c401c9`, which
`git merge-base --is-ancestor 40c401c9 main` says is **not** an ancestor of
`main` — the branch is one commit ahead. The board-audit paragraph further up
("`PROTOCOL_VERSION` on `main` is 41") is the correct one. Read the constant,
not this card.

Checks, all at their recorded baselines: `cargo test -p protocol` 114/3
(the three Linux-XDG reds Windows always has), `cargo test -p gavin-daemon`
590/10 unit — the ten are `main`'s known Windows path-separator reds, and
this change is +380/-0 in `gavin.rs` so it cannot have caused them — plus
bridge 5/5 and shutdown 1/1; `cargo test -p app` **533/0**; vitest
**282 files / 6196 tests green**; svelte-check **0 errors**;
`npm run build` green. The bump takes effect only after a rebuild and
daemon restart, which is the human's call, and every running `gavin-mcp`
then fails closed until it is rebuilt too.

One thing NOT done, and it is the card's own last item: **nobody has run
any of this against a real host.** Everything above is unit- and
integration-tested (including an end-to-end `handle_connection` test that
streams a real git op over a real socket and cancels it from a second
connection), but the verification card is still open — see below.

**First real-machine pass, 2026-09-23.** The Linux-host half of the
verification card has now been run against a **real Linux host over real
ssh** — a disposable debian box with its own `sshd`, reached from this
Windows desktop with the exact argv `remote.rs::ssh_command` builds and the
same two bridges per host. **98 assertions passed and nothing failed on the
host**, spread over the bridge, daemon survival, terminals, the board, the
whole v41 surface, the whole v42 surface, and a second host built from
`main` standing in as the
v41 one. Nothing on the host broke, so **no rule changed and there is
nothing to fold into the spec's §5 or `docs/ssh-workspaces.md`**, and no bug
card to file.

The two the card singled out as untested both hold: **Cancel** reaches a
running op on the command connection while that op holds the streaming one
(`GitOpCancelled{cancelled:true}`, then `GitOpDone{error:"cancelled"}` at
3.0 s), and **Trash** performed by a daemon `sshd` started — no desktop
session, no session bus — still writes a spec-valid `.trashinfo` into
`~/.local/share/Trash`, so the file is restorable rather than gone. The
v41 host answers all eight v42 request types `Unsupported` **without
dropping the link** and without half-applying anything, so a leaked gate
costs a refused request, not a workspace.

The card **stays open**: no Windows host and no macOS desktop were
available, so the `#[cfg(windows)]` breakaway, the Recycle Bin, the
`C:/Users/...` spelling and every surface the app draws are still unrun.
Details, exact messages and what to run next are in the card.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
