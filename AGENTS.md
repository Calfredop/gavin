<!-- gavin:start -->
## Gavin workspace

This repo is a gavin workspace. Read `.gavin-root/PRD.md` first — it leads all
development. Follow the gavin workflow skill in `.kimi-code/skills/gavin/SKILL.md`
(plan before coding, keep plan statuses current, use the gavin_* MCP tools).
<!-- gavin:end -->

## Codex

Codex discovers repo skills from `.agents/skills/`; use the matching skill when
its description applies. The Gavin MCP server is configured in
`.codex/config.toml` and launched through `scripts/gavin-mcp`. Read-only board
and session setup tools are approved automatically; keep card writes and other
mutating MCP tools approval-gated. Do not set a project model, sandbox mode, or
command approval policy here: inherit the user's Codex settings.
