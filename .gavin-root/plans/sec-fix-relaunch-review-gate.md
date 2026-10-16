---
kind: task
title: "[sec] Re-launch replays a card run that points the agent at the current card file, with no first-Run review check"
status: To Do
priority: medium
complexity: moderate
---
Fix a medium-severity finding from the 2026-10-15 security audit (run-1). Fingerprint: `app/src/lib/cards/cardRunActions.ts:relaunchCard:no-review-gate`.

Full record: `findings.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

relaunchCard handles every Re-launch: the desk card menu, the CardDetailModal button, a queued relaunch intent drained by launchQueuedCard, and a Companion Device's launch(…, 'relaunch'). It replays the binding's stored launch command and, for any card that is not a direct prompt, appends withRelaunchNote. That note says the card's status is 'recorded in the card file at <current path>. Read that file first'. For a plan card the stored prompt is DEFAULT_RUN_PLAN, 'Read <path> and execute that plan', so the replayed command sends a fresh agent to execute whatever the card file says now. relaunchCard never calls cardReviewed or ensureCardReviewed. The sibling 'Launch as new session' appends the same relaunchNote and is gated (cardRunActions.ts:778, 798-800). Suppose a human reviewed and launched a card, and the card's body later changes through something other than gavin's own writers, such as a git pull of a collaborator's or upstream commit. Re-launch then hands the agent unreviewed repository-written instructions without showing the review sheet, although the module's stated invariant forbids exactly this. The repo's real launch module was run under Node, and it reached backend.createSession with zero gate calls on both relaunch paths. With identical stubs, the gated sibling stopped at ensureCardReviewed.

## Root cause

relaunchCard (cardRunActions.ts:1175-1290) skips the first-Run review on purpose. Its comment at 1191-1195 says the replayed bytes are 'the ones a human already read' and that 'none of it is going anywhere'. That is false for a plan card: its stored prompt only names the card file, and the relaunch note that relaunchCard itself appends (cardRun.ts:347-354, applied at cardRunActions.ts:1250) tells the agent to read the file at its current path. So the content that actually reaches the agent is the current, unreviewed file body. The code never reads it, never digests it and never checks it.

## The invariant to enforce

cardReview.ts:5-29 and cardRunActions.ts:703-707 count a plan agent told to read the card file as the card's content reaching the agent. Every launch that points an agent at the card file should therefore read the file, compute the CardContent digest and call ensureCardReviewed, or refuse unattended as auto-resume does with UNREVIEWED_UNATTENDED. This should happen before createSession and before the binding is replaced, the same way the 'new-session' mode gates the identical relaunch note.

## Trace (lines as of 2026-10-16; re-read before editing)

- `app/src/lib/cards/cardMenu.ts:160` (card menu 'Re-launch agent'): Picking Re-launch on any card whose binding canReplay calls relaunchCard(workspaceId, card.id). Further entry points reach the same function: CardDetailModal.svelte:834, launchQueuedCard at cardRunActions.ts:1299 for a queued intent with mode 'relaunch', and the Companion's launch(…, 'relaunch') at app/companion/src/companion/state/cards.ts:119.
- `app/src/lib/cards/cardRunActions.ts:1191` (relaunchCard): Design comment declining the first-Run review because 'the bytes it sends are the ones a human already read'. The only gates applied are canReplay, developingBlocker, sshLaunchBlocker and the launch wall (host.hold). There is no cardReviewed or ensureCardReviewed call, and the card file is never read.
- `app/src/lib/cards/cardRunActions.ts:1250` (relaunchCard): For any non-direct-prompt card, replayed = withRelaunchNote(binding.command, path) appends the note naming the card file at its current path.
- `app/src/lib/cards/cardRun.ts:351` (relaunchNote): The note says '…recorded in the card file at ${path}. Read that file first…'. For a plan card the stored prompt already says 'Read <path> and execute that plan' (actionPromptDefaults.ts:29).
- `app/src/lib/cards/cardRunActions.ts:1258` (relaunchCard): backend.createSession(binding.cwd, fresh.command, root, profile) starts the agent CLI with the replayed command. The agent runs unsandboxed as the user, is told to read and execute the current card file, and the binding is then rewritten to the new session.

## Fix

Gate relaunchCard the way new-session mode is gated. After the developing, ssh and wall gates and before baseShaForLaunch and createSession, re-resolve the card and read its file. Unless the card is a direct prompt (whose replayed bytes are the stored, already-reviewed body and get no note), build the CardContent from the current title, body and attachments. In queued or unattended contexts refuse with UNREVIEWED_UNATTENDED when cardReviewed is false. Otherwise call ensureCardReviewed and return null on decline. Add a vitest case beside cardRunActions.test.ts: stamp content A, change the file to B, relaunch, and expect ensureCardReviewed to be consulted and createSession not to be called on decline.

`app/src/lib/cards/cardRunActions.ts`, as a sketch only:

```
  // in relaunchCard, after `if (!binding.command?.trim()) return NOTHING_TO_REPLAY;`
  if (!(relaunched && isDirectPrompt(relaunched))) {
    const file = await backend.readFileForViewer(path);
    if (!file.exists) return `Card file not found: ${path}`;
    const content = {
      title: relaunched?.title ?? "",
      body: stripFrontmatter(file.content).trim(),
      attachments: relaunched?.attachments ?? [],
    };
    if (options.queued && !cardReviewed(workspaceId, path, content)) return UNREVIEWED_UNATTENDED;
    const resolved = await resolveAttachmentsForRun(workspaceId, content.attachments);
    if ("error" in resolved) return resolved.error;
    if (!(await ensureCardReviewed({ workspaceId, path, content, statuses: resolved.statuses,
        prompt: withRelaunchNote(binding.command, path) ?? binding.command }))) return null;
  }
```

## Done when

- relaunchCard reads the current card file and gates it before createSession and before the binding is rewritten; a queued drain refuses with UNREVIEWED_UNATTENDED.
- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched, and you commit only your own files.
