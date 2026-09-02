---
order: 1024
kind: task
title: [bug] a new board tab opens as a terminal
status: Done
priority: medium
---
Opening a context board into a page (the Kanban icon at the end of a pane's
tab bar → `openBoardInSplit`) renders the new tab as a `<TerminalPane>`, not a
`<BoardPane>`. It stays wrong until something else forces a re-render; a
`<BoardPane>` only appears later.

## What it was

`loadTabMaps` — the third whole-map writer, and the only one that reads across
a round trip. It copied Rust's `board_tabs`/`file_tabs` **over** the store's,
and `bootstrap()` is `+page.svelte`'s `onMount`, so under `tauri dev` it runs
again every time that component is recreated.

Measured, not reasoned (throwaway vite 6.4.3 + Svelte 5 server, a component
over a module-level store):

- editing the component's `<script>` → `onDestroy` then `onMount` re-run
  (`teardown()`, `bootstrap()`) while the store module is **not** re-executed —
  same store object, so the layout tree survives and the maps are re-seeded
  underneath it;
- editing the store module → a new store instance *and* a remount, i.e. tree
  and maps re-seeded together, which is consistent and harmless.

So any edit reaching `+page.svelte` without reaching `layoutState.ts` re-runs
the seed against a live store. And the store is AHEAD of Rust for the whole
flight of `openBoardInSplit`'s `set_board_tabs`: the entry lands in the store
first and is mirrored to Rust after. Re-seeding in that window drops the entry
while its id stays in the tree — and an id in a tree and in neither map IS a
terminal session as far as `Pane.svelte` is concerned. Hence the real xterm,
the `pty-output` listener, the `fit()` the daemon refuses, and a registry entry
nothing ever destroys (`destroyTerminal` is only reached from a close path).
It heals only when a later re-seed runs with Rust caught up — which is exactly
the reported "became `board-pane` after an edit that re-ran `bootstrap()`".

Both writers the report suspected are innocent: `pruneBoardTabs` and
`repairBoardTabs` each `get(layoutState)` and update with no `await` in
between, so neither can carry a stale snapshot across one. Candidate 1's
*shape* was right; the writer was the third one.

Reproduced deterministically in `layoutState.test.ts` (no UI): open a board
tab with `set_board_tabs` still in flight, run `bootstrap()`, and the entry is
gone while the id is still in the tree. Same for `openFileInSplit`.

## What changed

- **`loadTabMaps` merges instead of overwriting** (`app/src/lib/layoutState.ts`).
  Rust's copy goes *underneath* what the store already holds, so the seed still
  does its whole job — every restored board and file tab arrives — but can never
  un-classify a tab the app itself just opened. Correct in the bundled app too,
  not only under HMR.
- **`repairUnknownTabs`**, and a `$effect` in `Pane.svelte` that calls it for
  every tab this pane is about to render as a terminal. Before such a pane is
  left standing, Rust's copy of the classification is asked: an id Rust calls a
  board or file tab is put back in the map and the terminal built for it
  destroyed; an id Rust has nothing for really is a session and is recorded, so
  an ordinary terminal costs one question in the whole app run. Ids queue into
  one shared pass (and in-flight ids are not re-asked — `Pane`'s effect re-runs
  on every cwd/status push), so a page of ten terminals costs one pair of round
  trips, not ten. This is the guard the report asked for: it cannot produce a
  false negative the way gating the render on a guessed session-id set would,
  because it only ever *adds* a classification.
- Seven regression tests in `layoutState.test.ts`, and a smoke item
  (`board-tab-survives-hot-reload`).

`cargo test --workspace` untouched — no Rust changed. `npm test` 2005 passed,
`npm run check` 0 errors, `npm run build` clean.

## Also in the tree, and separable

The branch carries an earlier, unfinished change that parks `layoutState`'s
stores on `import.meta.hot.data` via `hotState` — the same treatment
`terminalRegistry` has. It is **not** this fix and this fix does not depend on
it; it is left in place rather than discarded. Two notes for whoever lands it:

- its `tabMapsSeeded` seed-once flag was removed — it leaked across tests in
  one file (two startup tests red) and it skips a re-seed that is genuinely
  worth doing. The merge above covers the same hazard properly;
- parking *widens* this bug rather than fixing it: with the store parked the
  tree survives **every** hot reload, so the seed runs against a live store
  every time instead of only on edits that reach `+page.svelte`. Safe now that
  the seed merges — but it wants its own verification pass in the app.
