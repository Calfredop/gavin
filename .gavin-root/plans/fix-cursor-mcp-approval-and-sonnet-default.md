---
title: Fix Cursor MCP re-approval and Grimoria sonnet default
status: Done
---
Cursor re-prompts MCP approval every launch because it hashes resolved GAVIN_SESSION_* from .cursor/mcp.json env. Grimoria still pins model = "sonnet" after switching the workspace agent to Cursor.

## Checklist

- [x] Grimoria: change .gavin-root/config.toml model from sonnet to auto
- [x] Stop putting per-session env in Cursor mcp.json so the approval fingerprint stays stable
- [x] Pass session identity to gavin-mcp via a PPID side-channel the daemon writes on PTY spawn
- [x] Update agent_setup / playwright tests and committed .cursor/mcp.json
- [x] Verify approval hash stable across sessions; gavin-mcp still sees session when env is stripped
- [ ] Human test: After rebuilding/restarting the gavin daemon: open a fresh Cursor agent tab in Gavin and confirm MCP servers connect without an approval prompt. In Grimoria, confirm a new Cursor tab starts on Auto (not Sonnet 4).

## Notes

- Approval fingerprint with no env is now stable: `gavin-245ad6e744eecce5` / `playwright-9146c058abc504a8` for this checkout.
- Needs a rebuilt daemon + gavin-mcp (and a restarted daemon) before the passthrough file exists for new tabs. Until then, Cursor tabs started under an old daemon still get no session env on MCP children — approve once under the new mcp.json shape, then restart.
- Mandragora `.cursor/mcp.json` stripped of env as well so Grimoria does not wait on re-integration.
