---
order: 11264
kind: task
title: Turn verdict: show a prose question on the tab badge, sidebar and card
status: Done
priority: medium
complexity: moderate
---
Follow-up to `.gavin-root/plans/done/typesafe-turn-verdict.md`. The TypeSafe turn verdict now tells a question asked in prose (and a turn that broke) apart from a finished turn, but only the rails, auto-resume, the hub's attention inbox and the follow-up queue view read it. The badges a human actually looks at still read the daemon's raw status, so a prose question shows as a finished, idle agent on its tab and its card.

Make the surfaces that tell a human COME AND LOOK read the verdict-aware view:

- the tab badge: `panes/Pane.svelte` (`tabAgentIndicator($attentionStatusById[sessionId], ...)`)
- the sidebar recap and tab rows: `sidebar/Sidebar.svelte` (`pageAgentsSummary(page, $attentionState)`, `pageTabRows(page, $attentionState)`, the search hits)
- the board card's session dot: `board/BoardCard.svelte`
- the card detail modal's session bar and Best-of-N rows: `cards/CardDetailModal.svelte`

**Read this before the "How" — the card's original API names were wrong.**
A 2026-09-22 audit against `main` found that `overlayVerdicts`,
`verdictOverlay` and `verdictAttentionState` **do not exist anywhere in
`app/`**; the Done card `plans/done/typesafe-turn-verdict.md` claims them and
they did not land. What shipped instead is a set of predicates plus one
store, and the section below is rewritten against those. If a name here is
also missing, stop and say so rather than inventing the seam.

What actually exists:
- `app/src/lib/agents/turnVerdict.ts` — `verdictIsAsking(entry)` (:563),
  `verdictCompletesTurn` (:545), `verdictStallReason` (:575),
  `readingOf` (:516), `agentLastLine` (:463 — **not** `agentLastWords`),
  `TurnVerdictEntry` (:512), `TurnReading` (:363).
- `app/src/lib/agents/turnVerdictState.ts` — exports only
  `typesafeSettings`, `turnVerdictById` (a `writable<Record<string,
  TurnVerdictEntry>>`), `PENDING_BACKSTOP_MS`, `loadTypesafeSettings`,
  `verdictsOf`, `whenTurnVerdictSettles`, `__resetForTesting`.
- **The seam this card wants already exists, and is module-private**:
  `reasonFor` in `app/src/lib/agents/attentionInbox.ts:284`, whose line 306
  is `if (status === "idle" && verdictIsAsking(verdicts.get(sessionId)))
  return "asking";`. Nothing exports a per-session verdict-aware status —
  that gap is exactly this card.

How:
- Add one derived, `attentionStatusById`-shaped store — in
  `turnVerdictState.ts`, or a small new module beside it — that starts from
  the acknowledged view (`attentionState` / `attentionStatusById`) and
  upgrades ONLY the sessions whose entry in `turnVerdictById` reads as
  asking (`verdictIsAsking`) or blocked. Never rewrite a status the daemon
  did not report as `idle`: the verdict's whole job is to reinterpret quiet,
  and a `working` or `failed` session is not its business.
- **Export the predicate `reasonFor` inlines** rather than writing a second
  copy of the idle-plus-asking test, and have `attentionInbox.ts` call it —
  two spellings of one rule is how the badge and the inbox come to disagree.
- Keep the store lazy: a module-level `derived` over `layoutState`'s exports
  breaks under the partial `vi.mock`s the existing suites use.
- Read `AppHubView.svelte:188` for how a caller feeds verdicts in today
  (`verdictsOf($turnVerdictById)`); the new store must be fed the same way,
  never from raw `layoutState.sessionStatusById`, which carries no verdicts.
- Surfaces that ACT keep reading the daemon's own status (`sessions/sessionRead.ts` header): the follow-up queue gate on Pane and MainAgentPanel, and the menu context that offers Mark as Read.
- Decide Mark as Read for a verdict-asking session, and say what you decided in the card. Today `canMarkRead` only accepts the daemon's `waiting_for_input`, so a verdict-asking badge could not be silenced -- and the verdict flags ~3 of 44 finished turns as asking, so a false one would nag with no off switch. The mark must still clear on the next status the daemon reports.
- Extend `sessions/sessionReadSurfaces.test.ts` for every surface you change, and add unit tests for the new store.

Checks: `cd app && npm test && npm run check && npm run build`. **The old
baseline sentence on this card was stale and has been deleted**: it said "12
tests and 3 suites fail and check has 6 errors", which was the pre-fix state.
`plans/archive/fix-the-last-twelve-vitest-failures-on-main.md` and
`fix-npm-run-check-gate-is-red-on-main.md` closed exactly those two numbers, and
vitest has been green on `main` (281 files / 6184 tests) with svelte-check at 0
errors since 2026-09-22. **So any red is yours** — do not excuse one against a
remembered baseline. Also do a static pre-flight of the exact strings the change
relies on. The rendered pass is the owner's.

Verified still open on 2026-09-22: all four surfaces read the acknowledged
daemon view with no verdict — `Pane.svelte:265`, `Sidebar.svelte:552,559`,
`BoardCard.svelte:129`, `CardDetailModal.svelte:630,643,906,1299` — and
`sessionRead.ts:50-52` is still `return status === "waiting_for_input";`.

