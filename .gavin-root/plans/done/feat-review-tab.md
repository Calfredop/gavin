---
order: 1024
title: [feat] Review tab
status: Done
---
A new Review tab in the workspace hub. Here all "Done" (or other 'marked as review' cols) tasks and plan should be placed in a left side, collapsible, list of cards, grouped by 'touched files'. Selecting a card should bring a three cols ui. 
- first col: terminal session of the selected card, or if not preset a 'start agent session' cta that starts the session with current card context (opens a session in the agent page too)
- second col: list of toched files
- third col: file editor with diff/edit mode switcher

Additional feats:

- search in top of cards list
- filter to show archived cards (default to off)

## Decisions

Settled with the owner before any code:

- **Grouping** — clusters of cards that share at least one touched file.
  Every card appears exactly once; the group header names the shared
  files ("orchestration.ts, git.ts +3"). Cards with no recorded baseline
  fall into one "no files recorded" group rather than being hidden.
- **Which columns feed the tab** — the done column by default, plus a
  per-workspace picker over the board's other columns. Stored in
  localStorage like the other per-human view prefs (hubTabPrefs,
  sidebarPrefs): no daemon request, so no protocol bump and no compat gate.
- **The CTA's status write** — none. A card launched from the Review tab
  stays in the column it is in; a review that files its own subject out
  of the review list is a surface that empties as you use it.

## Touched files: where they come from

`git diff --name-status -M <baseSha>` in the run's launch cwd — the same
question `RunChangesModal` already asks, through the same
`git_run_changes` command. The baseline is the card's binding
(`CardSession.baseSha`), which the daemon re-keys into `plans/done/` with
the card, so a finished card still has one. No baseline is reported as
"no files recorded", never as "no files" — the distinction the whole
runChanges module is built around.

## Checklist

- [x] `reviewBoard.ts` + tests — the pure half: which columns feed the tab, the candidate cards, the union-find clustering over touched files, group labels, and the search filter
- [x] `reviewPrefs.ts` + tests — per-workspace localStorage: review columns, show-archived, list collapsed, selected card
- [x] `reviewState.ts` + tests — the store: touched files per candidate (bounded concurrency, demand-loaded, Refresh), selection, and the selected file's diff
- [x] Review launch + tests — a `"review"` mode in `launchCard` that writes no status, keeps the binding's `baseSha` and `conversationId`, and reopens the conversation when the profile can
- [x] `ReviewHubView.svelte` + the two panes it mounts — collapsible card list, terminal column, touched-files column, diff/edit file column
- [x] Register the tab in `hubViewMeta.ts` and `workspaceViews.ts`, and a surfaces guard test
- [x] Suites green: `cargo test --workspace`, `npm test`, `npm run check`, `npm run build`
- [x] Static pre-flight — grep the exact strings the new surfaces rely on against the committed source

## What landed

Commit `8fb137c` on `feat/review-tab`, 16 files. Four pure modules with
tests (`reviewBoard`, `reviewPrefs`, `reviewState`, plus a `"review"`
launch mode in `cardRunActions`), four components, and a
`reviewSurfaces` guard test over the strings that hold them together.
No protocol bump and no compat gate: everything is app-side, over the
existing `git_run_changes` command and localStorage.

Suites: `cargo test --workspace`, `npm test` (4333), `npm run check`,
`npm run build` — all green. The one daemon failure under full-suite
cargo parallelism
(`server::tests::typing_after_a_failure_means_the_next_turn_is_judged_on_its_own`)
passes per-crate and touches no file this card changed.

Left for the owner: the rendered pass in the running app. The three
things a suite cannot reach are the terminal borrowed into the first
column (it is the card's own xterm, handed back when you return to the
terminal view), the three-column grid under WKWebView, and what the
clusters actually look like on a real board.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
