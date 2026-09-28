---
title: TypeSafe experiments, round 2: whose change is this? (shared-tree attribution, commit links, conflict forecast)
status: Done
---
Round 1 (`plans/done/typesafe-experiments.md`) covered turn verdicts, failure causes and card complexity. This round probes a different weak spot: gavin attributes a change to a card by baseline sha alone, so in the shared checkout every concurrently running card "owns" every other session's edits (Run Changes, Review grouping, discard, commit via agent). Ground truth comes from git history: commits that carry or immediately precede their card. Experiments run from the session scratchpad; nothing here changes code.

- [x] Build the labelled set: vetted (card, commit) pairs from history, card text at its FIRST commit where one exists
- [x] E4 file -> card attribution: pooled diffs from 5 neighbouring cards, Choice over the cards + none; baselines: today's rule (everything belongs to everyone) and TF-IDF
- [x] E5 commit -> card link: commit message + file list against every linked card (86 + none, one request) rather than the 25 nearest -- the whole board fits
- [x] E6 conflict forecast: from two cards' text alone, will their work edit the same file? (AUC vs lexical similarity)
- [x] E7 settings search by meaning (added after a sweep of the app's text heuristics)
- [x] Measure latency + cost per call
- [x] Write up results and proposed changes

## Results

Model `jev-1.13.0` (pinned). Labelled set: 110 candidate (card, commit) pairs from history, each read against its commit before any run; 86 cards, 96 commits, 592 changed files with diffs survive. 78 of the 86 cards exist in git only in their finished state, which describes what landed -- so every number is given for the card's **title alone** (leak-free) and for its **plan** text (body cut at the first after-the-fact heading). Trust the title number. TF-IDF sees exactly the text the model sees.

**E4, file -> card** (five cards pooled as one dirty tree + three foreign changes; one Choice per changed file; wording frozen on the dev scenarios before test ran):

| | TypeSafe | TF-IDF | today |
|---|---|---|---|
| held-out test, title: right card | 133/156 (85%) | 113/156 (72%) | -- |
| held-out test, plan: right card | 142/156 (91%) | 130/156 (83%) | -- |
| five LOOK-ALIKE cards, title | 283/325 (87%) | 231/325 (71%) | -- |
| five look-alike cards, plan | 300/325 (92%) | 289/325 (89%) | -- |
| foreign change recognised as nobody's | 88-98% | cannot say | never |
| a card's change list that is its own files | 96-100% at confidence >= 0.75, holding 74-88% of them | 75-90% at the same coverage | 17% |

The usual miss is an owned shared file (`+page.svelte`, `lib.rs`, a test's imports) called `none` -- unattributed, which is today's answer. TF-IDF is closer than expected once a card carries a developed plan, and well behind on thin cards and on abstaining.

**E5, commit -> card** (one Choice over all 86 cards + none):

| | TypeSafe top-1 | top-3 | TF-IDF top-1 |
|---|---|---|---|
| card titles, full commit | 84/96 (88%) | 92/96 | 60/96 (63%) |
| card titles, commit subject only | 73/96 (76%) | 82/96 | 60/96 (63%) |
| card plans, full commit | 87/96 (91%) | 96/96 | 71/96 (74%) |

At confidence >= 0.75: 73 linked, 72 right. Not measured: commits that belong to no card.

**E7, settings search** (41 paraphrased queries labelled first; options are the existing `SECTIONS` keyword tables verbatim): right section 38/41, top-3 40/41; today's matcher shows the right section for 4 and an empty screen for 37, of which TypeSafe resolves 34. The queries were paraphrases on purpose, so this is how a synonym is treated, not how often one is typed.

**E6, conflict forecast** -- not promising. 300 card pairs, truth from file overlap of their commits: AUC 0.69 vs 0.63 for TF-IDF, and at a 0.5 threshold it misses 34 of 37 real collisions. Card text does not hold the answer. Dropped.

**Checked without an experiment**: slug-equality status matching (`planBoard.ts` `slugStatus`) looked brittle, but all 565 `status:` writes in this repo's history are exactly `Done`, `To Do` or `In Progress`. Nothing to fix.

**Cost and latency**: 2,450 calls, 4.78M input tokens, $0.20 in total. Per call: $0.00006-0.0001 (E4), $0.0001 (E5, whole board), $0.00004 (E7). Latency p50 0.30s, p95 0.68s, max 0.97s.

Method, known misses and the exact question sets: `docs/superpowers/specs/2026-09-21-typesafe-change-attribution-experiment.md`.

## Proposals

- [TypeSafe change attribution](../typesafe-change-attribution.md) -- the promising one: name the co-tenant card a changed file belongs to, as a hint on Run Changes, the discard prompt and Review grouping. Own opt-in switch, because it sends diff excerpts.
- [TypeSafe card links](../typesafe-commit-card-link.md) -- "Card: <title>" on a commit in the Git tab's history, and "closest by meaning" when board search comes back empty.
- [Settings search fallback](../typesafe-settings-search-fallback.md) -- a no-network synonym pass first, then a by-meaning fallback only when the keyword matcher finds nothing.

All three reuse the host command, key storage and toggle that `typesafe-turn-verdict.md` already specifies. That plumbing now has four consumers and is worth landing as its own first step.
