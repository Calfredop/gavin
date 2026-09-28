---
order: 7264
kind: task
title: Headroom 03: Codex, opencode and Custom
status: To Do
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

- [ ] The Codex insertion is tested against lines with a `--model` suffix, with Gavin's prompt arguments, and as an MCP spawn
- [ ] The opencode config content is valid JSON that keeps the on-disk MCP servers, and it carries the plugin path and `project` (tested)
- [ ] The Custom picker persists, defaults to None, and None applies no recipe (tested)
- [ ] `cargo test --workspace`, `npm test` and `npm run check` green
- [ ] Human test: in a compressed workspace, a Codex card run on a ChatGPT login and an opencode card run on Zen both work, and each shows its session's requests in Headroom's `/stats`

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
