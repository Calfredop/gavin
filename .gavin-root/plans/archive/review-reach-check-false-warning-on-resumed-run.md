---
kind: task
title: A resumed compressed run is marked "not reaching Headroom" when the human pauses while typing their first message
status: Done
priority: medium
complexity: simple
---
Branch `feat/headroom` (headroom-06, c1de88b8). Work in `.gavin-worktrees/feat-headroom`.

## The defect

The reach check asks the daemon whether Headroom has seen a compressed run's requests at each working→idle (`onSessionStatus` in `app/src/lib/agents/headroomReachDriver.ts:60-76`, the rule in `reachCheckDue` at `app/src/lib/agents/headroomMark.ts:141-147`). It skips a terminal the human opened, because such a session "goes quiet … every time the human pauses mid-sentence" and "Headroom has seen nothing" means nothing there.

A reopened conversation (resume, review: `noteReopenedConversation` at `cardRunActions.ts:760` and `orchestrationState.ts:984`) has no prompt. After its history is painted it is in exactly that situation: waiting on a human. But only its FIRST quiet is passed over (`takeReopenedPaint`, `headroomMarkState.ts:83`). From the second working→idle on, it is treated as a finished turn.

A keystroke the agent's TUI echoes reads as `working`. Only focus and mouse reports get the repaint grace (`crates/daemon/src/server.rs:3409`), and a session is `idle` after 2 quiet seconds.

## The case that breaks it

1. A compressed card run is resumed (or a rail step's session reopened). The paint's working→idle is consumed, and nothing is asked.
2. The human starts typing a follow-up, then pauses 2 s or more before Enter. That is working→idle.
3. `reachCheckDue` returns true: it is a run, compressed, not reached, and not the reopened paint.
4. The daemon reads `/stats`. The new session id has no `per_project` entry, the pid is the same and the map is below 50, so it answers `unreached` (`crates/daemon/src/headroom/reach.rs`). The integration test `whether_a_compressed_session_reaches_headroom…` in `crates/daemon/tests/headroom_sessions.rs` shows an idle compressed session reads `unreached`.
5. The tab shows the warning RouteOff mark "not reaching Headroom" on a healthy session. It stays until the human's first real turn completes. If they never send one, it stays.

The existing test `"the first quiet of a reopened conversation, and only the first"` (`headroomReachDriver.test.ts:198`) asserts the ask on the second quiet. It encodes the bug.

## What to do

A reopened conversation should become eligible only once input has been SUBMITTED to it, not after any later quiet. Pick one of these:

- Keep the session in the reopened set until the app sends it a line ending in Enter. `write_input` already goes through the app; find the one seam every submit crosses.
- Keep it until the daemon has answered `reached` once.

Say which you chose in the commit body. Rewrite the test above to type-then-pause (expect no ask), then submit-then-turn-end (expect the ask). Keep the fresh-run path, a launch with a prompt, asking on its first quiet.

Run `cd app && npm test -- headroomReachDriver headroomMark` and `npm run check`.
