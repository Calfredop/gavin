---
kind: task
title: [bug] page’s kanban board
status: Done
---
# [bug] page’s kanban board

When going to a page's kanban board via its tab, it shows nothing and break the view of all other terminal tabs in that page, even after app restart. When closing all tabs the app crashed with the "Daemon restart" error. When closing the page I get the same error.

## What it was

One fault behind all three symptoms. `boardTabsById`/`fileTabsById` are the only
thing that tells `Pane.svelte` a tab is a board (or a file) rather than a
terminal, so a tab id sitting in a layout tree with no entry in those maps
renders as a `<TerminalPane>` for an id the daemon has never heard of. That pane
mounts, calls `fit()`, and asks the daemon to resize it. The daemon answers
`unknown session: <id>` on the **streaming** connection, the Rust relay turns any
such reply into a `daemon-error`, and `setError` puts the whole window behind
"Couldn't connect to the daemon — Restart daemon & retry". `TerminalPane`'s own
`.catch` never sees it: the error arrives as a push, not as the invoke's
rejection.

Two ways to reach that state:

1. **Closing.** `endTabs` pruned the maps *before* the caller removed the tab
   from the tree, so every close (tab, pane, page, workspace) rendered one frame
   with the tab orphaned. That is the "Daemon restart" crash on closing a tab or
   a page — and it hit file tabs identically.
2. **Startup.** `get_file_tabs`/`get_board_tabs` were one-shot and
   `.catch(() => {})`. Those Rust states are `manage`d at the very end of
   `session::bootstrap`, so an invoke landing first rejects with "state not
   managed" — the same case `pollForStartupState` already spins on — and the maps
   stayed empty for the rest of the run. Nothing gated `status: "ready"` on them
   either, so a restored board tab could render before its map arrived. That is
   the board showing nothing and taking the page's terminals with it, every
   restart.

Reproduced end to end in an isolated app instance (own `$HOME`, own daemon):
before, closing a board tab left `status: "error"`, `errorMessage: "unknown
session: …"` and an empty document; after, every close leaves `status: "ready"`
with the sibling terminals still rendered.

## What changed (`app/src/lib/layoutState.ts`)

- `endTabs` no longer prunes. It returns the non-session tabs it ended
  (`ClosedTabs`), and each of `closeSession`/`closePane`/`closePage`/
  `closeWorkspace` updates the tree first, then calls `pruneClosedTabs`.
- `loadTabMaps` replaces the two best-effort one-shots: it retries the
  "state not managed" window, and both ready paths (`workspaces-ready` and
  `pollForStartupState`) await it before `status` may leave `"connecting"`.
- Seven regression tests in `layoutState.test.ts`, all failing on the previous
  code: five assert on every state the store *passes through* during a close
  (the settled result was always right — only the order was wrong), two cover
  the startup gate and the retry.

## Follow-up, also fixed

`Response::Error` on the streaming connection is no longer reported as a lost
daemon connection. That connection carries `Attach`/`WriteInput`/`ResizeSession`,
so a rejection means *one* refused request, not a dead socket — relaying it as
`daemon-error` is what let a stray resize blank the window. It now travels on
`daemon-request-error` into its own store and renders as a dismissible strip
(`DaemonRequestErrorBanner`) over a still-working app; `daemon-error` keeps only
its real meaning, the one `report_disconnect` and `bootstrap` give it.

Same commit: a frontend reload no longer loses every session's cwd, status and
restored badge. Those reach the app only as pushes, and their baseline only in
reply to `Attach` — which runs once per app *process*. So a reloaded frontend came
up blank on all three and could not refill them until the shell's next OSC 7,
which is why a terminal's tab lost its "open this context's board" button after
every dev-server reload. `get_session_baselines` reads them back from the daemon's
registry at bootstrap, never overwriting a push that has already landed.
