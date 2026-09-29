---
order: 7264
kind: task
title: Headroom 03: Codex, opencode and Custom
status: Done
labels: ready-for-agent
parent: headroom.md
complexity: complex
---
Blocked by: headroom-02-compressed-launches-claude-code.md

Part of `headroom.md`. Read the spec (section "The recipes") first.

## What to build

- **Codex:** insert `-c openai_base_url="<base>/p/<session id>/v1"` right after the `codex` binary, and set `OPENAI_BASE_URL` to the same. `OPENAI_BASE_URL` alone does not route current Codex: the built-in `openai` provider reads only the config key, and its WebSocket transport ignores the env var. Apply the argument only where the daemon recognises the command as a Codex launch, by profile id or first token.
- **opencode:** set `OPENCODE_CONFIG_CONTENT` pointing the `anthropic` and `openai` providers' `baseURL` at `<base>/p/<session id>/v1`, and load Headroom's transport plugin from Headroom's install directory with `project: <session id>`. That plugin is what routes Zen and Go traffic. Write no file: `OPENCODE_CONFIG_CONTENT` merges with the on-disk config, including the MCP config Gavin's Integration writes.
- **Custom:** add an **API family** picker to the custom agent's settings, beside command and model flag: None (the default), Anthropic (`ANTHROPIC_BASE_URL=<base>/p/<session id>`) or OpenAI-compatible (`OPENAI_BASE_URL=<base>/p/<session id>/v1`). None means no recipe.

## Acceptance criteria

- [x] The Codex insertion is tested against lines with a `--model` suffix, with Gavin's prompt arguments, and as an MCP spawn
- [x] The opencode config content is valid JSON that keeps the on-disk MCP servers, and it carries the plugin path and `project` (tested)
- [x] The Custom picker persists, defaults to None, and None applies no recipe (tested)
- [x] `cargo test --workspace`, `npm test` and `npm run check` green
- [ ] Human test: in a compressed workspace, a Codex card run on a ChatGPT login and an opencode card run on Zen both work, and each shows its session's requests in Headroom's `/stats`
- [ ] Human test: Settings → Custom agent shows an API family picker (None / Anthropic / OpenAI-compatible) under Command and Model flag, reads None on a fresh config, and a choice is still selected after restarting the app

## Result (2026-09-29)

Done on branch `feat/headroom`, commit `a4bb26eb`, on top of 02's `9e1c7c53`. Not pushed. Protocol **v48**.

Every check in CLAUDE.md that this change can reach is green on the committed tree: `cargo test --workspace` (daemon 848, app host 666, protocol 138, gavin-mcp 72, and `tests/headroom_sessions.rs` now at 19); `npm test` (7047), `npm run check` and `npm run build`; the Companion's three. The Companion shell was not re-run: nothing it builds changed. Four guards were broken on purpose and seen to fail (a path-less binary match, a Headroom plugin left in the merged config, the launcher's base URL kept, and the rewritten line recorded in the registry).

### Where things are

- **Daemon:** `headroom/compress.rs` has the three recipes, all pure. `Recipe` gained `command`, the line to run instead, which only Codex sets. `install::opencode_plugin` finds the plugin inside the installed package. `SessionManager::create_session` runs the rewritten line and records the original.
- **Protocol:** `CreateSession.api_family` (v48) and `CUSTOM_API_FAMILY_MIN_VERSION`.
- **Host:** `AgentDefaultsConfig::custom_api_family`. `create_session` reads it and `api_family_for_daemon` sends it only with the `custom` profile and only to v48+.
- **App:** `agents/apiFamily.ts` (pure), the picker in Settings → Custom agent, and `FEATURE_MIN_VERSION.customApiFamily`.

### How each recipe came out

