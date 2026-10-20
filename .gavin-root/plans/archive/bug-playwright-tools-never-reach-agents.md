---
labels: bug
kind: task
title: [bug] Agents never get browser_* — Playwright MCP entry missing and Cursor drops GAVIN_SESSION_TOKEN
status: Done
parent: feat-tbdeveloped-playwright-integration.md
priority: high
complexity: complex
---
Fix why agents inside gavin never call Playwright `browser_*` tools. Start with the fix; the diagnosis below was already reproduced on 2026-10-19 — do not re-derive it from scratch.

## Already proven (feedback loop)

```
/Applications/Gavin.app/Contents/MacOS/gavin-mcp playwright
# exit 1
# gavin-mcp playwright: the gavin daemon refused PlaywrightEndpoint to this local
# connection -- is GAVIN_SESSION_TOKEN set?
```

- `.cursor/mcp.json` and `.mcp.json` in this workspace only have `gavin` — **no `playwright` server**, so agents never see `browser_*`.
- This agent process has `GAVIN_SESSION_ID` / `GAVIN_SESSION_SOCKET` / `GAVIN_MCP` but **`GAVIN_SESSION_TOKEN` is MISSING**. Hello stays `local`; with `require_local_token` on, `PlaywrightEndpoint` is Forbidden (privileged).
- Registry row for that session id: command `cclaude --dontask…`, `token_hash` present, `interrupted=1`. Parent PTY pid shows no `GAVIN_*` while the Cursor agent child has ID/SOCKET/MCP only.
- Workspace `[agent] profile = claude-code` (writes `.mcp.json`); Cursor sessions read `.cursor/mcp.json`. Install for one profile does not write the other.
- Design/spec: `docs/superpowers/specs/2026-10-08-playwright-integration-design.md`. Shim: `crates/gavin-mcp/src/playwright.rs`. Entry writer: `app/src-tauri/src/agent_playwright.rs` (Cursor dialect must include the same `${env:GAVIN_SESSION_*}` block as gavin's own entry). Auth gate: `authorize` + `agent_owns_session` for `PlaywrightEndpoint` in `crates/daemon/src/server.rs`.

## Fix order (do this, top to bottom)

1. **Get `browser_*` onto the agent** — Playwright must be Installed for the profile agents actually launch (at least Cursor → `.cursor/mcp.json`, and this workspace's `claude-code` → `.mcp.json`). Entry shape is already tested in `agent_playwright.rs`. If the wizard/Home catchup can leave a workspace with no entry while the feature cards look Done, fix that gap too.
2. **Stop the TOKEN drop** — a session with a minted `token_hash` must present `GAVIN_SESSION_TOKEN` to `gavin-mcp` (PTY env and, for Cursor, `${env:GAVIN_SESSION_TOKEN}` interpolation). Reproduce with a fresh Cursor tab from gavin after (1); `gavin-mcp playwright` must get `Response::PlaywrightEndpoint`, not Forbidden-as-local.
3. **Prove end-to-end** — from a gavin agent tab, call `browser_navigate` (or equivalent) and confirm the live pane / session browser path. Keep the red-loop command above green.

## Out of scope unless you hit them

- Companion / ssh live-pane human tests on the parent card.
- Bumping the `@playwright/mcp` pin (cache may only have headless-shell 1243; `pick_revision` already falls back).

Read `.gavin-root/PRD.md` and the parent card before coding. Commit only files you touch when the card asks — never `git add -A`.

- [ ] Human test: Open a fresh Cursor agent tab from gavin in this workspace, confirm browser_* tools appear, call browser_navigate to https://example.com, and confirm the live pane (or tab browser chip) shows Example Domain
