---
order: 16384
kind: task
title: [bug] “auto” model
status: Done
complexity: complex
---
In Grimoria workspace, Claude Code keeps failing on start, beacuse it gets feed with the “auto” model, which is a residue from Cursor setting. Why this leftover? Fix agent switch and make sure that model feeding doesnt get polluted across agents

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

## Findings

Grimoria's `.gavin-root/config.toml` reads `profile = "claude-code"` beside
`model = "auto"`. `[agent]` holds ONE `model` (and `effort`, `model_flag`,
`effort_flag`) for whichever agent the workspace is on, but every path that
changes the agent rewrote only `profile` (+ `command`/`file` since db8431ff):
`switchWorkspaceAgentProfile` (the agent-change wizard) and the setup wizard's
Agent step. Cursor's `auto` survived the switch and launched `claude --model auto`.
The wizard's own preview (`pendingAgent`) already resolved the new agent with
no model — the commit never wrote what it previewed.

Same leak, two more places: the wizard's Remap carries a row's model onto the
new agent (`{cursor, auto}` → `{claude-code, auto}`), and changing a card's
`agent:` keeps its own `model:`/`effort:`.

## Plan

- [x] Every workspace profile write clears model/effort/model_flag/effort_flag (wizard + setup step); `setAgentField` no longer takes `profile`
- [x] Remap drops the model/effort/advisor of a row it retargets
- [x] Changing a card's agent clears its own model/effort when the resolved agent changes
- [x] Heal Grimoria's config.toml (remove the leftover `model = "auto"`) — uncommitted in mandragora; `effort = "high"` kept (chosen for Claude Code, valid there)
- [x] Tests + checks, commit
- [ ] Human test: In Grimoria, start Claude Code (main agent or Run a card): Settings → Agents shows "Launches as claude --model 'opus[1m]' --effort high" and the session starts without the --model auto error

Notes: each clear is gated on the daemon version that introduced its key
(`model` v14, `model_flag` v31, `effort`/`effort_flag` v56), so a switch still
works against an older daemon. Five ARCHIVED Done Grimoria cards still carry
`model: auto` (four with no `agent:`, one with `agent: cursor`) — left alone;
a bare card `model:` is a deliberate "workspace's agent on this model" and
follows the workspace by design. No other workspace had a leftover.
