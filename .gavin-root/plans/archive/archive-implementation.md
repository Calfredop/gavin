---
kind: plan
title: Archive — implementation
status: Done
---
Implementation checklist for the [Archive](./archive.md) task card.

Decisions taken with the human (2026-08-24):
- Archiving is an EXPLICIT action, not a side effect of Done. Archived cards
  move to a new `plans/archive/` folder and leave the board entirely;
  `plans/done/` keeps its current meaning (Done, still on the board).
- The archive grid is ordered by file mtime, newest first — which needs a new
  `modifiedAt` field on the wire, hence a protocol bump.

## Daemon + protocol

- [x] `PlanFileInfo.modified_at` (unix secs, `serde(default)`) filled from the
      file's mtime; TS mirror in `gavin.ts`
- [x] `ARCHIVE_DIR` + `archive_card` / `unarchive_card` in `gavin.rs`, children
      following their parent like the Done move does
- [x] `relocate_for_status` leaves a card that already sits in `plans/archive/`
      alone, so a status edit can never silently un-archive it
- [x] `Request::ArchiveCard` / `UnarchiveCard` + `Response::CardMoved`, bumped
      to `PROTOCOL_VERSION` 13 with `min_version_for` and the pinned band test
- [x] Server dispatch + a manager method that re-keys card sessions and rail
      steps onto the new path (mirrors `set_plan_field`)
- [x] Tauri commands, `backend.ts` wrappers, `FEATURE_MIN_VERSION.archive`

## Board

- [x] `mergePlanCards` routes archived cards into an `archived` bucket instead
      of a column; nesting still resolves first
- [x] `archive.ts`: chronological projection + search, `CardView.modifiedAt`
- [x] `ArchiveGrid.svelte` — a grid of `BoardCard`s, newest first
- [x] Archive toggle beside the kanban search input; the search box filters the
      grid while it is open
- [x] "Archive" / "Restore from archive" on the card menu, "Archive all" on the
      Done column header

## Plans tab

- [x] `archive` becomes a fourth explorer group beside Plans / Docs / Specs
- [x] Status and rail facets still treat archived cards as plans

## Verify

- [x] `cargo test` green
- [x] `npm test` + `npm run check` green
