---
kind: plan
title: Unarchive — implementation
status: Done
---
Implementation checklist for the [Unarchive](./unarchive.md) task card.

The write side already exists (`executeUnarchive` in `archiveActions.ts`, the
daemon's `unarchive_card`, `FEATURE_MIN_VERSION.archive`). What is missing is
the *action* on the surfaces the human reaches an archived card through.

Surfaces audited (2026-08-24):
- Archive grid card — has a Restore icon button. ✔
- Board/grid card context menu (`cardMenu.ts`) — has "Restore from archive",
  but no test pins it. ✔ (locked below)
- **Card detail modal** — no archive/restore action at all. ✘
- **Plans tab tree context menu** (`planTreeMenu.ts`) — a file in the Archive
  group offers Open / Open beside terminal / Delete, and no way out. ✘

## Card detail modal

- [x] Archive / "Restore from archive" button in the modal's footer actions,
      chosen by `isArchivedCard(card.id)`
- [x] Gated by `featureBlockedReason($daemonCompat, "archive")` — the compat
      gate needs a consumer on every surface that can produce the payload
- [x] Closes the modal on success, like Delete does: the card has left the
      board (or the archive), so its path is no longer what the host holds
- [x] Cancelling the "this will close N agents" prompt leaves the modal open —
      `executeArchive` now answers `ARCHIVE_CANCELLED` (falsy, so every
      existing `if (err)` call site is untouched) instead of `null`

## Plans tab context menu

- [x] `TreeMenuItem.disabled` + `onRestoreFile` / `restoreBlocked` on
      `TreeMenuCallbacks`, threaded through `PlanTree`
- [x] `fileMenuItems` offers "Restore from archive" only for `group: "archive"`
- [x] `PlanExplorerHubView` resolves the archived `CardView` and runs
      `executeUnarchive`, refreshing the tree

## Verify

- [x] regression test: an archived card's context menu carries the restore
      entry (`cardMenu.test.ts`)
- [x] `planTreeMenu.test.ts` covers the archive-only entry
- [x] `npm test` (1316) + `npm run check` (0 errors) + `npm run build` green
- [x] four smoke items added under "Getting a card back out of the archive";
      their exact strings pre-flighted against the source
