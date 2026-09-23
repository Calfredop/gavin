# Network git sync, the git watcher, conflicts and tree mutations over ssh

Follow-up to `2026-09-22-ssh-git-files-design.md` §3, for the
`ssh-git-sync-and-conflicts` card -- the four things that stayed on the
desktop when the Git tab landed, plus the two gaps the 2026-09-22 board
audit found. Over `main` at `PROTOCOL_VERSION` 41.

## 1. What is already reachable, and what needs a bump

Two of the four items need nothing new on the wire. `conflict.rs` and
`ignore.rs` read and write ordinary files under the root, and
`ReadWorkspaceFile` / `WriteWorkspaceFile` have carried that since v40.
So the 3-pane and `.gitignore` work against a **v41** host once their
`std::fs` calls route -- which also closes the audit's two gaps, because
the fix for a misreading surface is to make it read the right machine,
not to hide it.

The other two genuinely need the host to grow: a git process that
outlives a request, a filesystem watch on the host, and three tree
mutations. That is **v42**.

| what | needs | gate |
|---|---|---|
| 3-pane conflicts, `.gitignore` | v40 reads/writes | `sshGitFiles` (41), already on the tab |
| fetch / pull / push, cancel | v42 | `sshGitSync` |
| the Git tab's live refresh | v42 | `sshGitSync` |
| tree create / rename / trash, cherry-pick | v42 | `sshGitSync` |

## 2. Decision: streaming rides the STREAMING connection, not the command one

`RunGit` is request/reply on `RemoteLink::command`, which is a mutex one
request at a time. A fetch of a large repo holds it for minutes, and
every other thing the desktop asks that host -- a status refresh, a
keystroke's session lookup, a card read -- queues behind it. So the long
ops do not go there.

They go where `Attach`, `Snapshot` and `WatchGavinRoot` already go: the
**streaming** connection, sent with no reply expected, answered by pushes
on the same connection. `handle_connection` already intercepts those
three for exactly this reason -- the answer is a push to *this*
connection's writer, not a return value `handle_request` could produce --
and the two new streaming requests join them.

```
RunGitStreaming { root_path, cwd, args, op_id }   -> GitOpProgress* , GitOpDone
WatchGitWorktree   { root_path, cwd }             -> GitWorktreeChanged*
UnwatchGitWorktree { root_path, cwd }
```

`CancelGitOp { op_id }` is the one that must NOT ride it: a cancel queued
behind the op it is cancelling never arrives. It is request/reply on the
command connection, against a registry `SessionManager` owns.

The desktop end keeps its shape. `ops.rs::run_op` still returns
`Result<(), String>` when the op ends, because the remote arm registers a
channel, sends the request, and blocks on the reply the relay thread
feeds it from `GitOpDone`. `GitOpProgress` is emitted as `git-op-progress`
-- the same Tauri event the local runner emits, with the same payload --
so `gitState.ts` cannot tell which machine ran it. That is the same
"change only where the process runs" the Git-tab card set.

### Why not poll, for the watcher

`watch.rs`'s header says never a timer, and `git_status.rs` records why:
a poll that runs `git status` on a cadence creates `.git/index.lock` and
fights every writing git command including gavin's own. The rule does
not weaken by crossing a network -- it gets worse, because the poll would
now also cost an ssh round trip. So the host runs the same
`notify_debouncer_mini` watch with the same relevance filter, and pushes
when it fires.

The filter lives in `crates/daemon/src/git_watch.rs`, a transcription of
`app/src-tauri/src/git/watch.rs::is_relevant`. Duplicated deliberately:
the shared crate is `protocol`, which is wire types, and a filesystem
predicate is not one. Both copies carry a pointer to the other and both
are tested on the same table of paths.

### The watchers' lifetime is the connection's

The daemon's git watchers are a `HashMap` local to `handle_connection`'s
thread, refcounted per cwd like the desktop's. Not `SessionManager`
state: a link that drops takes its connection with it, and a watcher
owned by the connection is then dropped by the language rather than by a
cleanup path that has to notice. The op registry cannot be local (a
cancel arrives on the *other* connection), so that one is `SessionManager`'s
and keyed by op id.

