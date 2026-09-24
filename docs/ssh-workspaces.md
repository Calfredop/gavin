# SSH workspaces

A workspace whose repository lives on another machine — a Linux box, a
Windows box — reached from the desktop over ssh. The desktop may be macOS,
Linux or Windows. Design: `superpowers/specs/2026-09-22-ssh-workspaces-design.md`.

## How it works, in one paragraph

Gavin's daemon is the thing that owns a workspace: its terminals, the
`.gavin-root` watcher, the board, the rails, git status. For an ssh workspace
that daemon runs **on the host**, and the desktop drives it over
`ssh <host> gavin-daemon bridge`. The bridge connects to the host's own daemon
(starting it if nothing is running), prints one line naming that daemon's
token, and then relays bytes. The desktop presents the token, so the
connection is the `app` role on that daemon exactly as it is at home, and
every request goes through the same gate.

## What the host needs

1. **An ssh server** the desktop can reach non-interactively: keys or an
   agent, never a password prompt — the app runs ssh with `BatchMode=yes` and
   a prompt it cannot answer is a connection that fails. Everything in your
   `~/.ssh/config` applies: aliases, jump hosts, `ControlMaster`.
2. **The `gavin-daemon` binary**, built for the host's OS. It is the same
   binary the desktop app ships beside itself:
   - from a gavin install: `gavin-daemon` (`gavin-daemon.exe` on Windows)
     next to the app's executable;
   - from source, on the host: `cargo build --release -p gavin-daemon`, then
     `target/release/gavin-daemon`.

   Put it on the host's `PATH`, or anywhere at all and name that path in the
   workspace's ssh settings (`daemonPath`). The path is quoted once with
   double quotes on the remote command line, which both `sh` and `cmd.exe`
   accept, so it may contain spaces but not a double quote.
3. **Nothing else.** No port to open, no service to install, no config file
   on the host. The daemon keeps its state where it always does on that OS
   (`~/.local/share/gavin` on Linux, `%LOCALAPPDATA%\gavin` on Windows) and
   logs to `daemon.log` there. It outlives the ssh session: closing the app
   leaves the host's agents running, as at home.

### Windows hosts

- Install OpenSSH Server (Settings → Optional features, or
  `Add-WindowsCapability -Online -Name OpenSSH.Server*`) and start the
  `sshd` service.
- The default shell for ssh sessions is `cmd.exe`. The remote command gavin
  sends — `"<daemonPath>" bridge` — is valid there and under PowerShell, so
  either default works.
- The workspace's root is written the way every path crosses gavin's wire:
  forward slashes, `C:/Users/me/repo`.
- Agents run on the host, so the agent CLI (Claude Code, codex, …) and
  `gavin-mcp` must be installed **there**, on the PATH the ssh session sees.

### Linux hosts

- `gavin-daemon` needs nothing beyond glibc. The socket goes under
  `$XDG_DATA_HOME/gavin` or `~/.local/share/gavin`.
- The daemon is started in its own session (`setsid`), so it survives the
  ssh session ending and a later `ssh` reaches the same one.

## The workspace's ssh settings

```json
{
  "rootPath": "/home/me/repo",
  "ssh": { "host": "box", "daemonPath": "/opt/gavin/gavin-daemon" }
}
```

`host` is anything `ssh <host>` accepts. `daemonPath` is optional and
defaults to `gavin-daemon` on the host's PATH. Both are machine-local (they
live in the desktop's `config.json`, never in the repository).

## What works over ssh today, and what does not yet

Everything below is decided by the version of the daemon **on the host**,
never the desktop's own — and every surface that needs a newer one says so,
naming the version, rather than failing on click or running against the
desktop's disk by mistake.

Works on any host inside the version window: terminals, the board, the plan
tree and PRD, orchestration and tools, git status in the tab strip.

- **v40 or newer — card runs.** The card and its attachments are read from
  the host, and "Set up / update" agent integration writes the MCP config,
  skills and instructions block there, naming the `gavin-mcp` that sits
  beside the host's `gavin-daemon` (install both).
- **v41 or newer — the Git tab and the Files tab.** Status, diff,
  stage/unstage, commit, log, branches, stash and worktree list run on the
  host; the file tree lists, and files open, edit and save there. Conflict
  resolution (the 3-pane) and the `.gitignore` / `.git/info/exclude` editor
  work here too.
- **v42 or newer — fetch, pull and push; live refresh; the tree's
  mutations.** The network ops run on the host and stream their progress
  back, with the same Cancel; the Git tab refreshes itself when something
  on the host changes, instead of needing Refresh; New file, New folder,
  Rename and Move to Trash work in the Files tree; and cherry-pick and
  `<op> --continue` work in the Git tab.

**Moving something to the Trash puts it in the HOST's Trash** — the
freedesktop trash on Linux, the Recycle Bin on Windows, the Trash on macOS
— not `rm`. It is restorable from that machine's own file manager, which is
the same promise gavin makes locally. The confirmation is still asked on
the desktop, where you are.

Two things stay the desktop's, and are refused with a message: worktrees
(best-of-N, rail binding) and the setup wizard's PRD and git steps, plus
the delete wizard. One thing works but is narrower than at home: an ssh
workspace whose Git tab is pointed at a **linked worktree** cannot edit
`.git/info/exclude`, because a linked worktree's common git dir can sit
outside the workspace root and the host refuses paths outside it.
`.gitignore` at the toplevel is unaffected.

## When it fails

- `gavin-daemon: command not found` (or `is not recognized` on Windows): the
  binary is not on the host's PATH for a non-interactive ssh session — which
  reads fewer profile files than a login shell. Set `daemonPath`.
- `Permission denied (publickey)`: ssh could not authenticate without a
  prompt. Load a key into the agent or add one to `~/.ssh/config`.
- `the gavin daemon is newer than this app`: the host's daemon was built
  from a newer checkout than the desktop app. Update the app, or rebuild the
  host's daemon from the app's commit.
- The link drops: the app reports `remote-link-lost` for that host and only
  that host's workspaces are affected. Reconnect from the workspace.
