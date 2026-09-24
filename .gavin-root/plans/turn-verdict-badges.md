---
order: 7168
kind: task
title: Turn verdict: show a prose question on the tab badge, sidebar and card
status: To Do
priority: medium
complexity: moderate
---
Follow-up to `.gavin-root/plans/done/typesafe-turn-verdict.md`. The TypeSafe turn verdict now tells a question asked in prose (and a turn that broke) apart from a finished turn, but only the rails, auto-resume, the hub's attention inbox and the follow-up queue view read it. The badges a human actually looks at still read the daemon's raw status, so a prose question shows as a finished, idle agent on its tab and its card.

Make the surfaces that tell a human COME AND LOOK read the verdict-aware view:

- the tab badge: `panes/Pane.svelte` (`tabAgentIndicator($attentionStatusById[sessionId], ...)`)
- the sidebar recap and tab rows: `sidebar/Sidebar.svelte` (`pageAgentsSummary(page, $attentionState)`, `pageTabRows(page, $attentionState)`, the search hits)
- the board card's session dot: `board/BoardCard.svelte`
- the card detail modal's session bar and Best-of-N rows: `cards/CardDetailModal.svelte`

How:
- Read `app/src/lib/agents/turnVerdict.ts` (`overlayVerdicts`) and `turnVerdictState.ts` (`verdictOverlay`, `verdictAttentionState`) first. The overlay is laid over the daemon's RAW statuses and only ever turns an `idle` into something else; build the new view the way `verdictAttentionState` is built: start from the acknowledged view (`attentionState` / `attentionStatusById`) and apply only the entries the overlay changed. Prefer one derived `attentionStatusById`-shaped store in `turnVerdictState.ts` over per-component logic; keep it lazy (see the comment on `verdictAttentionState`: partial `vi.mock`s of layoutState break any module-level derived over its exports).
- Surfaces that ACT keep reading the daemon's own status (`sessions/sessionRead.ts` header): the follow-up queue gate on Pane and MainAgentPanel, and the menu context that offers Mark as Read.
- Decide Mark as Read for a verdict-asking session, and say what you decided in the card. Today `canMarkRead` only accepts the daemon's `waiting_for_input`, so a verdict-asking badge could not be silenced -- and the verdict flags ~3 of 44 finished turns as asking, so a false one would nag with no off switch. The mark must still clear on the next status the daemon reports.
- Extend `sessions/sessionReadSurfaces.test.ts` for every surface you change, and add unit tests for the new store.

Checks: `cd app && npm test && npm run check && npm run build` (the baseline already fails 12 tests and 3 suites, and check has 6 errors, none in these files -- compare against a clean HEAD before calling anything a regression); static pre-flight of the exact strings the change relies on. The rendered pass is the owner's.
