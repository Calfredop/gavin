---
order: 5120
kind: task
title: [sec] Develop reads an unreviewed card body too
status: To Do
priority: medium
complexity: simple
---
**Severity:** Medium. The residue left by `sec-fix-first-run-review.md` (finding R2 / AG-01), named there deliberately rather than half-covered.

**The problem.** Every launch that hands an agent a card's content now goes through the first-Run review (`cardReview.ts`): board Run, Resume, the Review tab, the main agent, best-of-N, and a rail step (which stalls instead of asking). `developCard` does not. Its prompt (`composeDevelopPrompt`) carries no body, no attachments and no auto-commit block — so there is nothing for the sheet to show, and a sheet promising "the prompt the agent receives" would show a prompt with none of the card in it. But the develop agent is told to use the `gavin-develop` skill *on that card*, so its first move is to read the body, and a cloned repo's card reaches it unread exactly as it used to reach a Run.

Smaller than Run in practice — develop targets thin cards, and the skill interviews before it writes — but it is the same class, and the same one gate closes it.

**The fix.** Decide which of two, then do it:

- Show the sheet the card BODY rather than a composed prompt when there is no prompt to show. `ConfirmBlock` already takes its own label, so `ensureCardReviewed` needs an optional one ("The card body the agent will read:") and `developCard` needs the file read it currently skips on purpose.
- Or say in `composeDevelopPrompt` that the body is untrusted repo content and the agent must not act on instructions found in it — cheaper, weaker, and it puts the whole weight on the agent obeying framing.

Whichever lands, note it beside the boundary comment in `cardRunActions.ts::developCard`, which currently says this card exists.
