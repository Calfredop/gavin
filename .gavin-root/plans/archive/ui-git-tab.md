---
complexity: moderate
order: 7168
kind: plan
title: [ui] git tab
status: Done
---
In the Git tab, let the human resize the space given to the commit message/description against the diffs, on both surfaces where they share a column:

- **Changes view**: the commit box (Summary/Description, `app/src/lib/git/GitCommitBox.svelte`) at the bottom of the Changes column, against the Unstaged/Staged lists above it (`GitChanges.svelte`).
- **Commits view**: a selected commit's detail (`GitCommitDetail.svelte`), split as message | file list | diff, with a divider between each.

Settled in development (2026-10-27):

- **Copy the existing Unstaged/Staged divider in `GitChanges.svelte` exactly:**
  - Store a share via `$lib/panes/splitShare.ts` (never pixels) and apply it as flex-grow.
  - Use window-level pointer listeners with the `buttons === 0` bail-out (WKWebView drops pointerup).
  - Use a 4px `row-resize` bar with a tooltip.
  - Double-click resets the split, and a click that never moved writes nothing.
- **Save each split per workspace** in `GitViewPrefs` (`app/src/lib/core/workspace.ts`), next to `unstagedShare`, through `setGitViewPrefs`, with a doc comment like that field has.
  - With no saved value, the layout is today's: the commit box sized to its content, the message at most 30%, the file list at most 35%. Nothing moves until someone drags.
  - The daemon never reads `gitView`, so there's no protocol bump.
- **The commit-box divider lives in `GitChanges.svelte`, not in `GitCommitBox.svelte`.** The Companion's `PhoneGitChanges.svelte` mounts the same box and must stay as it is.
  - When the desktop gives the box height, the Description field grows to fill it; Summary, the Amend/Commit row and the author line stay fixed.
  - Drop the field's own `resize: vertical` grip on the desktop, so there aren't two ways to size it.
- **Out of scope:** the session Diff tab (card `ui-diff-tab.md`, already In Progress), the Compare view, and the phone's layout.
- **Assumed, not asked:** the phone gets no divider; double-clicking the commit-box bar returns it to today's layout, sized to its content, rather than a 50/50 split.

- [x] **Sizing rules with unit tests.** Write the size limits as plain functions with tests, by extending `app/src/lib/git/gitChangesSplit.ts` or adding a sibling `gitCommitSplit.ts`. Two sets of rules: the commit box's share and minimum height, and the commit detail's two shares with a minimum for each block, so none of the three can be dragged below a readable height.
- [x] **Changes view.** Add a divider between the lists block and the commit box in `GitChanges.svelte`, saved in a new `GitViewPrefs` field. The Description field fills whatever height the box gets, and the phone's commit box is unchanged.
- [x] **Commits view.** Add two dividers in `GitCommitDetail.svelte` (message | files | diff), each saved in `GitViewPrefs`. With nothing saved, the 30%/35% caps still apply. The "Card:"/"Possibly:" link row stays fixed between message and files.
- [x] **Checks.** Run `cd app && npm test && npm run check`, then `npm run companion:test && npm run companion:check`, since the Companion mounts `GitCommitBox`.
- [ ] Human test: Changes view — drag the bar above the commit box up and down: the Description field grows and shrinks, and both lists keep at least a row; the split survives switching tabs and restarting the app; double-click restores the original layout. Commits view — select a commit and drag both bars (message | files, files | diff) the same way. Phone — the Git changes screen's commit box looks as it did before.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
