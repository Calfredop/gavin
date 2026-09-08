---
kind: task
title: [sec] surface repo-shipped MCP servers at agent setup
status: Done
priority: medium
complexity: moderate
---
**Severity:** Medium. Finding **R3** in `docs/security/README.md` (source AG-07 in `03-agent-surface.md`). The report lives on branch `sec/review-2026090801` until merged.

**The problem.** `setup_agent_integration` merges gavin's own `gavin` server entry into whatever `.mcp.json`, `.codex/config.toml`, `.gemini/settings.json` or `opencode.json` the repo already ships (`agent_setup.rs:1002` `write_mcp_config_json`, `:1027` `write_mcp_config_toml`), preserving every other server key. A cloned repo that ships a server with a `command` pointing anywhere keeps it beside gavin's, and the agent CLI launches it. Launching it is the agent vendor's decision; leaving it there unmentioned, after a step the human reads as "gavin set up the integration", is gavin's.

**The fix.** In `agent_setup.rs` and the wizard/Settings surfaces that call it: when the target file already exists and carries server entries that are not gavin's, return them (name, command, args) instead of silently merging, and have the UI list them with two choices that name the action — keep them, or write gavin's entry into a file that contains only it (leaving the repo's file untouched, where the agent CLI supports a second config location; otherwise refuse and say why). Record the choice in the same workspace-trust marker `sec-fix-workspace-trust.md` introduces, so the question is asked once per distinct set. Unit tests for: no existing file, existing with only gavin, existing with a foreign server.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
