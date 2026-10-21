---
kind: task
title: Activity calendar: core and desktop surfaces
parent: tbd-feat-activity-calendar.md
complexity: complex
---
Build the activity calendar exactly as the parent card `tbd-feat-activity-calendar.md` specifies — read its "Settled" list first; it is not up for re-deciding. It needs `activity_runs` (sibling `activity-calendar-runs.md`) and `git_activity` (sibling `activity-calendar-git.md`) to have landed; read their code for the exact shapes.

- A pure, unit-tested module under `app/src/lib/activity/`: the event model built from both sources; bucketing in the machine's local time at Year / Month / Day / Hour; quantile intensity levels; the kind filter (Runs · Commits · Pushes · Files); distinct files per bucket; zoom-in, breadcrumb and ←/→ navigation; the leaf event list.
- A loader that fans out per workspace for the app level, notes unreachable workspaces ("N workspaces unavailable") instead of failing, refetches when the view becomes visible again or on a refresh button, and draws a "needs a newer daemon" state through `featureBlockedReason` with `FEATURE_MIN_VERSION.activityCalendar`.
- Run titles from the loaded boards, falling back to the card file's basename (runs of archived cards included). A card-run row opens its card the way the attention inbox does; a tool run opens the Tools tab.
- A thin `ActivityCalendar.svelte` over it, no charting library (hand-rolled SVG or CSS grid), kind filter as a multi-pick dropdown. Mount it as a section of `AppHubView` and as a widget on `HomeHubView`. No new hub tab.
- CLAUDE.md's WKWebView rules apply; status colours only through `ui/indicators.ts`.

Run `cd app && npm test && npm run check && npm run build`. The Companion is the next sibling — keep the component usable at phone width (opening level as a prop) but do not edit `app/companion`.
