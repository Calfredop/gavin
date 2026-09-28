# The daemon runs Headroom, and Gavin wires agents to it itself

Headroom compresses what an agent sends to its model, and ships its own launcher for the job: `headroom wrap <tool>` starts a proxy if none is running and launches the agent pointed at it. We decided that Gavin never uses `wrap`. Each daemon runs its own Headroom as a supervised child process, and Gavin applies a per-agent recipe of environment variables (plus one launch argument for Codex) when the daemon spawns an agent. See the spec, "Gavin wires agents itself" and "The daemon runs Headroom".

`wrap` writes files to route an agent:

- **Claude Code:** the repo's `.claude/settings.local.json` plus a SessionStart hook, the Serena MCP server at user scope in `~/.claude.json`, and a `.serena/` folder in the checkout.
- **Codex:** `$CODEX_HOME/config.toml`.
- **opencode:** `~/.config/opencode/opencode.json`.

In a checkout shared by many agents and worktrees, those writes collide with each other and with the MCP config that Gavin's own Integration writes. Every one of them can be replaced by environment and argv that last only as long as the process. The daemon, not the app, owns Headroom because the daemon owns the agent PTYs, and they outlive the window: a Headroom that died with the app would take every compressed agent's model connection with it.

## Considered options

- **Launch agents through `headroom wrap`.** Rejected, for the file writes above. Also, `wrap` reuses whatever proxy is already on the port, with whatever flags it was started with.
- **The Tauri app runs Headroom.** Rejected. Closing the window would cut every compressed agent off mid-turn.
- **A visible PTY session running `headroom proxy`.** Rejected. Headroom is infrastructure, not an agent, and a tab for it is noise. The daemon gets the same lifetime without the tab.
- **Headroom's own service installer** (launchd, systemd, Task Scheduler). Rejected. Its flags, version and lifetime would sit outside Gavin's sight, so Gavin could not guarantee the beacon was off or the version tested.
- **One Headroom shared by the release and dev daemons, or adopting one the human already runs.** Rejected. Two proxies over one state directory overwrite each other's savings, and an adopted proxy runs with flags Gavin did not choose.

## Consequences

- The daemon gains its first long-lived child that is not a PTY. It restarts that child when it dies, and after its own crash it re-adopts the child by recorded pid (start time as the reuse guard), `/health` fields and port, because agents can outlive the daemon.
- Gavin depends on Headroom's CLI flags, environment names, HTTP endpoints and URL conventions, so it pins a tested version and enforces a version floor.
- A recipe exists only where the agent CLI can be routed without writing a file. Cursor cannot be routed at all, and Gemini waits on a spike.
- Routing by environment reaches whatever the agent itself runs (its tests, for instance), exactly as `wrap` does. Plain shell tabs are not given the variables.
