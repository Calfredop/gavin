---
order: 9216
kind: task
title: [fix] .mcp.json points at the Windows gavin-mcp on the Mac
labels: bug, windows
status: To Do
priority: high
complexity: moderate
---
On the Mac the `gavin` MCP server fails to connect at every session start:

```
gavin (ENOENT): "Executable not found in $PATH: C:\Users\calfr\AppData\Local\gavin\gavin-mcp.exe"
```

so `gavin_name_session`, `gavin_set_plan_field` and every other `gavin_*` tool
is unavailable for the whole session, and agents have to file cards by hand.

**Why.** The checkout's `.mcp.json` is committed, and it carries ONE absolute
path to the binary — whichever machine last ran the wizard's integration
step (`resolve_mcp_binary_path` in `app/src-tauri/src/agent_setup.rs` writes
the `gavin-mcp` that sits beside the running app). The file has flip-flopped
with every machine: `d4191db` (this machine), `030d99f` (the checkout's
debug binary), `b8ba17c` (the Windows install). The same checkout is used
from a Mac and a Windows box, and no single path can be right on both.

**Do.** Make the MCP command machine-independent so the file stops being
re-pointed per machine. Interview first on which shape the human wants:

- a committed launcher the config names by RELATIVE path — e.g.
  `scripts/gavin-mcp` (sh) + `scripts/gavin-mcp.cmd` — that resolves the
  binary at launch per platform (the app install's, else this checkout's
  `target/debug/gavin-mcp`), so `.mcp.json` never carries an absolute path;
  the app's `write_mcp_config_json` / `json_entry` would then write the
  launcher rather than the resolved binary when one exists in the root;
- or keep `.mcp.json` out of the shared file by adding it to `.gitignore`
  and letting each machine's integration step write its own (note the
  checkout is also synced by CloudStation, so an untracked file may still
  travel — the launcher is the safer of the two);
- either way, point the Mac at its real binary now:
  `target/debug/gavin-mcp` exists in this checkout, and a release install
  ships one beside the app.

Whatever lands, `mcp_entry_present` / `remove_mcp_entry` and the wizard's
"re-run integration" must keep working on both platforms, and the tests in
`agent_setup.rs` that pin the written command (`/apps/gavin-mcp`) need
their counterpart for the launcher shape.
