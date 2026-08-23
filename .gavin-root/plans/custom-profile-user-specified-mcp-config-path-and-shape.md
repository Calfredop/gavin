---
kind: task
title: "Custom profile: user-specified MCP config path and shape"
parent: multi-agent-mcp.md
---
The five stock profiles now each carry a verified `McpLayout` in
`app/src-tauri/src/agent_setup.rs`. `custom` cannot: its config file lives
wherever the user's agent reads one. Give it the same capability, driven
by the workspace's own config rather than the static table.

Do this:

- Two new `[agent]` keys in `.gavin-root/config.toml`: `mcp_file` (a
  path relative to the root) and `mcp_format` (one of the `McpFormat`
  dialect names — default to the `mcpServers.<key>` JSON one, which three
  of the five CLIs use). Add both to the allow-lists in
  `crates/daemon/src/gavin.rs::set_root_config_field` AND
  `agent_setup.rs::write_root_config_key`, and to `AgentConfig` in
  `crates/protocol`.
- `agent_setup.rs`: resolve a layout from the profile row for the stock
  five and from those two keys for `custom`. The layout's fields are
  `&'static str` today and a custom path is a `String`, so this needs a
  small owned resolved type rather than the table's borrowed one.
- Reject a path that escapes the root — absolute, or containing `..` —
  the way `move_agent_file` already refuses a name with a separator.
  A settings field must never be able to write outside the root.
- Settings: with `custom` selected, offer the two fields. `mcpSupported`
  for `custom` follows from whether `mcp_file` is set, so the "Set up /
  update" row appears once a path is named and the Integration step stops
  reporting MCP config as skipped.

Tests, in the style already in `agent_setup.rs`: a custom profile with a
configured path and each dialect writes the right file; an escaping path
is refused; an unset path still degrades to both omissions named.