- **Codex.** `-c 'openai_base_url="<base>/p/<id>/v1"'` is inserted right after every command word that is the `codex` binary, by path or bare. The single quotes are there so Codex receives the TOML string exactly as its SDK passes it. The fake `codex` in the integration test records the argv the shell actually handed it. "Recognised as a Codex launch" means the profile id or the first token, as the card says. The line still has to contain a `codex` to put the flag after: `npx @openai/codex`, a wrapper, or a fallback's `claude` line under the card's `codex` profile gets `no-recipe`, not a session marked compressed that is not. A worktree setup chained ahead (`npm ci && codex …`) is handled.
- **opencode.** `OPENCODE_CONFIG_CONTENT` sets `provider.{anthropic,openai}.options.baseURL` to `<base>/p/<id>/v1`, plus `plugin: [[<path>, {"proxyUrl": <base>, "project": <id>}]]`. It has no `mcp` key. The merge was checked against the real opencode 1.18.25 (`opencode debug config`): the on-disk `mcp.gavin`, a provider's `apiKey` and the human's own plugins all survive. `proxyUrl` rides as a plugin option rather than `HEADROOM_PROXY_URL`, so the commands opencode runs do not inherit another variable. The plugin is found at `<env>/lib/python3.*/site-packages/headroom/providers/opencode/_dist/entry.opencode.js`, where `<env>` is derived from the real `headroom` script the way `tool_python` is. A Headroom without that file gives `no-recipe`: without the plugin, Zen would be marked compressed and send Headroom nothing.
- **Custom.** The picker offers None (default), Anthropic and OpenAI-compatible. It is stored as `agentDefaults.customApiFamily` in config.json, as a string that is absent when None.

### Things the card did not say, and what was done

1. **The host attaches the family, not the launch surfaces.** The family is a setting of the custom agent, and the profile id already says a launch is that agent's. Threading it through the ~15 surfaces 02 widened would add an argument none of them decides. So `create_session` reads it from its own `AgentDefaults`, which also covers every future surface.
2. **App-wide only.** The picker sits beside the app-wide custom command and model flag. A workspace that overrides the custom command in `config.toml` still gets the app-wide family. There is no per-workspace override yet.
3. **The registry keeps the original line.** `card_sessions` copies it for re-launch, and the rewritten line names this session's tag and this Headroom's port.
4. **The human's own `OPENCODE_CONFIG_CONTENT` is kept**, the same way 02 keeps their headers: ours is merged over it, and an earlier Headroom plugin in it is replaced so the transport is not loaded twice.
5. **A daemon started from a compressed Codex, opencode or custom session** does not pass that routing to the tabs it opens. 02 already did this for Claude Code. The new recipes are recognised by the launcher's tag on the `/p/` path or the plugin's `project`, and the human's own routing is left alone.

### How to run the human test

Same setup as 02's (rebuild and restart so app and daemon both speak **v48**, install Headroom 0.39.1 with uv, set `"headroom": true` on the workspace in config.json), then:

1. Put the workspace (or a card, via `agent: codex`) on Codex, logged in with ChatGPT. Run a card. The agent should work normally. `curl http://127.0.0.1:<port>/stats` should list the session's id under `per_project`.
2. The same with opencode on a Zen model. `ls ~/.local/share/uv/tools/headroom-ai/lib/python3.13/site-packages/headroom/providers/opencode/_dist/entry.opencode.js` should exist first. If it does not, the session reads `no-recipe`.
3. Optionally, a custom agent with its API family set.

### For the merge

**v48 is provisional**, like 47. Five places move together: `PROTOCOL_VERSION`, `CUSTOM_API_FAMILY_MIN_VERSION`, `FEATURE_MIN_VERSION.customApiFamily`, the pinned test in `protocol` and the one in `compressedLaunchSurfaces.test.ts`.

### Not verified

- **A real Codex and a real opencode through a real Headroom.** Everything runs against the fake Headroom, a fake `codex` and opencode's own config resolver. That is the human test.
- **Loading the plugin.** It was checked by reading Headroom's source: `HeadroomPlugin(input, options)` reads `options.proxyUrl` and `options.project`. It was not run inside opencode.
- **The picker's look.** It was not seen in the running app.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
