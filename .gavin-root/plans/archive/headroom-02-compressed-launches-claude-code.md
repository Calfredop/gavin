---
order: 7232
kind: task
title: Headroom 02: compressed launches and Claude Code
status: Done
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

- [x] The setting survives a restart, and both key-list parity tests pass
- [x] The decision function is tested for each row: off, not ready, no recipe, Cursor, a plain shell tab, an MCP spawn of `claude`
- [x] The Claude Code recipe is tested, including that no `x-headroom-session-id` is ever set
- [x] An older daemon is never sent a widened `CreateSession`; every launch surface shows its `featureBlockedReason` (tested)
- [x] A resumed session re-decides against Headroom's state at that moment (tested)
- [x] `cargo test --workspace`, `npm test` and `npm run check` green
- [ ] Human test: in a workspace with compression on, run a card with Claude Code on a Claude Max login; the agent works normally and Headroom's `/stats` shows requests under that session's id
- [ ] Decision: When a workspace has compression on but the running daemon is older than v47, agents launch uncompressed and the launch itself says nothing (the daemon banner and, once 04 lands, the greyed switch are the only signs). Should the launch also say so?
  Options: A) No: the daemon banner and 04's greyed switch are enough B) Yes: leave it to 06's exception mark, with 'daemon too old' as a fourth reason C) Yes: a notice at launch, on every surface that starts an agent

## Result (2026-09-29)

Done on branch `feat/headroom`, commit `9e1c7c53`, on top of the merge of `main` (`e81c0799`). Not pushed. Protocol **v47**.

Every check in CLAUDE.md is green on the committed tree: `cargo test --workspace` (daemon 830, app host 661, protocol 137, gavin-mcp 72, and the integration suites, among them the new `tests/headroom_sessions.rs` with 14); `npm test` (7037), `npm run check` and `npm run build`; the Companion's three; the Companion shell's three. Every guard the new tests rest on was also broken on purpose and seen to fail, 23 mutations across the daemon and the app.

A second commit, `b9f8f511`, repairs a guard that has been failing on `main` since the rail schedule landed (`turnVerdictSurfaces.test.ts` pinned the verdict as the LAST scheduler input, and `scheduleClock` was added after it). It is not part of this card and is on its own so it can be dropped if `main` fixes it another way.

### Where things are

