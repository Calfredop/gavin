---
order: 30720
kind: task
title: Companion: missing sections
status: To Do
---
- Review
  - include the "Clean stale tests" agent action (bot + broom, confirm modal first) — desktop has it since 2cd60ef3
- Decisions
  - include the "Clean stale decisions" agent action, same as above
...?

The clean action is already a pure module plus a launcher, so the phone reuses them rather than re-deriving anything: `$lib/decisions/cleanStale.ts` (entries, blocker, tooltip, confirm wording, prompt) and `$lib/decisions/cleanStaleActions.ts` (`requestCleanStale`, which asks through `dialog.ts`'s `askConfirm` before launching). On the desktop it sits in `DecisionsHubView.svelte`'s list head and `ReviewCardList.svelte`'s head (`clean` prop, wired in `ReviewHubView.svelte`).

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
