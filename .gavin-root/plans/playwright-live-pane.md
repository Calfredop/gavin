---
kind: task
title: Desktop live-view pane for an agent's browser
parent: feat-tbdeveloped-playwright-integration.md
complexity: complex
---
Show the agent's browser live beside its tab. First read the spec `docs/superpowers/specs/2026-10-08-playwright-integration-design.md` and the settled decisions in the parent card (`feat-tbdeveloped-playwright-integration.md`).

- **Setting:** `playwrightPaneOpen`, with two values: `auto` (the app default) and `chip`.
  - The app-wide value goes in Settings.
  - The per-workspace override follows `terminalFontSize` all the way through: stored as an absence in `config.json`, saved through `set_workspace_settings` (never `set_workspaces_state`), and listed in `workspaceSettings.ts`.
  - `workspaceSettingsParity.test.ts` must pass, and Settings search must find the setting.
- **Pure logic:** a `.ts` module under `app/src/lib/panes/`, or whichever domain folder fits per `sources.ts`. It:
  - subscribes to the session's screencast push;
  - works out the effective setting: the workspace override if present, else the app value;
  - on the first frame, opens the pane split beside the owning tab when the setting is `auto`, and only shows the tab chip when it is `chip`;
  - handles hide and reopen through the chip, and teardown when the session ends.

  Guard async supersession with a token counter, never identity (Svelte 5 proxies). The `.svelte` pane stays a thin template that renders frames. It is view-only and shows the page URL.
- Respect the WKWebView traps in CLAUDE.md. Use no native dialogs.
- Gate the pane behind `featureBlockedReason` for daemons older than the broker's version.
- **Unit tests for the module:**
  - auto-open on the first frame, and no second pane on later frames;
  - with `chip`, no pane opens and the chip shows;
  - the workspace override beats the app value in both directions, and an absent override inherits the app value;
  - hide, then reopen;
  - teardown on session end;
  - an older daemon.

Done = `npm test`, `npm run check` and `npm run build` pass. File `Human test:` items only for what the screen looks like.

- [ ] Human test: an agent's browser pane beside its tab reads well in both themes — the address row shows the page URL with "View only" at its end, the page is scaled to fit the pane without distortion, and once the browser stops its last frame is dimmed under the "The browser stopped" note
- [ ] Human test: the globe chip sits in the tab bar's actions only while the active terminal's agent has a browser running, its tooltip names the page, and Settings → Agent browser (app-wide and in a workspace's Settings tab) shows the Live view picker with a Default row that names what it inherits
- [ ] Human test: on the Home tab, the main agent's header shows the globe chip while its browser runs; pressing it puts the browser in the lower half of the agent's cell, under the terminal, with the chip shown pressed, and pressing it again gives the terminal its full height back

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
