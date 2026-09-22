---
title: TypeSafe card links: name the card a commit served, and find a card by meaning
status: Done
priority: low
complexity: moderate
---
Nothing ties a commit to the card it served except the human's memory and a "file the X card as done" commit beside it, and CLAUDE.md already warns that `git log` cannot answer "is this feature in?". The board's search (`app/src/lib/core/search.ts`) is token-AND substring, so a card is only findable by words that are literally on it.

Measured in `plans/done/typesafe-experiments-round-2.md` on 96 commits whose card is known from history: ONE TypeSafe (`jev-1.13.0`) Choice over all 86 card TITLES + `none`, state `{commit: {subject, body, files}}`, names the right card for 88% of commits (TF-IDF: 63%), top-3 96%. At `confidence >= 0.75` it links 73 of 96 and 72 are right. ~2.4k tokens, $0.0001, 0.3s for the whole board in one request. A commit message is a paraphrase of its card written by someone not trying to match it, so the same request shape is a find-by-meaning for the board. Not measured: commits that belong to no card -- the `none` rate on real orphans is unknown, which is why nothing below writes anything by itself.

Design rules:
- **Opt-in, behind the TypeSafe toggle** from `typesafe-turn-verdict.md`. What leaves the machine: commit messages, changed file paths, card titles. No source code.
- **Suggest, never record.** A link is shown, not stored; nothing is written to a card or a commit. `confidence >= 0.75` shows one card, below that the top three, `none` shows nothing.
- **Titles only, one request.** A Choice holds 255 options; send the open board plus `plans/done/`, never `plans/archive/` (off the board means off the list). Over 254 cards, take the most recently modified.
- The question is the E5 set in the experiment record, verbatim. Pin `jev-1.13.0`.

- [x] Read `docs/superpowers/specs/2026-09-21-typesafe-change-attribution-experiment.md` (E5) -- known misses: sibling sub-project cards with near-identical titles, commits fixing a side effect the card never mentions
- [x] Depends on the host command and key plumbing in `typesafe-turn-verdict.md`; reuse it
- [x] Pure module `app/src/lib/git/commitCardLink.ts`: builds the request from a `CommitDetail` and the board's cards, applies the policy, returns `{card, confidence} | {candidates: [3]} | null`. Unit tests from recorded responses
- [x] Consumer 1, Git tab history: the commit detail pane shows "Card: <title>" (or "Possibly: a, b, c"), clicking opens the card. Asked on selecting a commit, never for the whole log
- [x] Consumer 2, board search: when `cardMatches` leaves the board EMPTY, offer "Closest by meaning" -- the same Choice with state `{search_query}` -- as up to three cards under the empty state. Lexical search stays the first and only answer whenever it finds anything
- [x] Checks: `cd app && npm test && npm run check && npm run build`; static pre-flight of the new strings; the rendered pass is the owner's
