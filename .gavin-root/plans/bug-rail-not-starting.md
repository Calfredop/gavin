---
order: 6144
kind: task
title: [bug] rail not starting
status: In Progress
---
Why is the tools only rail in “Grimoria” workspace not starting when I press run button on its header?

## What was happening

Nothing was wrong with the rail. The press armed it, and then the agent
**pause cycle** held every launch — silently.

`executeActions` gates a rail's `launch` on two walls: `mayStartWork`
(the workspace's pause cycle and its agent's usage limits) and
`mayLaunch` (the memory wall). Either one skips the launch with no write
and no row. But every badge in the app that explains a held launch read
`launchGateVerdict`, i.e. the memory wall **alone** — so a rail held by
the pause armed, started nothing, and had nothing on screen to say why.

Grimoria's cycle is 300 minutes with a 10-minute tail pause. The rail's
run row was last written at 12:59 on 2026-09-11, inside the pause window
12:54:41–13:04:41. The row is `paused` with no run row on its first step,
which is the shape of arming it and then pressing the same button again
when nothing happened.

Tools-only was a coincidence — a card step would have been held the same
way. The rail was simply the only one in that workspace.

## The fix

One hold vocabulary for both walls, and every surface reads both.

- `launchGate.startVerdict(pause, gate)` — the pause first, then the
  wall, the order `startBlockedReason` already chose.
- `HoldReason` gains `pause`; `holdLabel`/`holdDetail` and the
  `agent/paused` indicator give it its two words and its glyph.
- `launchQueue.startHoldFor` — the per-workspace verdict as a store the
  templates call per rail, per step, per card.
- The rail header badge, its step chips, the board card and the card
  detail modal now draw from that instead of the wall alone; the rail's
  Start button names the hold in its tooltip before the press, since the
  badge can only appear after it.

`launchWallSurfaces.test.ts` guards it: a hold surface must read
`$startHoldFor(workspaceId)` and must not read `$launchGateVerdict`.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
