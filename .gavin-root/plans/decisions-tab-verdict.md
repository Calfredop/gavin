---
kind: task
title: "Decisions tab: list the prose questions the turn verdict catches"
parent: tb-developed-feat-decisions-tab.md
complexity: moderate
---
Read the parent plan, `tb-developed-feat-decisions-tab.md` in this card's
own folder, first. The TypeSafe turn verdict is on main
(`app/src/lib/agents/turnVerdict.ts`, `turnVerdictState.ts`); if it is
not, stop and say so.

Make the Decisions tab list the prose questions the verdict catches:

- **Asking.** `attentionInbox` already turns an idle session whose
  verdict `verdictIsAsking` into an `asking` row — but only when it is
  handed `verdicts`. Make sure the tab's call passes
  `verdictsOf($turnVerdictById)`, the way `AppHubView.svelte` does. Never
  read raw `layoutState.sessionStatusById` for this: it has no verdicts
  in it.
- **Blocked.** A `blocked` verdict only becomes a rail stall
  (`verdictStallReason`), so a blocked agent with no rail behind it is in
  no list. List it in the Decisions tab as waiting on the human, with the
  agent's own line (`said`) as its reason.

Tests go in the `app/src/lib/decisions/` module.

Done when `cd app && npm test && npm run check && npm run build` are green
against a clean-HEAD baseline, plus a static pre-flight grep of the exact
strings the change relies on. The rendered pass is the owner's.
