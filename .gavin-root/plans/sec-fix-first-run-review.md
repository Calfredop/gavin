---
order: 8192
title: [sec] first-Run review of unread card content
status: In Progress
priority: high
complexity: complex
---
**Severity:** High. Finding **R2** in `docs/security/README.md` (sources AG-01, AG-02 in `03-agent-surface.md`). The report lives on branch `sec/review-2026090801` until merged.

**The problem.** A cloned repo's card body is the agent's prompt, verbatim, and the board shows the human only the title. Reproduced: a card titled "Fix a typo" carried a hidden injection body, an `attachments:` entry outside the workspace, and the auto-commit block — none visible before Run. AD-3 accepts the Run click on a card the human wrote; it does not accept content the human has not read.

**The fix.** At the Run click (board, card modal, rail start, Run all), show once what the agent will receive and require an explicit "Run this" before launching:

- [ ] Compose the exact prompt (`compose_agent_prompt` path) and the resolved attachment list (each file's path, size, and whether it lies inside the workspace root or an extra context) before the session is created, not after.
- [ ] A review panel (`ConfirmPrompt`, a `danger` choice keeps focus off Run) listing the body, HTML comments included, the attachments, and the auto-commit block; the button names the action.
- [ ] Remember per card that the human has reviewed this body: a hash of the composed prompt in the workspace's app state (`config.json` side, no protocol change). A changed body or attachment set asks again; a card the human authored in the composer is pre-approved by the act of writing it.
- [ ] Rails: a step whose card was never reviewed pauses with a wait the attention inbox shows, instead of launching.
- [ ] Unit tests in the pure module (`cardRun.ts` / `attachments.ts`) for: hidden comment shown, outside-root attachment flagged, hash invalidation on edit.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
