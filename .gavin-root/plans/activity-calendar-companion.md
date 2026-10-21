---
kind: task
title: Activity calendar: Companion
parent: tbd-feat-activity-calendar.md
complexity: moderate
---
Bring the activity calendar to the Companion (parent card `tbd-feat-activity-calendar.md` — read its "Settled" list first). The desktop sibling `activity-calendar-desktop.md` must have landed: reuse its pure module and component from `app/src/lib/activity/`; do not fork them.

- App level: an Activity block on the phone's workspace list.
- WS level: a new `activity` surface in `app/companion/src/companion/state/viewState.ts` `SURFACES`, labelled "Activity".
- On the phone the calendar opens at Month and zooms out to a Year scaled to the width.
- Demo Workstation answers for `activity_runs` and `git_activity` with a believable year of data (`app/companion/src/companion/demo/`). If either becomes a desk-bootstrap read, add it to the seam test's expected list.
- Read `app/companion/README.md` before starting.

Run `cd app && npm run companion:test && npm run companion:check && npm run companion:build`.