---

## What landed (2026-09-23)

New seam: `app/src/lib/agents/verdictAttention.ts`.

- `verdictAttentionStatuses(statusById, verdicts, marks)` — pure. Starts from
  the acknowledged map and raises ONLY sessions the daemon calls `idle` whose
  verdict reads as asking. Walks the verdict map (small) rather than the status
  map, and hands back the ORIGINAL object when nothing is raised, so the four
  consumers are not invalidated on every unrelated layout change.
- `verdictAttentionState` / `verdictAttentionStatusById` — lazy `Readable`
  wrappers built on first subscribe, exactly as the card required: a
  module-level `derived` over `attentionState` throws under the ~20 suites that
  partially `vi.mock("$lib/core/layoutState")`. Fed `verdictsOf($turnVerdictById)`,
  the same way `AppHubView` feeds the inbox. `__resetForTesting` drops both.

Surfaces moved: `Pane.svelte:268` (tab badge), `Sidebar.svelte:440,520,555,562`
(search hits, workspace badge, page recap, tab rows), `BoardCard.svelte:131`
(session dot), `CardDetailModal.svelte:639,653,916,1309` (session bar, badge,
`cardSituation`, Best-of-N rows). Surfaces that ACT are untouched: the
follow-up queue gate on `Pane`/`MainAgentPanel` and both Mark-as-Read menu
contexts still read `$layoutState.sessionStatusById`.

### Decision: Mark as Read DOES cover a verdict-asking session

`canMarkRead(status, verdict?)` now returns true for `waiting_for_input` OR for
a session the shared predicate reads as quietly asking. This is a requirement
of raising the badge, not a convenience: the verdict is a judgement (~3 of 44
finished turns here read as asking), the daemon's answer for such a session is
already `idle`, so no later status can contradict a false positive and there is
no keystroke the human can make on the agent's behalf. A wrong badge with no
off switch is worse than the missing badge this card fixes.

The mark still clears on the next status the daemon reports —
`handleSessionStatusChanged` already calls `clearSessionRead` unconditionally,
so that came for free. The menu keeps reading the DAEMON's status and takes the
verdict as a separate argument (`TabMenuContext.verdict`), so the split
`sessionRead.ts` describes is unchanged: the verdict ADDS a case, it does not
substitute a view. `verdictAttentionStatuses` skips marked sessions, so a mark
cannot be undone on the next store emission (both directions tested).

### Decision: `blocked` is NOT raised — only `asking`

The card asked for "asking or blocked". Implemented as asking only, because
`blocked` is already reported and raising it would break the card's own
consistency rule:

- `attentionInbox.test.ts` already asserts a `blocked` verdict lists NOTHING in
  the hub's inbox — a shipped, tested decision from `typesafe-turn-verdict`.
- `orchestration.ts:2074` turns `blocked` into a rail STALL carrying
  `blockedStepReason(said)` — the agent's own sentence, which says more than a
  badge could, and pauses the rail.
- Every other consumer (`stepAttentions`, `reasonFor`, `queuedInput`) tests
  `verdictIsAsking` alone. A badge for `blocked` would be the badge holding a
  rule the inbox and the step marks do not share — the exact disagreement the
  card's second bullet forbids.

Naming a block in the inbox would need a sixth `StepAttention`, which is the
rails' vocabulary and a card of its own.

### One rule, one spelling

`verdictAsksQuietly(status, entry)` in `turnVerdict.ts:596` is the predicate
`reasonFor` inlined. Three call sites now share it: `attentionInbox.ts:312`
(was the inline copy), `orchestration.ts:1295` (`stepAttentions` had a THIRD
identical copy — the `else if` chain had already ruled out `failed` and
`waiting_for_input`, so this is the same branch it always was), and
`verdictAttention.ts:88`. `sessionRead.ts:87` calls it too.

Also left alone on purpose: the hub's fleet TALLIES (`AppHubView`'s
`state: $attentionState`). Moving those changes what the hub COUNTS rather than
what a badge draws, and its inbox rows already read the verdict by the other
road. `sessionReadSurfaces.test.ts` now pins that split explicitly so it is a
decision rather than an oversight.

### Checks (all on this branch, 2026-09-23)

- `npm test` — **282 files / 6206 tests, 0 failures** (baseline 281/6184; +1
  file and +22 cases are this card's).
- `npm run check` — **0 errors**, 36 warnings (all pre-existing a11y/svelte
  warnings in files this card did not touch).
- `npm run build` — green.
- Static pre-flight: `attentionStatusById` has no consumer left outside
  `layoutState.ts` itself; `verdictAttentionStatusById` / `verdictAttentionState`
  resolve in all four components; `verdictAsksQuietly` resolves at all four call
  sites. Every touched file is LF on disk.

Tests added: `agents/verdictAttention.test.ts` (11), plus new cases in
`turnVerdict.test.ts`, `sessionRead.test.ts`, `sessionReadSurfaces.test.ts`,
`tabMenu.test.ts`; `sidebarSummary.test.ts`'s badge-wiring assertion updated to
the new store.

The rendered pass is the owner's: no suite can see a badge drawn.
