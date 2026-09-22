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
- [x] [Frontend: ssh workspace creation and Reconnect (host, root on the host, optional daemon path), the remote badge, gating of the local-only surfaces (Git tab, Files tab, file viewer, agent setup, worktrees, delete wizard) with a message naming the limitation, and the `remote-link-*` events](./frontend-ssh-workspaces.md)
- [x] [Card runs on ssh workspaces: `compose_agent_prompt` and `setup_agent_integration` (MCP config) done on the host, where the agent and `gavin-mcp` run](./card-runs-on-ssh-workspaces-compose-agent-prompt-and-setup-agent-integration-mcp-config-done-on-the-host-where-the-agent-and-gavin-mcp-run.md)
- [x] [Git tab and Files tab over ssh](./git-tab-and-files-tab-over-ssh.md)
- [ ] [Verify from macOS against a Linux host and a Windows host; fold what breaks back into the spec](./verify-from-macos-against-a-linux-host-and-a-windows-host-fold-what-breaks-back-into-the-spec.md)
- [x] Checks: `cargo test -p gavin-daemon --test bridge`, `cargo test -p app`, `cd app && npm test && npm run check`; commit the touched files only

## Status

Landed on `feat/ssh-support` as `d68f34d` (2026-09-22): the bridge, the config field, `remote.rs`, the routing, the install note and the spec. Checks: bridge tests 5/5 and unit 4/4; `cargo test -p app` 506 green with only the Windows baseline reds; vitest and svelte-check at their recorded baselines; `npm run build` green. The four nested tasks are what remains; the frontend one must land first, and its stale-tab rule (skip ssh workspaces in `staleLayoutTabIds` until `remote-link-ready`) is what keeps remote tabs from being closed at startup.

The frontend landed as `aeed732`: "Open workspace over ssh…" in the sidebar corner and "Over ssh…" on a rootless root control, the link store fed by `remote-link-ready` / `remote-link-lost`, the sidebar mark and the strip banner with Reconnect, the stale-tab skip, and the shared limitation notice on every surface that runs against this machine's disk (gated at the launch seam too). Checks: vitest and svelte-check at their recorded baselines, `npm run build` green.

Card runs landed as `6a5d7d2`: protocol v39 adds `ReadWorkspaceFile`, `WriteWorkspaceFile` and `StatWorkspacePaths` (confined to the root and its extra contexts; agent and remote roles denied); the Tauri host's `read_file_for_viewer`, `write_file_for_editor`, `attachment_status` and `setup_agent_integration` route to the link for an ssh root, the latter through a `WorkspaceFiles` trait with local and remote implementations; the bridge banner names the host's `gavin-mcp`; the Run pill and the launch seam gate on the HOST daemon's version (`FEATURE_MIN_VERSION.sshCardRuns`). Spec: `docs/superpowers/specs/2026-09-22-ssh-card-runs-design.md`. Checks at their baselines (protocol 3 Linux-XDG reds, app 11 Windows reds, vitest 13/21, svelte-check 6), bridge and new daemon tests green, `npm run build` green. The bump takes effect only after a rebuild and daemon restart, which is the human's call; every running `gavin-mcp` then fails closed until it is rebuilt too.

The Git tab and Files tree over ssh landed as `ed97220`: protocol v40 adds `RunGit` (a git subcommand in a confined cwd, argv never a shell, app-only) and `ListWorkspaceDir`; the app routes at the run layer through a git router in `remote.rs`, so status/diff/stage/commit/log/branches/stash and the Files tree/open/edit work on the host. Network sync (fetch/pull/push), the git watcher, conflicts and tree create/rename/trash stay gated -- filed as [ssh-git-sync-and-conflicts.md](./ssh-git-sync-and-conflicts.md). Spec: `docs/superpowers/specs/2026-09-22-ssh-git-files-design.md`. Checks at their baselines (protocol 3 XDG reds, app 11 Windows reds, vitest 13/21, svelte-check 6), daemon bridge/git tests green, `npm run build` green.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
