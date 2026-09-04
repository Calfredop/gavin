---
kind: task
title: [feat] Changes chip on every session tab
parent: feat-file-explorer-integration.md
---
Widen the per-tab Changes chip so every session tab with a checkout has one, not only a tab bound to a card.

Today `runChangesFor(sessionId)` in `app/src/lib/Pane.svelte` returns null unless the session is linked to a card **and** that card's binding carries a `baseSha` (`CardSession.base_sha`, protocol v26). A plain terminal tab, and any agent session not launched from a card, gets no chip at all.

The rule, already decided:

- When the binding **has** a run baseline, keep using it. It is the precise answer and it survives the agent committing mid-run. The modal header reads `since this run started (a3f19c2)`.
- When there is none — no card, or no recorded sha — fall back to the working tree versus HEAD in the session's **launch** directory (never `cwd`, which drifts with the session's OSC 7 reports), and say so: `uncommitted in this checkout`. Never present the fallback as if it were a run baseline.
- A session whose launch directory is not a git repository still gets **no** chip. There is nothing to show, and a chip is a glyph with no room to explain itself.

Do not add a protocol field for this. The fallback answers the question with `git_status` / `git_diff`, which already exist, so `PROTOCOL_VERSION` stays where it is and no compat gate is needed.

Keep the chip's no-fetch property: it must stay a glyph that costs nothing to render. The existing comment in `Pane.svelte` says why — a count on the chip would be a `git diff` per tab per render across every pane in the window.

Put the baseline choice in `runChanges.ts` as a third `RunBaseline` variant (not a nullable sha), with unit tests for each of the three outcomes, and let `runChangesState.ts` and `RunChangesModal.svelte` read it. `Pane.svelte` stays a thin caller.

Verify: `cd app && npm test && npm run check && npm run build`.
