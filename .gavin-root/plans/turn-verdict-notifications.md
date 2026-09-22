---
order: 12288
kind: task
title: Turn verdict: hold the 'finished' notification until the verdict is in
status: To Do
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

Where:
- "Will be judged" is `verdictPending` in `agents/turnVerdictState.ts` at the moment of the transition. Everything else -- feature off, key missing, older daemon, bare terminal, command tool -- notifies exactly as today, immediately.
- The verdict's settle hook (`setTurnVerdictHook`) is single-slot and auto-resume owns it. Make it a listener list (or add a second, notification-only hook) rather than taking it over; keep auto-resume's behaviour and its tests unchanged.
- The wait is bounded: `judge` always settles by `VERDICT_WAIT_MS`, but add your own fallback timer so a notification is never lost if no settle arrives. Plain `setTimeout`, never a detached `window.setTimeout` (WKWebView throws).
- Mind the rail voice (`setRailNotificationVoice`, `railStatusVoice` in `orchestration/orchestrationState.ts`): a card step whose agent went idle short of Done already gets its own sentence, and a verdict must not produce two notifications for one turn.
- Logic in a pure module with unit tests (the reading -> notification mapping, and which transitions defer); the wiring stays thin.

Checks: `cd app && npm test && npm run check && npm run build` (the baseline already fails 12 tests and 3 suites, and check has 6 errors, none in these files -- compare against a clean HEAD before calling anything a regression). The rendered and notification pass is the owner's.
