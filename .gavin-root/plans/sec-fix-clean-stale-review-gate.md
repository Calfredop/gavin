---
kind: task
title: "[sec] Clean stale decisions/tests hands unreviewed cloned-card text to an unsandboxed agent with no first-run review"
status: To Do
priority: medium
complexity: moderate
---
Fix a medium-severity finding from the 2026-10-15 security audit (run-1). Fingerprint: `app/src/lib/decisions/cleanStaleActions.ts:requestCleanStale:first-run-review-not-consulted`.

Full record: `findings.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

The Decisions and Review tabs have a 'Clean stale …' action, reachable on the desk and from a paired Device. It copies the text, options and latest outcome line of every open `Decision:`/`Human test:` item, verbatim, into an agent prompt. The prompt also tells the agent to read every listed card and to edit every card file. The only question the human is asked is a confirm that gives counts and nothing else ('An agent reads the 1 open decision on 1 card …'). The first-run review gate is never consulted on this path, on the desk or in the daemon. A repository the human clones can ship `.gavin-root/plans/*.md` cards whose bodies carry `- [ ] Decision: …` lines. decisionsList shows those items without any review check. On this click their text, and the card bodies the agent is sent to read, reach the human's agent unread. The tab sends the whole list, not the filtered one, so this includes items the human was not looking at. AD-3 does not accept this, and cardReview.ts promises to prevent it. The develop launch had the same 'agent is told to read the card' shape and was gated by sec-fix-develop-run-review.

## Root cause

requestCleanStale (cleanStaleActions.ts:69-83) asks only askConfirm(cleanConfirm(...)), then composes the prompt from repository-authored card content (composeCleanPrompt/itemsBlock, cleanStale.ts:113-124). launchClean then calls backend.createSession (cleanStaleActions.ts:121). No listed card ever passes through cardReviewed or ensureCardReviewed. The queued replay (launchQueuedClean, line 87) sends the same snapshotted prompt, also ungated. cleanConfirm (cleanStale.ts:91-107) states counts only. The daemon keeps no review digest (crates/ has no reviewedCards/reviewed_cards), so nothing downstream gates the spawn.

## The invariant to enforce

No card content the human has not reviewed reaches an agent. Before the launch, and before holdOrQueue, check each listed card. If its title, stripped body and attachments do not match an approved reviewedCards digest, it must either go through the first-run review sheet, showing the card body the agent will read as developCard does, or be withheld from the run. The confirm then names the cards that were left out.

## Trace (lines as of 2026-10-16; re-read before editing)

- `app/src/lib/decisions/DecisionsHubView.svelte:320` (clean()): The 'Clean stale decisions' button calls requestCleanStale(workspaceId, 'decisions', cleanable). `cleanable` is built from the WHOLE list.subjects, not the filtered view (lines 300-308). ReviewHubView.svelte:475 does the same for tests, and a Device reaches the same function through app/companion/src/companion/state/decisions.ts:21 with DEVICE_AGENT_HOST.
- `app/src/lib/decisions/decisions.ts:307` (decisionsList/decisionsOf): Card items are listed whenever the card is unfinished and the daemon is new enough (pendingItems). No review digest is consulted, so a cloned card's `Decision:` lines become entries.
- `app/src/lib/decisions/cleanStaleActions.ts:75` (requestCleanStale): The only gate is askConfirm(cleanConfirm(kind, entries)). cleanConfirm (cleanStale.ts:91-107) yields only item and card counts.
- `app/src/lib/decisions/cleanStale.ts:118` (itemsBlock): Each item's text (118), Options (119) and latest outcome line (120), along with the card path and title (116), are written verbatim into the prompt.
- `app/src/lib/agents/actionPromptDefaults.ts:106` (DEFAULT_CLEAN_STALE): 'For each item, read its card…' and (line 111) 'Close a stale item by editing its card file'. The agent is pointed at every listed card body, unreviewed included, and told to write to it.
- `app/src/lib/decisions/cleanStaleActions.ts:121` (launchClean): backend.createSession(root, command, root, …) spawns the workspace agent CLI in the workspace root, unsandboxed as the user, with that prompt as its argument. No cardReviewed/ensureCardReviewed call precedes it.

## Fix

In requestCleanStale, before askConfirm/composeCleanPrompt and therefore before holdOrQueue and createSession, read each listed card the way developCard does: backend.readFileForViewer, stripFrontmatter, and attachments from the board's CardView. Either drop every entry for which cardReviewed(workspaceId, path, content) is false and name the dropped cards in the confirm, or raise ensureCardReviewed per card with blockLabel 'The card body the agent will read:'. That way the composed prompt and the queued CleanIntent snapshot only ever carry reviewed cards. Regression test (cleanStaleActions.test.ts): with requireReview on and an entry whose card has no reviewedCards digest, requestCleanStale must not call backend.createSession or holdOrQueue with a prompt containing that card's item text unless the review was accepted. The hunter's sketch below references a helper (cardContentForLaunch) and a three-argument cleanConfirm that do not exist yet. Both must be written.

`app/src/lib/decisions/cleanStaleActions.ts`, as a sketch only:

```
export async function requestCleanStale(workspaceId, kind, entries, host = DESK_CLEAN_HOST) {
  // First-run review: no card the human has not read reaches the agent.
  const reviewed: CleanEntry[] = [];
  const withheld: string[] = [];
  for (const entry of entries) {
    const content = await cardContentForLaunch(workspaceId, entry.cardPath); // title, stripped body, attachments -- as developCard reads them
    if (content && cardReviewed(workspaceId, entry.cardPath, content)) reviewed.push(entry);
    else withheld.push(entry.title);
  }
  if (reviewed.length === 0) return withheld.length ? `Review these cards first: ${withheld.join(", ")}` : null;
  if (!(await askConfirm(cleanConfirm(kind, reviewed, withheld)))) return null;
  const prompt = composeCleanPrompt(kind, reviewed, mustPromptBody("action:clean-stale", workspaceId), mustPromptBody("action:name-tab-first", workspaceId));
  return launchClean(workspaceId, CLEAN_LABEL[kind], prompt, host);
}
```

## Done when

- The gate runs before askConfirm and holdOrQueue, so the queued clean intent only ever carries reviewed cards.
- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched, and you commit only your own files.
