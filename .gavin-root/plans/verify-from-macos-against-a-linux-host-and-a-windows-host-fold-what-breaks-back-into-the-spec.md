---
order: 23552
status: In Progress
kind: task
title: Verify ssh workspaces from macOS against a Linux host and a Windows host
parent: feat-ssh-support.md
complexity: moderate
---
A verification pass on real machines, not a coding task: the owner's, or an agent with ssh reach to a Linux host and a Windows host from a macOS desktop. Read `docs/ssh-workspaces.md` and `docs/superpowers/specs/2026-09-22-ssh-workspaces-design.md` first. It needs the frontend task landed.

On each host: install `gavin-daemon` built from this branch (`cargo build --release -p gavin-daemon`), put it on PATH or note its path; confirm `ssh <host> gavin-daemon bridge` prints a `BridgeReady` line and then relays `{"type":"GetProtocolVersion"}` typed on stdin. On the Windows host also check: the ssh session's default shell (cmd.exe and PowerShell, both), that the daemon the bridge started keeps running after the ssh session ends (`Get-Process gavin-daemon`), that closing the app does not end it, and that the workspace root is written as `C:/Users/...`.

From the macOS desktop: create an ssh workspace to each host; open terminals (a shell, then `claude` or another agent); edit a card on the host and watch the board and plan tree update; kill a session; restart the local daemon from Settings (the links must survive it); pull the network (that workspace shows `remote-link-lost`; the rest of the app keeps working); Reconnect.

**The surface grew on 2026-09-23** (`40c401c9`, protocol v42 — see
[ssh-git-sync-and-conflicts.md](./ssh-git-sync-and-conflicts.md) and
`docs/superpowers/specs/2026-09-23-ssh-git-sync-and-conflicts-design.md`).
The list above predates it. Also check, on each host:

- **Fetch, pull and push** from the Git tab: progress lines appear in the
  op row as the op runs, and **Cancel** actually stops it — the op runs on
  the host and the cancel travels on a different connection, so a cancel
  that does nothing is the failure to watch for. Try a push that needs
  credentials: `GIT_TERMINAL_PROMPT=0` should make it fail with a message
  rather than hang a request.
- **Live refresh.** Change a file on the host in a terminal; the Git tab
  should update without pressing Refresh. Then drop the link and
  Reconnect, and change a file again — the watch is re-asked on relink,
  and a tab that goes quiet after a reconnect is the bug that rule exists
  to prevent.
