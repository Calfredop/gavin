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

Works: terminals, the board, the plan tree and PRD, orchestration and tools,
git status in the tab strip — everything the host's daemon does. Card runs
too, when the host's daemon is v39 or newer: the card and its attachments
are read from the host, and "Set up / update" agent integration writes the
MCP config, skills and instructions block there, naming the `gavin-mcp`
that sits beside the host's `gavin-daemon` (install both). The Run pill
says which version the host needs when it is older.

Not yet (each refused with a message naming this, never run against the
desktop's own disk by mistake): the Git tab, the Files tab, worktrees
(best-of-N, rail binding), the setup wizard's PRD and git steps, the delete
wizard. See the ssh card's checklist for the follow-ups.

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
