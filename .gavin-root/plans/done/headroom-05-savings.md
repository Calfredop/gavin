---
order: 7328
kind: task
title: Headroom 05: savings
status: Done
labels: ready-for-agent
parent: headroom.md
complexity: complex
---
Blocked by: headroom-02-compressed-launches-claude-code.md

Part of `headroom.md`. Read the spec (section "Savings") first.

## What to build

- **The snapshot.** When a card run ends, the daemon reads Headroom's `GET /stats` `per_project` entry for the session id and writes the tokens saved, plus the number of requests Headroom saw, onto the run's `card_runs` row (`kanban.rs`). Add the columns with an `ALTER TABLE … ADD COLUMN` beside the `CREATE TABLE`, swallowing the duplicate-column error, and prove it against a database built with the old schema (the `pre_v*` tests). Gavin's snapshots are the record; Headroom's map is not.
- **Run history.** Show "saved N tokens" next to the tokens spent (`runHistory.ts`'s token summary). A run that was not compressed shows nothing new.
- **The hub.** Add tokens saved in the current limit window to the economics and usage readout, summed from the snapshots whose runs fall inside the window.
- **Settings' lifetime total** comes from 01's status request. Nothing to add here beyond confirming it reads right.
- Tokens only; no dollar figures.

## Acceptance criteria

- [x] The snapshot writes the saved tokens and the request count for a compressed run and nothing for an uncompressed one (tested against a fake `/stats`)
- [x] The migration is proven against an old-schema database
- [x] The run history and window sums are computed in pure modules (tested)
- [x] `cargo test --workspace`, `npm test` and `npm run check` green
- [ ] Human test: after a real compressed card run, the run history shows the tokens it saved and the hub shows them in the current window
- [ ] Decision: Headroom 0.39.1 caps /stats per_project at 50 entries and evicts the smallest saver (savings_tracker.py DEFAULT_MAX_PROJECTS; the spec assumed the map only grows). I ran Headroom's own tracker with 50 older sessions in the map: two live sessions alternating 20 requests each (true 20 requests / 100k saved apiece) read back as absent and as 1 request / 5k. A solo session reads right. So once 50 sessions have been tagged, per-run savings undercount in a fleet. This card ships the per_project snapshot as written, and the source is one function (http.rs session_savings). Which source should savings use?
  Options: A) Keep per_project and accept the fleet undercount B) Run Headroom with --log-file under Gavin's state dir and tally each session from its JSONL (exact; one more pinned flag, a file to rotate) C) Keep per_project and ask upstream for a configurable cap or an eviction that spares active projects

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
