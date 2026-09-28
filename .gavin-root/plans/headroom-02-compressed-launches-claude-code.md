---
order: 7232
kind: task
title: Headroom 02: compressed launches and Claude Code
status: To Do
labels: ready-for-agent
parent: headroom.md
complexity: intricate
---
Blocked by: headroom-01-daemon-runs-headroom.md

Part of `headroom.md`. Read the spec (sections "The switch", "Compressed sessions" and "The recipes", the Claude Code row) and ADR 0007 first.

## What to build

- **The switch.** A workspace setting, `headroom`, where absence means inherit, and an app-wide default in `config.json` that starts Off. It follows the review gate's pattern. Add the key to both `SETTINGS_KEYS` lists (`workspace_settings.rs`, `workspaceSettings.ts`) and write it through `set_workspace_settings`, never `persistWorkspaces` (ADR 0006).
- **The daemon's copy.** The app pushes each workspace's effective setting to the daemon whenever it changes. The daemon persists its copy and starts or stops Headroom (01) when any workspace is on or none is.
- **Widen `CreateSession` with the launching profile's id.** Every launch surface sends it: card run, develop, resume and relaunch (`cardRunActions.ts`), rail steps and the orchestration agent (`orchestrationState.ts`), Best-of-N, tools, reviews, and the hidden commit run (`gitState.ts`). This widens an existing request, so add a `FEATURE_MIN_VERSION` entry in `daemonCompat.ts` **and** a `featureBlockedReason` consumer on every one of those surfaces.
- **The decision at spawn, in the daemon.** A pure function of (workspace effective setting, Headroom ready, profile id, or for `SpawnAgentSession` the command's first token against the known agent binaries). Plain shell tabs never qualify. Record `compressed` on the session, and the reason when a session in a compressed workspace is not compressed: not ready, no recipe, or an unsupported agent.
- **The Claude Code recipe:** `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`, `ENABLE_TOOL_SEARCH=true`, `ANTHROPIC_CUSTOM_HEADERS=X-Headroom-Project: <session id>`. Never send `x-headroom-session-id`.
- **Relaunches decide again.** Resume, relaunch, the fallback chain and auto-resume all spawn fresh. None of them carries the old decision over.

## Acceptance criteria

- [ ] The setting survives a restart, and both key-list parity tests pass
- [ ] The decision function is tested for each row: off, not ready, no recipe, Cursor, a plain shell tab, an MCP spawn of `claude`
- [ ] The Claude Code recipe is tested, including that no `x-headroom-session-id` is ever set
- [ ] An older daemon is never sent a widened `CreateSession`; every launch surface shows its `featureBlockedReason` (tested)
- [ ] A resumed session re-decides against Headroom's state at that moment (tested)
- [ ] `cargo test --workspace`, `npm test` and `npm run check` green
- [ ] Human test: in a workspace with compression on, run a card with Claude Code on a Claude Max login; the agent works normally and Headroom's `/stats` shows requests under that session's id

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
