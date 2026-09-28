---
order: 7328
kind: task
title: Headroom 05: savings
status: To Do
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

- [ ] The snapshot writes the saved tokens and the request count for a compressed run and nothing for an uncompressed one (tested against a fake `/stats`)
- [ ] The migration is proven against an old-schema database
- [ ] The run history and window sums are computed in pure modules (tested)
- [ ] `cargo test --workspace`, `npm test` and `npm run check` green
- [ ] Human test: after a real compressed card run, the run history shows the tokens it saved and the hub shows them in the current window

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
