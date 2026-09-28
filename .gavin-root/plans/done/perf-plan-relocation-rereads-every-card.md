---
order: 23552
kind: task
title: "[perf] Moving a plan card re-reads every card"
labels: bug
parent: perf-main-thread-command-audit.md
status: Done
---
`set_plan_frontmatter_field` (app/src-tauri/src/session.rs:5944),
`archive_card` (:5968) and `unarchive_card` (:5989) relocate a `kind: plan`
card into or out of `done/` / `archive/` with its children, and finding the
children reads and parses EVERY card in the root.

## Evidence (2026-09-26)

- `move_card_with_children` (crates/daemon/src/gavin.rs:1264-1279) parses
  every card to find `parent:` links: 40–300 ms for 428–477 cards (~1 MB),
  warm/cold, on the daemon's request thread while the app's main thread
  waits. Then it re-keys both databases and pushes a tree, which triggers a
  `get_board` (see that card).
- Callers loop it: planDrop.ts:32-35 and :193-196 (per sibling),
  cardCompletion.ts:184, archiveActions.ts:107/:133, and the rail scheduler
  (orchestrationState.ts:1614, :1775, :2610) — unattended.

## Fix

Find children from the watcher's last parsed tree (it already knows every
card's `parent:`), or an index maintained by the watcher, instead of
re-reading every file; fall back to a scan only when the tree is stale.
Batch the per-sibling loops into one request where the UI moves several
cards at once.

## Verify

A gavin.rs test that relocating a plan among N cards reads O(children)
files, not N. Time a Done-drag of a plan with children before/after.

## Work

- [x] Measure the baseline: a Done move of a plan among this workspace's cards (466 cards, warm cache: debug median 31 ms / max 104 ms; release 14.5 ms / 75 ms)
- [x] The watcher keeps a card index from each scan (`parent:` links + the time it can vouch for)
- [x] Relocation finds children from the index; reads only cards changed since that scan or unknown to it
- [x] The daemon hands the owning watcher's index to set-field / archive / unarchive
- [x] gavin.rs tests: O(children) reads; a card edited or created after the scan is still honoured
- [x] Done-drag and nest-drop write `order:` to the path the status write moved the card to
- [x] Measure after (same 466 cards: debug 30 -> 3.1 ms median, release 13.6 -> 2.7 ms)
- [ ] Human test: On the board, drag a To Do card into Done, and nest a task into a plan already in Done: no "Couldn't update <file>" strip appears, and each card lands where it was dropped

## Outcome (2026-09-26, uncommitted on perf/main-thread-commands)

- **Index.** Every watcher scan now leaves a `CardIndex` (card path ->
  the plan it nests in). A move takes the index's word for any card
  whose later of mtime/ctime is older than that scan's start minus 2 s,
  and reads the rest, so a stale index costs reads and never a wrong
  move. `CardIndex` in gavin.rs; `card_index_for` in server.rs picks the
  watcher whose scan listed the card. What's left per move is one stat
  per card plus the renames.
- **Batching: not done.** The per-sibling loops in planDrop.ts write
  `order:` or move tasks, never plans, so they never paid for the full
  read. The loops that move several plans (bulk archive, the rail's
  filing loop) do per-card work in between on purpose: a confirmation
  per plan, and each card's sessions closed after its own move. Each
  call is now O(children), and a batched request would need a protocol
  bump.
- **Found along the way.** A drag that filed a card into `done/` then
  wrote `order:` to the card's old path, which the daemon refuses
  ("couldn't resolve"), so the board showed "Couldn't update <file>".
  Nesting a task into a plan under `done/` did the same. planDrop.ts now
  sends the order write to the path the status write returned.
- The daemon half takes effect only after a daemon rebuild and restart.