- **The Files tree's New file / New folder / Rename / Move to Trash**, and
  the Git tab's cherry-pick and `--continue`. On the Windows host
  especially: confirm the trashed file lands in the **Recycle Bin on the
  host** (not deleted, not on the desktop's), and on Linux that it lands
  in that user's `~/.local/share/Trash` with a working "Restore" in the
  file manager — a daemon started by `sshd` has no desktop session, which
  is exactly the case nothing here has exercised.
- **The 3-pane conflict view** after a conflicting merge AND after a
  conflicting rebase (the rebase labels read `head-name`/`onto` from the
  host's git dir), and the `.gitignore` / `.git/info/exclude` editor.
  Known narrowing to confirm rather than file: on a **linked worktree**,
  `.git/info/exclude` is refused because the common git dir can sit
  outside the workspace root.
- **A host still on v41** (keep one, or check out the older daemon): the
  tab, the 3-pane and `.gitignore` must all work, while the sync buttons,
  the tree's three mutations and cherry-pick are greyed out naming v42.
  That split is the whole design and nothing but a real old host tests it.

Nothing in this list has been run against a real machine. As of
2026-09-23 the work is covered only by unit and integration tests,
including an end-to-end one that streams a real git op over a real socket
and cancels it from a second connection — which proves the wiring and
says nothing about ssh, two OSes, or a Recycle Bin.

Record what broke, with the exact ssh stderr and the app's message, as a list in this card. Fold every rule that changed into the spec's §5 (paths and OS) and into `docs/ssh-workspaces.md`. File a card per bug.

## Verified, 2026-09-23 — a real Linux host over real ssh

Run against a **disposable Linux host in Docker** (debian bookworm, its own
`sshd`, keys only), reached over real ssh from this **Windows** desktop with
the exact argv `remote.rs::ssh_command` builds (`-T -o BatchMode=yes -o
ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -- <host>
'"<daemon>" bridge'`) and the same two bridges per host, streaming and command.
The host ran `gavin-daemon` built from this branch for Linux
(`cargo build --release -p gavin-daemon -p gavin-mcp`, glibc, nothing else
installed). No GUI was involved: the desktop half was a script speaking the
protocol, which is what makes everything below a statement about the HOST.

**What this does NOT cover, and the card stays open for it:** there was no
macOS desktop and no Windows host on this machine (no OpenSSH Server, no
elevation; WSL has no `openssh-server` and `sudo` wants a password). So the
app's own surfaces — the op row, the greyed-out buttons naming v42, the
sidebar mark, Reconnect, restarting the local daemon from Settings,
`remote-link-lost` reaching only one workspace — are still unrun, and so is
**every line of the Windows-host section**: `cmd.exe` vs PowerShell as the ssh
shell, the job-object breakaway that keeps the daemon alive when sshd tears
the session down, the Recycle Bin, and the `C:/Users/...` root spelling.

### The bridge

- `daemonPath` unset, binary off the ssh PATH: exit **127**, stderr verbatim
  `bash: line 1: gavin-daemon: command not found` — the failure
  `docs/ssh-workspaces.md` documents, word for word.
- With `daemonPath`, one banner line and nothing else on stderr:
  `{"type":"BridgeReady","protocolVersion":42,"daemonToken":"…","hostOs":"linux","home":"/home/gavin","mcpPath":"/opt/gavin/gavin-mcp"}`.
  `mcpPath` resolved through `/proc/self/exe`, so it names the real directory
  even when the daemon is reached through a symlink.
- `{"type":"GetProtocolVersion"}` typed on stdin came back
  `{"type":"ProtocolVersion","version":42}` — the relay, exactly as the card
  asked for it.
- `Hello` with the banner's token → `role: "app"`, and `server_proof` matched
  HMAC-SHA256(token, nonce) computed on the desktop. Without a credential →
  `role: "local"`, no proof. The gate is the same one as at home.

### The daemon outlives the session

The bridge started the daemon (nothing was listening). After every ssh session
from that run had ended: `PID 71, PPID 1, SID 71` — reparented to init and in
**its own session**, which is what the `setsid` in `spawn_detached` is for.
`~/.local/share/gavin/` held `daemon.sock`, `daemon.token` and the three
SQLite stores, and `daemon.log` had exactly one line,
`gavin-daemon listening on /home/gavin/.local/share/gavin/daemon.sock`. It
also survived a hard link drop (both ssh children killed): same pid before and
after, and the reconnect reached the same daemon — unchanged token, proof still
verifying.

### Terminals, the board, sessions

`CreateSession` on the host, `Attach` on the streaming connection, then
`echo MARK-$(uname -s)-$(hostname)` came back **`MARK-Linux-99e4a935cef7`** —
the shell is on the host, not the desktop. `tty` reported `/dev/pts/0` and
`test -t 0` passed, so it is a real PTY there, not a pipe. `SessionScreen`
rendered that screen as text. A card edited in a host terminal pushed a new
`GavinTreeChanged` carrying the new title; `CreatePlan` from the desktop side
wrote `from-the-desktop.md` onto the host's disk. `KillSession` produced
`SessionExited` and the session left the host's list.

### The Git tab and the Files tree (v41 surface) — 19/19

`status`, `log`, `branch`, `diff --cached`, `commit -F -` with the message on
stdin, `stash list`, `worktree list`, all on the host, and the commit really
landed there. `ListWorkspaceDir`, `ReadWorkspaceFile`, `WriteWorkspaceFile`,
`StatWorkspacePaths` (which classified `/etc/passwd` as `outside` rather than
refusing it). The confinement holds and says why:
"../../etc/passwd contains a `..` component", and a cwd of `/etc` →
`/etc is outside the workspace root /home/gavin/repo`. And the argv rule:
`git log -1 '; touch /tmp/pwned'` came back
`fatal: ambiguous argument '; touch /tmp/pwned'` — an argument, never a shell.

### Fetch, pull, push and Cancel (v42) — 19/19 across two runs

- A push streamed **34** `GitOpProgress` lines (`Enumerating objects: 12,
  done.` …) and landed in the host's bare repo. A fetch with real work to do
  streamed **41** (`remote: Enumerating objects: 23, done.`, `remote: Counting
  objects: 7% (1/13)` …).
- **Cancel works, and it is the thing worth having checked.** A fetch pointed
  at an unroutable address was still running after 3 s, holding the streaming
  connection; `CancelGitOp` on the **command** connection answered
  `{"type":"GitOpCancelled","cancelled":true}` immediately, and the op ended at
  **3049 ms** with `{"type":"GitOpDone","op_id":"op-hang-1","error":"cancelled"}`.
  That is the design's load-bearing claim — a cancel queued behind the op it
  cancels never arrives — demonstrated over ssh rather than over a socket pair.
  Cancelling an op id that never ran answered `cancelled: false`, not an error.
- Credentials: a push to a private URL failed in **617 ms** with
  `fatal: could not read Username for 'https://github.com': terminal prompts disabled`.
  It fails with a message; it does not hang a request.
- Live refresh: a file changed in a host terminal pushed
  `{"type":"GitWorktreeChanged","cwd":"/home/gavin/repo"}`. After the link was
  dropped and remade, re-asking the watch worked and a further change fired it
  again — the rule that keeps a tab from going quiet after a reconnect.

### The Files tree's mutations, and the host's Trash — 27/29

(The two that failed were **the fixture's fault, not the host's**: this script
tried to start the conflicting rebase on `feature`, which is already checked
out in the linked worktree, so `git checkout` refused and no rebase ever began.
Re-run on a branch of its own below — 6/6.)

Create file and directory; an existing target refused by the filesystem itself
(`File exists (os error 17)`), and `a/b/c.txt` refused with
`No such file or directory` — no `create_dir_all`. Rename; renaming **onto** an
existing path refused (`src/other.txt already exists`), so there is no silent
overwrite; renaming outside the root refused.

**Trash is the host's Trash.** The file left the workspace and appeared in
`~/.local/share/Trash/files/`, with an info file reading exactly:

```
[Trash Info]
Path=/home/gavin/repo/src/renamed.txt
DeletionDate=2026-09-23T17:17:39
```

All three spec-mandatory parts are there, so a file manager on that machine can
Restore it. This is the case the card said nothing had exercised: the daemon
was started by `sshd` and has **no desktop session** — no X, no Wayland, no
session bus — and the freedesktop backend still trashed correctly rather than
falling back to a delete.

### Conflicts and the ignore editors

- A conflicting **cherry-pick** through `RunGitEnv`: the 3-pane read the
  conflicted file from the host (`<<<<<<< HEAD` … `>>>>>>> a42ab06`) and all
  **three** stages from `ls-files -u`; after writing the resolution and
  staging it, `cherry-pick --continue` returned 0 — no wait on an editor
  nobody can see.
- A conflicting **merge**: `.git/MERGE_HEAD` read from the host.
- A conflicting **rebase**: `.git/rebase-merge/head-name` → `refs/heads/rb` and
  `onto` → the sha, both read from the host's git dir, and `rebase --continue`
  through `RunGitEnv` returned 0.
- `RunGitEnv`'s allow-list holds: `GIT_SSH_COMMAND` was refused with
  `GIT_SSH_COMMAND is not an environment variable this daemon will set for git`.
- `.gitignore` reads and writes on the host; `.git/info/exclude` works on a
  normal root. **The documented linked-worktree narrowing reproduces exactly**:
  for a workspace rooted at the linked worktree, `rev-parse --git-common-dir`
  gave `/home/gavin/repo/.git` and the read was refused with
  `/home/gavin/repo/.git/info/exclude is outside the workspace root /home/gavin/wt`,
  while `.gitignore` at that root was unaffected.

### A real host on v41 — 17/17

Built from `main` (`c51990b9`) for Linux and run as a second host beside the
v42 one. Its banner reads `"protocolVersion":41`, which is the number the
desktop's gates are compared against.

What it still serves, and did: the **Git tab** (`RunGit`), the **Files tree**
(`ListWorkspaceDir`), the **`.gitignore` editor** and **`.git/info/exclude`**
(`ReadWorkspaceFile`), and the **3-pane's write** (`WriteWorkspaceFile`) — the
whole v41 surface, unaffected. Against `FEATURE_MIN_VERSION.sshGitFiles = 41`
that host passes, so those tabs are live; against `sshGitSync = 42` it does
not, so the three sync buttons, the tree's new/rename/trash and the two
GIT_EDITOR surfaces are the ones that grey out. That is the split the design
turns on, on a host that really is older.

And the belt-and-braces underneath the gate holds. Each of the eight v42
request types was sent to it deliberately — the thing a leaked gate would do —
and every one came back

```
{"type":"Unsupported","request_type":"unknown","min_version":41}
```

with **the link still alive**: a `GetProtocolVersion` after them answered
normally, the Git tab still worked, and a directory listing showed nothing had
half-applied (`["main.txt","other.txt"]` — no `nope.txt`, no `x.txt`, and
`main.txt` neither renamed nor trashed). So an ungated surface on an old host
is a refused request, not a dropped workspace. `min_version` there is the
daemon's own `PROTOCOL_VERSION` rather than the request's minimum, which is
what the `Request::Unknown` catch-all has to say when it cannot know which
variant it failed to parse.

### What broke

**Nothing on the host did.** Every behaviour above matched the design and the
install note, including the two the card singled out as untested — the cancel
that travels on a different connection, and a Trash performed by a daemon with
no desktop session. So there is **no rule to fold into the spec's §5 or into
`docs/ssh-workspaces.md`**, and no bug card to file from the Linux pass. What
follows is bookkeeping this card and the parent got wrong, plus one thing the
next person to run this should know before they read a working path as broken.

1. **The parent card's closing version claim is wrong.** It says
   "`PROTOCOL_VERSION` on `main` is now **42**; the next bump anywhere takes
   43." Checked: `main` (`c51990b9`) is **41**. 42 exists only on
   `feat/ssh-support`'s `40c401c9`, which is **not** an ancestor of `main` —
   the branch is one commit ahead. The board-audit paragraph above it, which
   says main is 41, is the correct one. Until `40c401c9` merges, an agent
   picking the next version by reading that sentence would skip one. Read the
   constant, not the card.

2. **"A host still on v41" is a host running `main`.** The card reads as if a
   v41 host were an older artifact to dig up and keep. It is not: `main` is
   exactly that host, because the whole v42 surface is the unmerged branch
   commit. That is what the old-host check below was run against.

3. **`ed97220` cannot be built on a Linux host at all** — worth knowing because
   `docs/ssh-workspaces.md` tells the human to run
   `cargo build --release -p gavin-daemon` *on the host*. At that commit
   `peer_uid_ok` called `libc::getpeereid` under a bare `#[cfg(unix)]`, and
   glibc has no such function:
   "error[E0425]: cannot find function getpeereid in crate libc".
   Already fixed, by `c388ffc9` "fix(daemon): read the peer uid through
   SO_PEERCRED on Linux", which splits the two arms. Not actionable on `main`
   — but it does mean no Linux host was ever installed from the intermediate
   Git-tab commit, so the only old Linux hosts in existence are `main` ones.

4. **Progress lines are git's, not gavin's — give the op work before judging
   it.** A `fetch` with nothing to bring down streams **zero**
   `GitOpProgress`, and so does a `pull` whose fetch phase already ran (both
   observed here: 0 lines, then 41 once there was a commit to fetch). Anyone
   checking "progress lines appear in the op row as the op runs" against an
   up-to-date repo will see an empty row and think the streaming is broken.
   It is not ssh-specific — a local op does the same — so it does not belong
   in the ssh install note; it belongs here, as a trap for the next run.

### What remains, and why this card is still open

The box on the parent stays unticked. Two thirds of this card were run for
real; the rest needs machines this session did not have.

- **A Windows host.** Nothing in that section has been exercised — not the
  `cmd.exe`/PowerShell shells, not the job-object breakaway in
  `spawn_detached`'s `#[cfg(windows)]` arm (the Linux `setsid` arm is now
  proven; they share no code), not the Recycle Bin, not the `C:/Users/...`
  root spelling. It needs an elevated shell to add the OpenSSH Server
  capability, or a second Windows box.
- **A macOS desktop.** Everything the app draws is still unseen: the op row
  and its progress, the buttons greyed out naming v42, the sidebar mark, the
  Reconnect banner, `remote-link-lost` hitting one workspace and not the
  others, and the links surviving a local-daemon restart from Settings. The
  protocol underneath each of those is verified; the wiring from it to the
  screen is not.
- **macOS as the desktop specifically.** Cross-OS was exercised, but as
  Windows → Linux. A macOS desktop has its own `getpeereid` arm and its own
  Trash backend, neither of which this pass touched.

The Linux host half can be re-run in about fifteen minutes: build the daemon
for Linux, put it on a box you can `ssh` to with keys, and drive
`ssh <host> "<daemon>" bridge` with newline-JSON. Two bridges per host, the
streaming one for `Attach` / `WatchGavinRoot` / `WatchGitWorktree` /
`RunGitStreaming`, the command one for everything else and for `CancelGitOp`
— sending a cancel on the streaming connection would queue it behind the op
it is meant to kill, which is the whole reason there are two.