## 3. Decision: trash on the host is the HOST's Trash

`fileviewer.rs`'s doc is explicit that nothing gavin removes on the
human's behalf is unrecoverable. The card offered `rm` with a
confirmation, or leaving delete out. Both give that invariant up -- and
give it up on the machine the human is least able to check.

The daemon takes the `trash` dependency the app already has, with the
same three per-OS feature sets and the same reasons (chrono for the
freedesktop `DeletionDate`, apartment-threaded COM for `IFileOperation`).
`TrashWorkspacePath` puts the file in the host's own Trash or Recycle
Bin, so a mis-click on a Linux host is recoverable exactly where the
human would look for it. macOS keeps `NsFileManager` for the same reason
the app does: the Finder route needs an Automation grant, which a
headless daemon reached over ssh will never be granted.

The confirmation stays where it is -- `confirm_gate` on the desktop, spent
before the request goes out -- because that is where the human is.

## 4. The four new confined mutations

```
CreateWorkspacePath { root_path, path, directory }
RenameWorkspacePath { root_path, from, to }
TrashWorkspacePath  { root_path, path }
RunGitEnv { root_path, cwd, args, env }
```

`CreateWorkspacePath` carries `directory` rather than splitting into two
requests: a file and a folder differ by one `fs` call and share every
rule (`create_new` / `create_dir`, never `_all`, an existing target
refused by the filesystem rather than by a check with a window before the
write). They are gated as one because they arrive as one.

`RenameWorkspacePath` refuses an existing destination, for the reason
`rename_path` gives: `fs::rename` overwrites silently on unix, which
turns a mistyped rename into a delete with no trip through the Trash.

`RunGitEnv` is its own request and **not** a widened `RunGit`.
`min_version_for` gates request types, not payloads: an `env` field added
to `RunGit` would be dropped in silence by a v41 host, and a cherry-pick
whose `GIT_EDITOR=true` went missing hangs waiting for an editor that
will never open. The env is an allow-list of one key, `GIT_EDITOR`,
refused otherwise -- the two callers set only that, and an arbitrary
environment is a way to point git at a program, which is the reach
`RunGit`'s argv rule exists to deny.

## 5. Roles

Every one of the eight is `app`-only, denied to `agent` and `remote`, for
the reasons `RunGit` already gives: an agent has its own filesystem, and
a remote must never name a path or start a process. `RunGitStreaming`,
`RunGitEnv`, `CreateWorkspacePath`, `RenameWorkspacePath` and
`TrashWorkspacePath` join `is_privileged` -- they run a process or change
the tree, which is what that narrowing is for. `CancelGitOp`,
`WatchGitWorktree` and `UnwatchGitWorktree` do neither and stay out of
it: a cancel that needs a token is a cancel that cannot be sent.

## 6. Gate

`FEATURE_MIN_VERSION.sshGitSync = 42`, checked against the HOST daemon's
version through `sshSyncBlocked` in `sshWorkspace.ts` -- the third caller
of `sshFeatureBlocked`, beside the run gate and the tab gate, so all
three answer on the same evidence in the same words.

Consumers: `GitToolbar.svelte`'s three sync buttons (which held a
hard-coded "not available yet" string and now hold the shared reason),
and `FilesHubView.svelte`'s `sshReadOnly`, which loses `onIgnore` --
ignoring works at v41 now -- and keeps create/rename/trash behind v42.

`GitChanges.svelte`'s "Ignore this file" needed no gate of its own after
all: it reaches `ignore.rs`, which routes, and it is already inside the
Git tab's `sshTabBlocked`. The audit was right that it was ungated and
wrong that it had to be -- the fix was the routing.

The watcher needs no UI gate. `git_watch` against a host below v42 stays
the no-op it is today, and the tab's manual Refresh is what a human on an
old host keeps.
