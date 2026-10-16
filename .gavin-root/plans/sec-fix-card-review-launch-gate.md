---
kind: task
title: "[sec] 'Review with agent…' and 'Critical review…' on a card send agents to read an unreviewed cloned card with no first-run review"
status: To Do
priority: medium
complexity: moderate
---
Fix a medium-severity finding from the 2026-10-15 security audit (run-1). Fingerprint: `app/src/lib/review/codeReview.ts:card_read_line:first-run-review-not-consulted`.

Full record: `findings.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

The card menu offers 'Review with agent…' and 'Critical review…' on every non-note card whatever its binding state (cardMenu.ts:208-231), including a cloned card that has never run. The Review tab also offers the critical review (ReviewHubView.svelte:442). Both paths build a ReviewedCard from the card and pass it to composeReviewPrompt. That function names the card's path and title in the subject and adds 'Then read the card itself — it says what the work was FOR'. The review then spawns one agent (backend.createSession), or N agents on a tiled page (createTiledPage), unsandboxed as the user in the card's checkout. The only dialog shown is ReviewDialog, which displays the subject line and the base and never the card body. Neither path calls the first-run review gate. A tree-wide grep finds its only call sites in cardRunActions.ts (develop, launchCard incl. its 'review' mode, Best-of-N via bestOfNActions.ts, resume and relaunch), CardDetailModal.svelte and the rail-step stall in orchestrationState.ts. There are none under app/src/lib/review. The develop launch was gated for exactly this shape: an agent told to 'read the card' received a cloned repo's hostile body unread (cardRunActions.ts:455-464). A repository-shipped card's body therefore reaches the reviewer agent(s) on this click with no review sheet. The effect beyond 'the agent is directed at the unreviewed card' depends on the agent CLI reading it and acting on its text, and that was not exercised. Calibration: the same review prompt also tells the agent to read the repository's own `.gavin-root/REVIEW.md`, which 'wins'. That file has no digest gate either, so gating the card narrows this launch's exposure without closing every repo-text channel into it. That is a separate root cause, not this fingerprint. Cards the review agent files (`review-*`) are not stamped, so their later runs are still gated and this does not spread into future prompts.

## Root cause

requestCardReview (app/src/lib/review/codeReviewActions.ts:187-196) and requestCardCriticalReview (app/src/lib/review/criticalReviewActions.ts:163-178) pass { path: card.id, fileName, title, kind } into the request without consulting cardReviewed/ensureCardReviewed. confirmReview -> launchReview (codeReviewActions.ts:219-315) and confirmCriticalReview -> launchCriticalReviewSessions (criticalReviewActions.ts:267-397) then compose the prompt through composeReviewPrompt, which emits card_read_line for any card (codeReview.ts:194-197), and launch it (createSession at codeReviewActions.ts:289; createTiledPage at criticalReviewActions.ts:331). Every other launch that hands a card to an agent runs ensureCardReviewed before any session is created: developCard at cardRunActions.ts:477, launchCard at :800, plus :1139 and bestOfNActions.ts:140.

## The invariant to enforce

A review launched from a card whose current content (title, body, attachments) has no approved digest, with requireReview on, must raise the same first-run review sheet develop raises, showing the card body the agent will be told to read, before the review dialog opens and before any session or page is created. If the human declines, nothing is pending and nothing is launched. A branch review (card null) and a card already stamped proceed as today.

## Trace (lines as of 2026-10-16; re-read before editing)

- `app/src/lib/cards/cardMenu.ts:216` (card menu 'Review with agent…' onPick): Pushed for every non-note card whatever its binding state (comment 208-212). It calls requestCardReview directly. 'Critical review…' at 224-231 and ReviewHubView.svelte:442 call requestCardCriticalReview directly. Nothing gate-like sits in between.
- `app/src/lib/review/codeReviewActions.ts:193` (requestCardReview -> open): Builds ReviewedCard { path: card.id, fileName, title, kind } and stores the pending request. open() (125-165) reads only the REVIEW.md rules path and git refs. It never reads the card's review marker. ReviewDialog.svelte:59 shows only 'Reviews {subject}' and the base.
- `app/src/lib/review/codeReview.ts:194` (composeReviewPrompt card_read_line): For any card it adds 'Then read the card itself — it says what the work was FOR…'. The subject at line 175 names the card path and title. The template (actionPromptDefaults.ts:154-157) also tells the agent to read the rules path first and says 'it wins'.
- `app/src/lib/review/codeReviewActions.ts:289` (launchReview backend.createSession): Spawns the agent in request.cwd with the composed prompt on its command line. The critical variant composes per reviewer at criticalReviewActions.ts:297 and spawns N sessions through createTiledPage at criticalReviewActions.ts:331. Neither is preceded by a gate call.

## Fix

In requestCardReview and requestCardCriticalReview, before open() sets the pending request, apply the develop gate verbatim: resolveAttachmentsForRun, readFileForViewer(card.id), stripFrontmatter(...).trim(), then ensureCardReviewed({ workspaceId, path: card.id, content: { title, body, attachments }, statuses, prompt: body, blockLabel: 'The card body the review agent will read:' }). Return null on decline so nothing is pending. Branch and rail reviews (card null) are unaffected, and a stamped card passes silently. The queued path (launchQueuedReview) replays an intent that already cleared the gate, so no second check is needed there. Separately, decide whether the repo-shipped REVIEW.md the prompt says 'wins' needs its own digest gate (a different root cause). Add regression tests in codeReviewActions.test.ts and criticalReviewActions.test.ts: with requireReview on and no reviewedCards digest, requestCardReview/requestCardCriticalReview raise askConfirm with REVIEW_CONFIRM_LABEL. Declining leaves reviewRequest null and never calls backend.createSession or createTiledPage.

`app/src/lib/review/codeReviewActions.ts`, as a sketch only:

```
import { revealSession, resolveAttachmentsForRun } from "$lib/cards/cardRunActions";
import { ensureCardReviewed } from "$lib/cards/cardReviewActions";
import { stripFrontmatter } from "$lib/cards/planChecklist";

