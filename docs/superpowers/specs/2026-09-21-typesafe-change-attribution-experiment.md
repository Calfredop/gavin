# TypeSafe round 2: whose change is this? Experiment record and question sets

Date: 2026-09-21. Model: `jev-1.13.0` (TypeSafe System One), pinned.
Cards: `.gavin-root/plans/typesafe-experiments-round-2.md` (results) and the
three proposals it links. Round 1 is
`2026-09-21-typesafe-turn-verdict-experiment.md`; nothing here repeats it.

## The question

Gavin attributes a change to a card by baseline sha alone: Run Changes, the
Review tab's grouping and "Discard this run" all diff the launch checkout
against the commit the run started on. In a checkout several sessions share
-- which CLAUDE.md names as this repo's normal state -- that diff is every
session's edits at once, and `runChanges.ts` says so in the discard prompt:
"Anything another run put in this checkout goes with it". Round 2 asked
whether a TypeSafe judgment over one changed file can say which card it was
made for, reliably enough to act on, and tried three neighbouring judgments
that fall out of the same data.

## Ground truth

Git history labels itself here. 110 candidate (card, commit) pairs: a code
commit that also touches exactly one card file, or a card-only "file the X
card as done" commit and the code commit just before it. Every pair was read
(card text against commit message) **before any model run**; 12 cards were
dropped as wrong or undecidable and one re-pointed by hand. Left: **86 cards,
96 commits, 592 changed-file instances** with their diffs.

