---
title: Rail step stale card path — build
status: Done
---
Implementation record for [Rail step keeps a stale card path when the file moves](rail-step-stale-card-path.md).

A card path is an identity two databases key on, and it went stale in two
different ways. The daemon's fs watcher now heals both.

**1. The file moved without the daemon moving it** (an agent's `mv`, the
one-time `plans/done/` migration, a hand edit). Every scan the watcher makes
now re-points any step path with no file behind it at the one card of that
file name under the same `plans/` root — the identity `parent:` already
resolves on. Ambiguity is declined, not guessed. The check is stateless, so it
heals damage that was already on disk rather than only catching future moves.

**2. The daemon moved it and never said so.** `follow_card_move` re-keyed both
databases but pushed nothing, and the app re-reads the orchestration only on
mount — so after every archive-on-Done its cached step still spelled the old
path, the card read as missing, and the step stalled the moment its session
ended. That is the same headline symptom, one layer up, and new since Done
cards started moving into `plans/done/`.

- [x] `gavin.rs`: `owning_plans_root` + pure `recover_moved_card_paths(tree,
      paths) -> [(old, new)]`, and a `ScanHook` the watcher calls on every
      scan (ahead of the change gate AND of the tree push, since the tree is
      what re-runs the app's scheduler) + 6 tests
- [x] `orchestration.rs`: `step_card_paths` and `workspaces_with_card`
- [x] `server.rs`: `watch_gavin_root` takes the `Arc` and arms the hook with a
      `Weak`; `rename_card_everywhere` split out of `follow_card_move`, which
      now pushes `OrchestrationChanged` to each affected workspace + 3 tests
- [x] `smokeChecklist.ts`: `arch-rail-heals`
- [x] Sweep: daemon suite per module (86 / 66 / 25 / 12), protocol + mcp,
      1293 vitest, clippy clean on the touched lines

No protocol change: `OrchestrationChanged` already existed and the app already
listens for it, so `PROTOCOL_VERSION` stays at 13.

Verified end to end against an isolated daemon (temp `$HOME`, own socket and
DBs, shared daemon untouched): arrange a step on `plans/ship.md`, `mv` the file
into `plans/done/` behind the daemon's back, then `WatchGavinRoot` — the first
message on the wire is `OrchestrationChanged` carrying `plans/done/ship.md`,
ahead of the tree.

Still open: the “Generic fixes” rail's two stale steps
(`clear-done-in-orchestration.md`, `git-commit-via-agent.md`) heal by
themselves the next time this workspace is opened by a daemon built from this
change — the shared daemon was deliberately not restarted.