export async function requestCardReview(workspaceId: string, card: CardView): Promise<string | null> {
  if (card.kind === "note") return "Notes have no work to review";
  // First-run review, as developCard: the agent is told to read this card.
  const resolved = await resolveAttachmentsForRun(workspaceId, card.attachments ?? []);
  if ("error" in resolved) return resolved.error;
  const file = await backend.readFileForViewer(card.id);
  if (!file.exists) return `Card file not found: ${card.id}`;
  const body = stripFrontmatter(file.content).trim();
  if (
    !(await ensureCardReviewed({
      workspaceId,
      path: card.id,
      content: { title: card.title, body, attachments: card.attachments ?? [] },
      statuses: resolved.statuses,
      prompt: body,
      blockLabel: "The card body the review agent will read:",
    }))
  ) {
    return null;
  }
  const binding = cardSessionFor(get(kanbanState)[workspaceId], card.id);
  return open(workspaceId, {
    cwd: binding?.launchCwd ?? card.contextFolder,
    contextFolder: card.contextFolder,
    card: { path: card.id, fileName: card.fileName, title: card.title, kind: card.kind },
    subject: `the work done for “${card.title}”`,
  });
}
```

`app/src/lib/review/criticalReviewActions.ts`, as a sketch only:

```
export async function requestCardCriticalReview(workspaceId: string, card: CardView): Promise<string | null> {
  if (card.kind === "note") return "Notes have no work to review";
  const resolved = await resolveAttachmentsForRun(workspaceId, card.attachments ?? []);
  if ("error" in resolved) return resolved.error;
  const file = await backend.readFileForViewer(card.id);
  if (!file.exists) return `Card file not found: ${card.id}`;
  const body = stripFrontmatter(file.content).trim();
  if (
    !(await ensureCardReviewed({
      workspaceId,
      path: card.id,
      content: { title: card.title, body, attachments: card.attachments ?? [] },
      statuses: resolved.statuses,
      prompt: body,
      blockLabel: "The card body the reviewer agents will read:",
    }))
  ) {
    return null;
  }
  const binding = cardSessionFor(get(kanbanState)[workspaceId], card.id);
  return open(workspaceId, {
    cwd: binding?.launchCwd ?? card.contextFolder,
    contextFolder: card.contextFolder,
    subjectKind: "card",
    subject: cardSubjectLabel(card.title),
    card: { path: card.id, fileName: card.fileName, title: card.title, kind: card.kind },
    railId: null,
    railName: null,
  });
}
```

## Done when

- Both requestCardReview and requestCardCriticalReview run the gate before open() sets the pending request; a branch review (no card) is unchanged.
- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched, and you commit only your own files.
