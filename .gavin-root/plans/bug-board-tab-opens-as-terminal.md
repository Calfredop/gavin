---
order: 1024
kind: task
title: [bug] a new board tab opens as a terminal
status: To Do
priority: medium
---
Opening a context board into a page (the Kanban icon at the end of a pane's
tab bar → `openBoardInSplit`) renders the new tab as a `<TerminalPane>`, not a
`<BoardPane>`. It stays wrong until something else forces a re-render; a
`<BoardPane>` only appears later.

This is a third route into the family the archived card
`plans/archive/bug-page-s-kanban-board.md` fixed two routes of: a tab id in the
layout tree with no entry in `boardTabsById`/`fileTabsById` IS a terminal as far
as `Pane.svelte` is concerned. The cost is the same as before — a real xterm and
a `pty-output` listener are created for an id the daemon never had, `fit()` asks
the daemon to resize it, and the refusal shows as the daemon-request-error strip.
The registry entry is never destroyed, because nothing ever calls
`destroyTerminal` for it.

## Evidence (isolated instance, own $HOME, own daemon, rooted at this repo)

- `openBoardInSplit` ran at T+0. `registry:miss` for the new tab id 30 ms later,
  then `TerminalPane.onMount` for it — so the `{#if boardTab(id)}` arm was false.
- Still a `TerminalPane` after a hot-reload remount ~100 s later.
- It became `board-pane` only after an edit that re-ran `bootstrap()` (and with
  it `loadTabMaps()`), which refills `boardTabsById` from the Rust side — where
  `setBoardTabs` had persisted the entry correctly all along.

So the daemon-side map was right from the start and the *store's* copy was not:
`openBoardInSplit`'s own `layoutState.update` seems not to stick.

## Two candidates, neither confirmed

1. **A stale-snapshot writer clobbers it.** `followRenamedContext` and
   `pruneBoardTabs` both write a whole `boardTabsById` built from a map captured
   before their `await`. The repro workspace was rooted at this repo while other
   agents were writing `.gavin-root/`, so tree rescans were firing constantly —
   exactly when `followRenamedContext` runs. Same shape as the
   `removedWorkspaces` carry-through trap.
2. **A render ordering problem** inside the single `layoutState.update` that adds
   the tab to the tree and the entry to the map together.

Start by proving which: log `boardTabsById` immediately after
`openBoardInSplit`'s update and again one tick later. (1) is testable in
`layoutState.test.ts` without any UI.

Whatever the cause, `Pane.svelte` should not be able to mint a terminal for a
tab id that no one ever created a session for — consider a guard there too, so
this family stops costing a bogus PTY request each time.