- **Daemon:** `crates/daemon/src/headroom/compress.rs` (the decision and the recipe, both pure) and `switch.rs` (the daemon's copy, in `headroom-workspaces[-dev].json`). The decision is made in `SessionManager::create_session`, between the session id and the spawn.
- **Protocol:** `CreateSession.profile_id`, `SetHeadroomWorkspaces`, and `compressed` + `uncompressed_reason` on `SessionSummary`. The reason words are `not-ready`, `no-recipe` and `unsupported-agent`.
- **Host:** `Workspace::headroom`, `AppConfig::headroom` (`HeadroomDefault`), and the commands `get_headroom_default`, `set_headroom_default` and `set_headroom_workspaces`.
- **App:** `agents/compression.ts` (pure), `agents/compressionDriver.ts` (tells the daemon), and `profileIdForLaunch`, `setWorkspaceHeadroom` and `setHeadroomDefault` in `layoutState.ts`.

### How to run the human test before 04 lands

There is no switch on screen yet: 04 builds it. Until then:

1. Rebuild and restart the app and the daemon, so both speak v47.
2. Install Headroom where the daemon looks first: `uv tool install --python 3.13 "headroom-ai[all]==0.39.1"`.
3. Quit the app. In `~/Library/Application Support/com.gavin.app/config.json`, add `"headroom": true` inside the workspace's object. (A top-level `"headroom": true` is the app-wide default instead.)
4. Start the app. The daemon starts Headroom as soon as it is told a workspace is on; its port is in `~/Library/Application Support/gavin/headroom-run.json` (`headroom-run-dev.json` for a dev build).
5. Run a card with Claude Code, then `curl http://127.0.0.1:<port>/stats` and look under `per_project` for the session's id. Any command the agent runs sees `ANTHROPIC_BASE_URL` pointing at that port.

### What "every launch surface shows its `featureBlockedReason`" became

Every surface that launches an agent CONSUMES the gate, and none of them displays a sentence. They all get the profile they send from `profileIdForLaunch`, which names none against a daemon older than v47, and the agent then launches exactly as it did before. That is the shape `conversationResume` and `runChanges` already have, and it follows from the spec's own rule that compression never stops a launch: there is no control on a launch surface to grey out. `compressionSwitchBlocked` returns the sentence for the one place that can show it, 04's switch. Whether a launch should also say so on screen is filed below as a decision.

The spec's list of surfaces was short by six, and they are all covered: the main agent (two routes), a new page opened on the agent, an agent opened in a worktree, the fork dialog's "Start agent here", and the reviewers of a critical review. Rather than keep a list, `compressedLaunchSurfaces.test.ts` finds every call that creates a session and makes each one either carry a profile or be named as a shell with its reason, so a surface added later fails until somebody decides which it is.

### Five things the spec does not say, and what was done

1. **The app sends the whole list, and it replaces the daemon's copy.** A workspace that was closed has to stop counting, and a merge would keep Headroom running for one nobody can turn off.
2. **The daemon is told nothing until the workspaces and the default have loaded.** A list resolved before then says compression is off everywhere, and the daemon would stop the Headroom every running agent is talking through. Only the window holding the app's duties tells it, so a Companion never does.
3. **An agent that cannot be routed says so before readiness does.** A Cursor session reads `unsupported-agent` whether or not Headroom is up.
4. **The human's own headers are kept.** Setting `ANTHROPIC_CUSTOM_HEADERS` replaces what the session would have inherited, so the recipe carries the inherited lines over and drops Headroom's two. `x-headroom-session-id` is never sent, whoever set it.
5. **A daemon started from inside a compressed session does not pass that session's routing on.** On this project an agent runs the dev app and the app starts the daemon, so the three variables would reach every tab that daemon opens, plain shells included, under the launcher's tag. What is removed is recognised exactly (a project tag equal to the `GAVIN_SESSION_ID` beside it), so routing that is the human's own is left alone.

### For the merge

**v47 is provisional**, like 01's number was. `companion/wire` is at 49. Four places move together: `PROTOCOL_VERSION`, `COMPRESSED_LAUNCH_MIN_VERSION`, the `min_version_for` arm, and `FEATURE_MIN_VERSION.compressedLaunch`, plus the two pinned tests.

### For 03 to 06

- **03:** a recipe is one arm of `compress::recipe`, and `unroutable` is where an agent stops being `no-recipe`. `Recipe` carries environment only; the Codex argument needs a field for the command line.
- **04:** the state is ready to bind: `headroomDefault`, `setHeadroomDefault`, `setWorkspaceHeadroom`, `resolveHeadroom` and `compressionSwitchBlocked`.
- **05 and 06:** `compressed` and its reason stop at `SessionSummary`. Nothing carries them to the frontend yet.

### Not verified

- **A real Claude Code through a real Headroom.** Everything here runs against the fake. That is the human test.
- **Windows.** Not compiled for it, for the reason 01 gives.

### Known limits

- **Re-launch names the card's own agent.** If the run being replayed was launched on a fallback, the command is the fallback's and the profile sent is the card's. The rest of re-launch already makes the same assumption (failure patterns, `--session-id`).
- **An agent's own commands inherit its routing**, and so does a worktree's setup chained ahead of it. The spec accepts the first; the second is the same thing.
- **01's open decision still stands.** Headroom's own limiter is 60 requests a minute per login, shared by the whole fleet. Compression is off by default and has no switch on screen until 04, so nothing reaches a fleet yet, but it should be answered before 04 ships.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