Card text is a leak risk. 78 of the 86 cards were only ever committed in their
finished state, and finished cards describe what landed. So every experiment
runs in two conditions: **title** (the title alone, written when the card was
created -- leak-free, and what a human's one-line card really is) and **plan**
(title plus the first 600 characters of body, cut at the first after-the-fact
heading such as "What landed" or "The fix", ticks cleared). Title is the
number to trust; plan is the ceiling a well-developed card reaches.

The lexical baseline everywhere is TF-IDF cosine over exactly the text the
model sees (camelCase-split tokens, idf over all 86 cards).

## E4 -- file -> card attribution (promising)

Scenario: five cards pooled as if they shared one dirty tree, up to five
changed files each (seeded sample), plus three **foreign** changes from cards
at least twelve positions away in history. One request per changed file:
state is `{change: {path, diff}}` (diff excerpt, <= 70 lines / 2600 chars),
one Choice over the five cards plus `none`. 17 scenarios, alternating
dev/test; wording frozen on dev (v1 beat a more elaborate v2) before test
ran. The **look-alike** condition replaces "five neighbours in time" with "a
card and the four cards most similar to it by TF-IDF" -- a stress test:
five sessions are rarely all in the same corner of the app at once.

| | TypeSafe | TF-IDF | today |
|---|---|---|---|
| held-out test, **title**: right card | 133/156 (85%) | 113/156 (72%) | -- |
| held-out test, plan: right card | 142/156 (91%) | 130/156 (83%) | -- |
| look-alike cards, **title** (17 scenarios) | 283/325 (87%) | 231/325 (71%) | -- |
| look-alike cards, plan | 300/325 (92%) | 289/325 (89%) | -- |
| foreign change recognised as nobody's (test, title / plan) | 21/24, 22/24 | cannot say | 0 |
| a card's change list that is really its own | see below | -- | 17% |

What matters for acting on it is the confident slice. Policy: show a file
under a card only when the Choice names that card at `confidence >= 0.75`.

| condition | files attributed | of those, right | TF-IDF at the same coverage |
|---|---|---|---|
| test, title | 118/180 | 116 (98%) | 81% |
| test, plan | 133/180 | 132 (99%) | 89% |
| look-alike, title | 268/376 | 257 (96%) | 75% |
| look-alike, plan | 286/376 | 285 (100%) | 90% |

So: today a card's change list in a five-card tree is 17% its own files. A
TypeSafe slice is 96-100% its own files and holds 74-88% of them; the rest
fall to "unattributed", which is today's answer. The lexical baseline is
closer than expected when cards carry a developed plan (they name files and
identifiers), and clearly behind on thin cards and in its ability to abstain.

Known misses:

- The common error is an owned file called `none` (7-12%): shared files
  whose excerpt is generic -- `+page.svelte`, `lib.rs`, a test file's
  imports. That is the safe direction for a discard warning and the unsafe
  one for nothing.
- Confident and wrong, title condition: a bug-fix card titled only
  "[bugs] Round of fixes" loses its wizard files to "Workspace init wizard".
  A title that says nothing cannot be matched; the plan condition fixes it.
- One owner per file instance is an assumption of the dataset. A file two
  live cards both edited needs the judgment per hunk; not measured.
- A per-card Noul ("was this file edited for this task?") was asked
  alongside and is worse as a decision rule than the Choice (68-88% vs
  86-93% over all changes). Keep the Choice.

~1.3k input tokens per file (title) or ~2.3k (plan): $0.00006-0.0001. A
30-file review costs a third of a cent. Latency p50 0.30s, p95 0.68s.

## E5 -- commit -> card link, and finding a card by meaning (promising)

One request per commit: state `{commit: {subject, body, files}}`, one Choice
over **all 86 cards** plus `none`. The commit message is a paraphrase of the
card written by someone who was not trying to match it, so this doubles as a
test of finding a card by meaning.

| | TypeSafe top-1 | top-3 | TF-IDF top-1 | top-3 |
|---|---|---|---|---|
| card **titles**, full commit | 84/96 (88%) | 92/96 | 60/96 (63%) | 74/96 |
| card titles, commit subject only | 73/96 (76%) | 82/96 | 60/96 (63%) | 70/96 |
| card plans (300 chars), full commit | 87/96 (91%) | 96/96 | 71/96 (74%) | 85/96 |

At `confidence >= 0.75` (titles, full commit) it links 73 of 96 commits and
72 are right. ~2.4k tokens, $0.0001, 0.3s for the whole board in one request;
8k tokens with plan text. Misses are sub-project cards with near-identical
titles ("SP2 of 3" / "SP3 of 3") and commits that fix a side effect the card
never mentions. Not measured: commits that belong to NO card (history has no
reliable label for that), so the `none` rate on real orphans is unknown.

## E7 -- settings search by meaning (promising, small)

41 plain-language queries written and labelled before any run ("text size",
"max agents", "connect from my phone", "what happens when I run out of
quota"). Options are the app-wide `SECTIONS` keyword tables from
`GlobalSettingsView.svelte`, **verbatim** -- nothing new is curated. Baseline
is today's `searchSettings` (every token a substring of the keyword table).

| | TypeSafe | today |
|---|---|---|
| right section, top-1 | 38/41 (93%) | 4/41 shown at all |
| right section in top-3 | 40/41 | -- |
| query shows an empty settings screen | -- | 37/41 |
| of today's empty screens, resolved | 34/37 | -- |
| at confidence >= 0.75 | 33 answered, 33 right | -- |

Caveat, stated plainly: the queries are paraphrases on purpose, so "today
4/41" measures how the matcher treats a synonym, not how often real users
type one. ~1k tokens, $0.00004, 0.3s.

## Tried and dropped

- **E6 conflict forecast.** From two cards' text, will their work edit the
  same file? 300 pairs, truth from the linked commits' file overlap. AUC
  0.69 (TypeSafe) vs 0.63 (TF-IDF); at a 0.5 threshold it flags 4 pairs and
  misses 34 of 37 real collisions. Card text does not contain the answer.
  The Orchestration tab's measured dirty-path conflicts stay the right tool.
- **Status -> column matching** (slug equality in `planBoard.ts`). Looked
  brittle on paper; history says otherwise: 565 `status:` writes across
  every card version, and all of them are exactly `Done`, `To Do` or
  `In Progress`. No experiment run -- there is nothing to fix.

## Cost and latency

2,450 calls, 4.78M input tokens, **$0.20** in total. Latency p50 0.30s, p95
0.68s, max 0.97s (round 1 measured 0.67s p50, from a different machine and
network, so the two are not comparable).

## Question sets

E4, one request per changed file. Option keys are neutral (`task_a`..) and
shuffled per scenario; each option's value is the card's `{title}` or
`{title, description}`.

```json
{
  "state": { "change": { "path": "<repo-relative path>", "diff": "<diff excerpt>" } },
  "questions": {
    "owner": {
      "type": "choice",
      "instructions": "`change` is one modified file from a git working tree in which several tasks are being worked on at the same time. Each option describes one of those tasks. Which task is this change part of?",
      "criteria": {
        "task_a": { "title": "...", "description": "..." },
        "task_b": { "title": "..." },
        "none": "The change is not part of any of these tasks."
      }
    }
  }
}
```

E5, one request per commit; one option per card on the board.

```json
{
  "state": { "commit": { "subject": "...", "body": "<= 500 chars", "files": ["<= 12 paths"] } },
  "questions": {
    "card": {
      "type": "choice",
      "instructions": "Each option is a card on a kanban board: a piece of planned work. `commit` is a git commit from the same project. Which card was this commit made for?",
      "criteria": { "card_01": "<card title>", "none": "The commit does not belong to any of these cards." }
    }
  }
}
```

E7, one request per query; one option per settings section.

```json
{
  "state": { "search_query": "max agents" },
  "questions": {
    "section": {
      "type": "choice",
      "instructions": "A user typed `search_query` into the search box of the settings screen of a desktop app that runs AI coding agents in terminals. Each option is one settings section, described by the settings it holds. Which section is the user looking for?",
      "criteria": {
        "memory-wall": { "settings_in_this_section": ["Memory wall", "memory", "RAM", "pressure", "ceiling", "agents running at once"] },
        "none": "No section holds a setting for this."
      }
    }
  }
}
```

## Policy (code, not model)

- A file is attributed to a card only at `owner.confidence >= 0.75`; below
  that, and on `none`, it stays unattributed -- which is today's answer.
- A commit is linked to a card only at `confidence >= 0.75`; otherwise offer
  the top three and let the human pick.
- The settings fallback runs only when today's matcher returns nothing, and
  only shows a section at `confidence >= 0.5` (95% right on the query set).
- Any error, timeout or missing key -> today's behaviour, everywhere.
- Thresholds were measured on `jev-1.13.0`; pin it, not `jev-latest`.
