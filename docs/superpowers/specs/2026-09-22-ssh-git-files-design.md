# Git tab and Files tree over ssh

Follow-up to `2026-09-22-ssh-workspaces-design.md` §7 and
`2026-09-22-ssh-card-runs-design.md`, for the git/files card. Over
`6a5d7d2`, `PROTOCOL_VERSION` 40.

## 1. The seam

Every Git-tab command runs the system `git` through four functions in
`app/src-tauri/src/git/run.rs` -- `run_git`, `run_git_ro` (which calls
`run_git`), `run_git_env`, `run_git_streaming` -- each taking a `cwd`.
The Files tree lists through `fileviewer::list_directory` and reads/writes
through `read_file_for_viewer` / `write_file_for_editor` (the last two
already route, from the card-runs card). So "the process runs somewhere
else" is a change at the run layer and the one list command, not across
sixty `#[tauri::command]`s -- which is what the card meant by "change only
where the process runs; the frontend should not know which."

## 2. Decision: a confined `RunGit`, not per-command requests, not a shell

Two requests, one bump (v40):

| request | reply | for |
|---|---|---|
| `RunGit { root_path, cwd, args, stdin }` | `GitRun { stdout, stderr, code }` | every synchronous Git-tab command |
| `ListWorkspaceDir { root_path, path }` | `WorkspaceDir { entries }` | the Files tree |

`RunGit` runs one program -- `git` -- with an argv the desktop built, in a
`cwd` the daemon confines to the watched root and its extra contexts. It
is deliberately neither of the card's two sketched options:

- **Not option (a), a request per git operation.** Sixty variants to
  carry status, diff, stage, commit, log, branches, stash would be sixty
  chances to drift from what the local `run_git` does, for no gain: the
  Git tab already parses `git`'s own output, so the daemon has only to run
  git and hand back the same three fields. One request that runs git is
  the whole of it.
- **Not option (b), a generic shell.** `05-remote-access.md` refuses a
  remote shell on the wire, and rightly. `RunGit` is not one: the binary
  is fixed, `args` is an argv passed to `git` and never interpolated, so
  `["status; rm -rf /"]` is a bogus subcommand git rejects, not a
  pipeline. It runs only for the `app` role -- the desktop, which already
  spawns real shells on the host through `CreateSession` and already runs
  git locally -- so it widens the app's reach by nothing. `agent` and
  `remote` are denied both requests: an agent has its own filesystem, and
  a remote must never run a process or name a path. `RunGit` is
  privileged for the `require_local_token` narrowing, beside
  `WriteWorkspaceFile` and `CreateSession`, because it mutates the tree
  and a git config could point at a program.

What routes is `run.rs`, through a process-global git router in
`remote.rs`: a link registers its workspace root when it comes up, clears
it when it drops, and `run_git` asks the router for the link owning a
`cwd` -- it has no `AppHandle` to reach state through, and the router is
how a bare `cwd` finds its host. `list_directory` routes the ordinary
way, by `route_for_root` with the `AppHandle` it already has.

## 3. What routes, and what stays the desktop's

Routed (works on an ssh workspace): status, diff, stage/unstage, commit,
log and commit-detail, plus everything else that goes through
`run_git`/`run_git_ro` -- branches, stash, reset, merge, worktree list.
The Files tree lists, and files open, edit and save.

Not routed (the desktop keeps them; gated in the UI for ssh):

- **Network sync -- fetch, pull, push.** They use `run_git_streaming`,
  which streams progress and is cancellable; a synchronous `RunGit` is
  the wrong shape for it. The three toolbar buttons disable for an ssh
  workspace with a notice. This is the "sync" the card names as a
  follow-up, and the one thing that genuinely cannot ride `RunGit`.
- **The git watcher.** `git_watch`/`git_unwatch` watch the local `.git`
  with `notify`; there is nothing here to watch. They no-op for a remote
  cwd, so nothing errors -- the tab's manual Refresh works, and live git
  refresh over ssh is a follow-up.
- **Creating, renaming, trashing in the tree, and editing `.gitignore`.**
  Trash has no remote equivalent (the OS Trash is local), and `ignore.rs`
  writes the file on the local disk after `run_git` finds the repo root.
  The tree's menu omits these for an ssh workspace (the callbacks are
  null, the way "open in a tab" is omitted with no session). Listing,
  opening and editing a file's content -- the card's "list, read, write"
  -- are what work.

Conflicts (the 3-pane) and cherry-pick/`run_git_env` are left to the
follow-up: they read local rebase state or set `GIT_EDITOR`, which
`RunGit` does not carry.

## 4. Gate

`FEATURE_MIN_VERSION.sshGitFiles = 40`, checked against the HOST daemon's
version (the ready event carries it), never the local one's. `sshTabBlocked`
is what the Git and Files hub views gate on: the notice while the link is
connecting or lost or the host is older than 40, the tab's content once it
is null. It shares `sshFeatureBlocked` with the card-run gate, so a host at
v39 runs cards but not these tabs, and both say why in the same words.
