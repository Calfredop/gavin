---
order: 3072
kind: task
title: Attention inbox on the hub
status: Done
priority: medium
---
Add one cross-workspace list of every session that is waiting on a human, ordered by how long it has waited, to the app hub.

Read first: `app/src/lib/appHub.ts` (the fleet badge strip and running-tasks column — the inbox is a sibling of that column and, like it, does no fetching of its own), the step-attention work (a running step says when it waits on a human: asking / turn-ended — find it via `smokeChecklist.ts` "attention"), `ui/indicators.ts` + `StatusBadge` (the ONE badge vocabulary; do not invent a new one), and `revealSession` in `cardRunActions.ts` (how a row jumps to its tab).

Behaviour:
- A session is in the inbox when it is waiting for input, when its agent failed (the failure-detection state), or when its turn ended on a rail step that needs the human (attention = human). Idle shells are not in it.
- Each row: workspace, page, tab name, the reason (StatusBadge), the bound card title if any, and the wait time since the state began. Sorted longest-waiting first. Click → activate the workspace, reveal the session.
- Pure logic in a new `attentionInbox.ts` with unit tests over synthetic session/status maps; the `.svelte` is a thin template.
- Empty state is one quiet line, not a card.

Out of scope: OS notifications (they exist), any change to the per-workspace sidebar recap, any polling.

Done when: `attentionInbox.test.ts` covers the three reasons, ordering and the "idle shell is excluded" case; `cd app && npm test && npm run check` are green; a smoke item is added to `smokeChecklist.ts`.

Borrowed from Cursor's Inbox and the agents-window sidebar (2026-09-03 feature scan).
