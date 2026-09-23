---
order: 12288
kind: task
title: Turn verdict: hold the 'finished' notification until the verdict is in
status: Done
priority: medium
complexity: moderate
---
Follow-up to `.gavin-root/plans/done/typesafe-turn-verdict.md`. The OS notification for a session going quiet fires at the quiet transition itself (`core/layoutState.ts` `handleSessionStatusChanged` -> `notifyStatus` -> `core/notifications.ts` `maybeNotifyStatusChange`), before the TypeSafe turn verdict has had its (at most) three seconds. So a question asked in prose still arrives as "<label> finished", and a turn the verdict reads as broken is never announced as one.

For a session the verdict will judge, hold the "finished" notification until the verdict settles, then send the one it earns:

- `asking` -> the needs-input notification (respect the workspace's `notifyNeedsInput`)
- `failed` -> the failure notification with the quoted line (`failureBody`), as a daemon-detected failure gets
- `blocked` -> say it stopped short, with the agent's words (`agentLastWords`); decide which toggle governs it
- `finished` / `today` (timeout, error, low confidence) -> exactly today's "finished" notification, just late
- `working` -> nothing now; the next quiet transition notifies

**Read this before the "Where" — the card's original premise was wrong on
both halves.** A 2026-09-22 audit against `main` found that
`setTurnVerdictHook`, `verdictPending`, `VERDICT_WAIT_MS` and
`agentLastWords` **do not exist anywhere in `app/`**. The section below is
rewritten against the real surface. If a name here is also missing, stop and
say so rather than inventing the seam.

Where:
- **The settle primitive you want already exists**:
  `whenTurnVerdictSettles(sessionId)` in `agents/turnVerdictState.ts:97`
  returns a promise that resolves with the `TurnVerdictEntry`. Await it
  instead of building a hook. The backstop is `PENDING_BACKSTOP_MS = 3_000`
  (`turnVerdictState.ts:62`), not `VERDICT_WAIT_MS`.
- **"Will be judged"** is: the session has a `{ state: "pending" }` entry in
  `turnVerdictById` at the moment of the transition. Everything else —
  feature off, key missing, older daemon, bare terminal, command tool —
  notifies exactly as today, immediately.
- **The single-slot hook is `setSessionStatusHook`** (`core/layoutState.ts:3523`),
  and **the turn verdict driver owns it** (`agents/turnVerdictDriver.ts:234`),
  not auto-resume. Auto-resume owns a *different* hook,
  `setSessionFailureHook` (`agents/autoResumeState.ts:485`). `layoutState.ts:3520`
  already anticipates this card in a comment: *"One hook, not a list — the
  same shape as its sibling, to be widened when a second listener exists
  rather than before."* That second listener is you: widen it to a list, or
  have the driver fan out. Keep auto-resume's behaviour and its tests
  untouched either way.
- The notification path itself: `layoutState.ts:3439` calls `notifyStatus`
  unconditionally; `notifyStatus` (:3541) calls `maybeNotifyStatusChange`
  (`core/notifications.ts:106-149`), which has no verdict awareness at all —
  its own `verdict` identifiers are `AgentCommitVerdict`, something else
  entirely.
- Use `agentLastLine` (`turnVerdict.ts:463`) for the agent's own words, and
  `verdictStallReason` (:575) / `blockedStepReason` (:489) for the blocked
  wording. `verdictIsAsking` (:563) is the asking test.
- Still add your own fallback timer so a notification is never lost if no
  settle arrives. Plain `setTimeout`, never a detached `window.setTimeout`
  (WKWebView throws).
- Mind the rail voice (`setRailNotificationVoice`, `railStatusVoice` in `orchestration/orchestrationState.ts`): a card step whose agent went idle short of Done already gets its own sentence, and a verdict must not produce two notifications for one turn.
- Logic in a pure module with unit tests (the reading -> notification mapping, and which transitions defer); the wiring stays thin.

Checks: `cd app && npm test && npm run check && npm run build`. **The old
baseline sentence on this card was stale and has been deleted**: it said "12
tests and 3 suites fail and check has 6 errors", which was the pre-fix state.
Those two numbers were closed by
`plans/archive/fix-the-last-twelve-vitest-failures-on-main.md` and
`fix-npm-run-check-gate-is-red-on-main.md`; vitest has been green on `main`
(281 files / 6184 tests) with svelte-check at 0 errors since 2026-09-22. **So
any red is yours.** The rendered and notification pass is the owner's.

Verified still open on 2026-09-22: `layoutState.ts:3439` still calls
`notifyStatus` unconditionally at the transition, and
`notifications.ts:106-149` has no verdict input.
