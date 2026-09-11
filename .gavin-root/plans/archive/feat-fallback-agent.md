---
complexity: intricate
order: 7168
kind: plan
title: "[feat] fallback agent"
status: Done
---
When a launch's resolved agent is over the usage-probe threshold, do not
permanently change the workspace agent. Walk an ordered fallback chain and
launch on the first agent that is under threshold and armed for that
workspace. If a needed chain agent is not armed, block the launch and open
the arming wizard (do not skip, do not launch degraded).

Arming uses the same Integration / Superpowers / skills flow as workspace
agent-change, but must NOT commit a new active profile or realign complexity —
active agent stays primary; chain agents are only made launchable.

Limit pause is replaced by the chain when any usable agent remains; the
duty-cycle pause stays a hard hold on all new starts. Mid-flight work is
never touched. Empty/absent chain = today's pause-only behaviour.

Config: ordered profile-id chain on app settings (default) and workspace
override (absence = inherit app chain). Same inheritance posture as
`agent_pause`. Init wizard offers the chain on the agent step.

App-level changes that inheriting workspaces must absorb (fallback chain
and app default agent): on workspace focus, run arming for each agent that
workspace still needs. Workspace settings: picking/editing the chain opens
arming immediately for newly added agents.

Out of scope: permanently switching the workspace profile as the fallback
mechanism; killing or migrating sessions already running; inventing usage
probes for agents that have none (no-probe agents never count as
limit-spent; as chain entries they remain eligible).

Assumptions: workspace override replaces the whole chain; "armed" means
that profile's MCP/skills/Superpowers setup is already satisfied for the
workspace (reuse existing setup detection); machine-local like `agent_pause`.

- [x] Config + pure resolution: store app/workspace fallback chain; resolve
      launch agent = walk chain when resolved agent is over limit threshold;
      cycle pause still blocks; unit tests for inherit/override, walk order,
      unarmed-needed, empty chain = pause-only
- [x] Setup-only arming path: wizard/flow that arms a profile without
      changing active agent or complexity; reuse Integration/Superpowers;
      unit + surface tests; distinct from switch wizard commit behaviour
- [x] Settings + init: app Global Settings chain editor; workspace override
      with inherit affordance; init wizard agent step; saving workspace chain
      opens arming for new entries
- [x] Focus + launch triggers: on focus, arm agents owed by app-level
      default agent and/or inherited chain; at launch, if next chain agent
      is unarmed, block and force arming wizard; wire card runs and rail
      starts through the same resolution
- [x] Verify: targeted tests for the modules above; `cargo test` /
      `npm test` / `check` / `build` as touched; static pre-flight of new
      Settings/wizard copy — owner confirms in the running app

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
