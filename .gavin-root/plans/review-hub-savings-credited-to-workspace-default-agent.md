---
order: 38912
kind: note
title: The hub credits Headroom savings to the workspace's default agent, not the agent that ran
status: To Do
priority: medium
---
Branch `feat/headroom` (headroom-05, d946dd95). For the human to judge: the attribution is deliberate and documented in the code, but it puts savings on the wrong limit.

**Where.** `app/src/lib/agents/headroomSavings.ts:126-141` (`savingsByProfile`), fed by `app/src/lib/hub/AppHubView.svelte:286`: `profileByWorkspace` = `$resolvedAgents(w.id).profileId`. A run's savings go to the usage row of whatever agent its WORKSPACE defaults to. The doc comment says so: "a run does not record which profile launched it".

**What breaks.** A run's agent is often not the workspace default. A card's `agent:` line, a `complexity:` level (`agentForCard`), the fallback chain and Best-of-N candidates can all launch Codex in a Claude Code workspace, and headroom-03 compresses Codex. Those savings are summed into Claude's row and measured against Claude's 5-hour or 7-day window, which is the limit they did not stretch. Changing a workspace's default agent also moves all of its past savings in the window to the new agent's row.

**The case (a vitest run in a detached worktree, fails).** `ws-1` defaults to `claude-code`. A card with `agent: codex` runs compressed and saves 30,000 tokens. `savingsByProfile(rows, { "ws-1": "claude-code", "ws-2": "codex" }, runs)` gives codex 0 and claude-code 30,000.

**If you want it exact.** The daemon already receives `CreateSession.profile_id` for every agent launch. Record it on the registry row or the card run, and return it in `RunSavings`; then `savingsByProfile` keys by the run's own profile and falls back to the workspace's only for rows written before that. It widens a reply, so it needs a protocol bump; it is not a new request type. The alternative is to keep the approximation and say in the row's tooltip that savings are attributed by workspace.

A cheaper signal already exists. Run history does not attribute by workspace: `agentLabel` (`app/src/lib/cards/runHistory.ts:155`) reads the agent off the run's recorded `command` (the original line; the registry keeps it un-rewritten). Carrying that command, or the agent it names, in `RunSavings` would let the hub key savings the way run history already labels runs. Either way it widens the reply.
