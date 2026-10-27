---
order: 15360
labels: bug
title: [bug] fallback limits ignored after restart
status: In Progress
complexity: moderate
---
After app restart, workspaces (Gavin, Grimoria, treccy) keep spawning Claude even when usage is far over the fallback threshold.

## Observed config (this machine)

- App `defaultAgent`: `claude-code`
- App `pauseCycles`: only `cursor` (limitEnabled true) — **no cycle for `claude-code`**
- App `fallbackChains` / `fallbackThresholds`: empty (not persisted)
- Gavin workspace: has `fallbackChains` for claude-code → cursor, kimi-code; agent profile `claude-code`
- Grimoria: no workspace fallbackChains; agent profile `cursor`
- treccy: no workspace fallbackChains; agent profile `claude-code`

## Cause (working)

`launchDecision` sets `limitEnabled: cycle?.limitEnabled ?? false`. With no `pauseCycles` entry for the launch primary, usage is ignored and the fallback chain never walks — even when the Settings UI shows the shipped default cycle (`limitEnabled: true` via `cycleOrDefault`).

## Plan

- [x] Fail: launch with spent Claude, chain configured, no pauseCycles key for claude-code still walks the fallback (or documents that limit gate needs a persisted cycle and UI stops lying)
- [x] Confirm which fix: seed DEFAULT_CYCLE.limitEnabled for launches, or require an explicit cycle and fix the Settings display
- [x] Fix + regression
- [ ] Human test: restart app with Claude over threshold; Gavin/Grimoria/treccy must not spawn Claude when a fallback is under threshold
- [x] Human test: restart app with Claude over threshold; Gavin/Grimoria/treccy must not spawn Claude when a fallback is under threshold
  Closed as stale (2026-10-21): a word-for-word duplicate of the item directly above, which stays open as the one check.
- [ ] Human test: Settings > Agents > Pause: a built-in agent's "Hold when a window is N% used" box is live; a custom agent's is greyed out and unchecked with the "only the schedule applies" hint

## Outcome

Chose neither extreme: with no `pauseCycles` entry, `launchDecision` now applies the limit gate when a fallback chain is configured for the launch primary (`limitEnabled = cycle ? cycle.limitEnabled : chain.length > 0`), against each agent's own `fallbackThresholds` (the 95% cycle default only applies on resume). It helps only agents whose usage gavin can read — every built-in agent has a probe, a custom one has none, so nothing blocks it. Settings now draws the limit controls off, with that reason, for a custom agent (`primaryReportsUsage`). An install with no cycle and no chain is still never held, so nothing pauses for someone who configured nothing. The old pinned test ("does not invent a usage pause" with a chain) encoded the bug and is split into the no-chain and chain cases. `pauseFor` is unchanged.
