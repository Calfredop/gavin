---
complexity: complex
order: 9216
kind: plan
title: [feat] activity calendar
status: In Progress
---
App level 
WS level

An activity calendar: what happened, drawn over time, zoomable year › month › day › hour.

**Activity** = agent runs (card runs + standalone tool runs; rail steps are card runs, counted once),
commits (`git log --all`, deduped by sha, every author), pushes (reflog of `refs/remotes/*`, `update by push`),
and files touched (distinct files changed by those commits, per bucket). Read from what already exists;
nothing new is recorded except the query that reads runs by time.

Settled in development (do not re-litigate):
- Timestamps travel as UTC unix seconds; bucketing and display use the machine's time zone. A run counts at
  `started_at`, a commit at its author date. Empty days/hours draw as empty cells.
- Zoom: Year = 53×7 day heatmap of the last 12 months · Month = calendar grid, a cell per day · Day = 24 hour
  columns · Hour = the event list in time order. Click a cell to zoom in; breadcrumb (`2026 › Oct › 21 › 14:00`)
  zooms out; ←/→ step the period at the same level. Day and Hour show the event list.
- One intensity per cell (quantile levels) over the kinds chosen in a **multi-pick dropdown** (Runs · Commits ·
  Pushes · Files, all on); the tooltip breaks a cell down by kind (and by workspace at app level).
- Leaf rows: a card run opens its card (the inbox's jump); a tool run opens the Tools tab; a commit expands in
  place to its changed files; a push shows remote, ref and the range it moved. Nothing navigates into Git history.
- Fetched once on mount (12 months, one call per source per workspace), refetched when the view becomes visible
  again or on a refresh button; zooming re-buckets locally.
- App level: a section on the app hub, summed over every workspace — ssh ones via their host, folderless ones
  runs-only, an unreachable one skipped with "N workspaces unavailable".
- WS level, desktop: a **widget on the workspace hub's Home** — no new hub tab.
- Companion: app level is a block on the workspace list; WS level is a new **Activity** phone surface. The phone
  opens at Month and zooms out to a Year scaled to the width.
- Out of scope: tokens/cost, Done-card history, recording rail-step or push history anew, a Git-history jump.

**Where it is (2026-10-21):** on main (fast-forwarded to `25659720`), not pushed. Protocol v78 (`ActivityRuns`), so the human tests need the app rebuilt and the daemon restarted; the ssh check also needs a v78 daemon on the host.

- [x] Runs by time range — `activity-calendar-runs.md`
- [x] Commits, pushes and files — `activity-calendar-git.md` (independent of the one above; run them in parallel)
- [x] Calendar core and desktop surfaces — `activity-calendar-desktop.md` (needs both above)
- [x] Companion — `activity-calendar-companion.md` (needs the desktop one)
- [ ] Human test: In the running app, open the app hub and a workspace's Home: the activity calendar shows the last 12 months, the dropdown re-colours it by kind, clicking a day → hour zooms in, the breadcrumb and ←/→ move back and across, and a card-run row opens its card. Check an ssh workspace contributes at app level.
- [ ] Human test: On a paired phone, the workspace list's Activity block and a workspace's Activity surface open at Month, zoom out to a Year that fits the width, and zoom in to an hour's list.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
