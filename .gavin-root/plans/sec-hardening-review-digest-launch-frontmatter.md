---
kind: task
title: "[sec-hardening] The first-run review digest leaves out a card's agent:, model: and effort:, which change the launch line"
parent: sec-hardening-2026-10-15.md
priority: low
complexity: moderate
labels: security, ready-for-agent
---
Part of `sec-hardening-2026-10-15.md`. A hardening note from the 2026-10-15 security audit (run-1), not a finding. Full record: entries 40 and 177 of `results/hardening-all.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo, and the third local check of the blocked Windows unit in `coverage-ledger.json` (`sec-hunt-windows-cmd-reparse.md`).

## What

The first-run review records a digest of a card's `CardContent`: its title, body and `attachments:`. A card's frontmatter `agent:`, `model:` and `effort:` are not in it, and the review sheet does not show them. They are read unvalidated (`cardAgentOverride` says "Never validated against the profile table") and they change the launch command: `agent:` picks which CLI runs, and `model:` and `effort:` land on its first line through `composeLaunchCommand` and `composeEffort`. So a reviewed card whose `model:` is edited later, for example by a pulled commit, launches with a different command line and no new review, and the human never saw the value when they did review it.

## Why

Today these values are inert on POSIX: `quoteModel` single-quotes them, and `agent:` can only name a profile row the human's own settings hold. The audit's concern is the next field, or the next platform. On the Windows `.cmd` path the POSIX quoting is not honoured (`sec-hunt-windows-cmd-reparse.md`), and any later frontmatter field that reaches a launch line inherits the same gap. The review is meant to cover everything the repository wrote that reaches the agent; the launch line is part of that.

## Where (lines as of 2026-10-16; re-read before editing)

- `app/src/lib/cards/cardReview.ts:48` (CardContent): title, body, attachments.
- `app/src/lib/cards/cardReview.ts:73` (cardContentDigest): `gavin-card-review/1` over those three fields.
- `app/src/lib/cards/cardReview.ts:265` (reviewLines): what the sheet lists.
- `app/src/lib/cards/cardAgent.ts:59` (cardAgentOverride): reads `agent:`, `model:`, `effort:` trimmed and unvalidated.
- `app/src/lib/agents/agentModel.ts:52` (quoteModel), `:67` (composeLaunchCommand), `:124` (composeEffort): where the values become argv.
- Builders of `CardContent`, every one of which must carry the new fields: `app/src/lib/cards/cardRunActions.ts:475` (develop), `:792` (launchCard), `:1142` (main-agent handoff); `app/src/lib/cards/bestOfNActions.ts:143`; `app/src/lib/orchestration/orchestrationState.ts:1615-1619` (rail step); `app/src/lib/cards/CardComposeModal.svelte:356` (the composer's stamp).
- `app/src/lib/cards/CardDetailModal.svelte:300` (writeField): the picker's write of `agent`/`model`/`effort`, which does not re-stamp.

## Change

Add optional `agent`, `model` and `effort` strings to `CardContent`, and fill them from the card at every builder above. Include them in the digest only when at least one is non-empty, as a second tagged encoding (`gavin-card-review/2` with all six fields); a card that names none keeps exactly today's `/1` bytes, so the existing markers of ordinary cards stay valid and nobody is asked again for cards that never named an agent. Add a line to `reviewLines` naming the agent, model and effort the card asks for, when it asks for any.

Then keep gavin's own writers from tripping the gate: when `writeField` changes `agent`, `model` or `effort` on a card whose current content was reviewed, re-stamp it with the new value, as the composer does for a card it writes. A human choosing a model in the picker is the human's own edit.

Leave `complexity:` out. It selects a row of the human's own complexity table and puts no repository text on the launch line. A character-set check on `model:`/`effort:` is not needed here; the Windows `.cmd` refusal (`sec-hardening-windows-cmd-shim-refuse-specials.md`) covers the one path where quoting fails.

## Test

In `cardReview.test.ts`: the digest of content with no agent fields equals today's `/1` digest for the same title, body and attachments (pin one literal); adding `model: "opus"` changes it; changing `model` from `opus` to `sonnet` changes it again; `reviewLines` lists the model when one is set. In `cardRunActions.test.ts`: stamp a card's content, change only its `model:` in the tree, launch, and expect `ensureCardReviewed` to raise the sheet.

## Done when

- A change to a card's `agent:`, `model:` or `effort:` makes the next launch ask for review, unless gavin's own picker made it, and the sheet shows those values.
- A card that names none of them keeps its existing marker.
- The tests above exist, and the launch test fails before the change.
- The checks in CLAUDE.md pass for every part you touched, and you commit only your own files.
