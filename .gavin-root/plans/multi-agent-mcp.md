---
title: Multi-agent MCP support
kind: plan
status: To Do
priority: high
labels: agents
---
# Multi-agent MCP support

Make the five non-Claude profiles actually work. Settings already lets you
pick Codex, Gemini, Cursor, opencode or custom — but only `claude-code`
has an `McpLayout`, so for the rest gavin writes the agent file and then
tells you what it cannot do. This closes that gap.

Sub-project B of the split taken during the workspace-settings brainstorm
(A was the settings panel, shipped). Open items were recorded in §9 of
`docs/superpowers/specs/2026-08-20-workspace-settings-design.md`.

## What is broken today

- **Integration** writes the instructions block for every profile but
  records `skill file` and `MCP config` as skipped for four of six — so
  those agents know gavin exists and cannot call a single `gavin_*` tool.
- **"Ask the agent"** in the init wizard is hidden unless
  `AgentProfile.prompt_arg` is true, which is verified only for `claude`.
  A wrong guess puts garbage in the agent's argv, so the flow is withheld
  rather than risked.

## Verified conventions

Checked against upstream docs on 2026-08-20; re-verify before writing, as
these drift between releases.

| Profile | MCP config | Shape |
| --- | --- | --- |
| Gemini CLI | `.gemini/settings.json` | `mcpServers.<key>` — same shape as Claude's, different path |
| Cursor | `.cursor/mcp.json` | `mcpServers.<key>` — same again |
| Codex CLI | `.codex/config.toml` | TOML `[mcp_servers.<key>]` |
| opencode | `opencode.json` | `mcp.<key>` with `type: "local"` and `command` as an array |

Three of the four are a path change to the existing merge-aware JSON
writer. Codex needs format-preserving TOML (`toml_edit`, already a
dependency via the workspace-settings work). opencode needs a second JSON
shape.

## Steps

- [ ] Re-verify each CLI's MCP config path and shape against current docs
- [ ] `McpLayout` for gemini and cursor — path change only, existing writer
- [ ] Codex writer: `.codex/config.toml` via toml_edit, merge-aware, comments preserved
- [ ] opencode writer: `opencode.json`, `mcp.<key>` with a command array
- [ ] Verify each CLI's positional-prompt convention and set `prompt_arg`
- [ ] Custom profile: user-specified MCP config path and shape
- [ ] `skipped` shrinks accordingly; the wizard's Integration step needs no change
- [ ] Update the smoke checklist: `wiz-integration-degrades` and `wiz-agent-gate` describe fewer profiles

## Already answered

The recorded open item *"what replaces `.claude/skills/gavin/SKILL.md`
for agents with no skill mechanism"* was settled by the init wizard:
`instructions_block_for()` selects an inline block variant that carries
the guidance in the marker block itself. Inherit that; do not redecide it.

## Why it matters

Every profile beyond Claude Code is currently selectable but inert. Until
this lands, "gavin supports five agents" is true of the settings panel and
false of the product.
