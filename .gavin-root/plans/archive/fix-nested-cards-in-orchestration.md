---
order: 6144
title: [fix] orchestration has no answer for a nested card
status: Done
---
A nested task that is genuinely separate follow-on work has nowhere to go
on the Orchestration tab, and finishing its parent quietly files it as
done.

Hit for real on `feat-file-explorer-integration.md`: its checklist was
complete, but it carried two nested tasks
(`feat-files-tree-session-lens.md`, `feat-session-tab-changes-chip.md`),
both unstarted and both explicitly gated on that card landing. Marking
the parent Done would have moved all three into `plans/done/`.

What is actually true today, so this isn't re-derived:

- `availableCards` (and the MCP's `unplacedCards`) filter nested children
  out — the plan is the unit of placement, on purpose.
- A human CAN still place one from the child's own card menu, and
  `nested-with-parent` then raises a conflict telling them to take one of
  the two off a rail.
- `effectiveStatus` makes a nested child's status its parent's, so a
  child cannot be completed, or even started, independently.
- The deletion path has a cascade plan (`deletionPlanFor`) that says what
  a delete will take with it. The **status** path has no equivalent: a
  drag to Done, or a `gavin_set_plan_field`, sweeps every nested child
  into `plans/done/` with no warning and nothing to say they were
  unfinished.

So there are two questions tangled together, and it is worth deciding
whether they are one problem or two:

1. **Sequencing.** Is a nested child ever a unit a rail should carry —
   and if not, how does dependent follow-on work get expressed instead?
   The existing escape is to give the child a `status:`, which un-nests
   it into a free-standing card that keeps the parent link. That may
   already be the right answer, in which case the gap is that nothing
   tells the human it exists at the moment they need it.

2. **Completion.** A parent should not be able to reach Done while
   carrying unfinished children without saying so. The deletion cascade
   is the shape to copy.

Do not just widen `availableCards` — the nested children were pulled out
of the drawer deliberately (a plan and all its children listed as peers
was the noise that change removed), and `nested-with-parent` exists
because placing both double-runs the work.

## Decided

One problem, one mechanism. Nesting is a claim that the child finishes
when the parent does; both symptoms are the same bug, which is that
nothing ever states the claim, so nobody notices when it stops being
true.

The escape already exists and is one write: "Move to <column>" on the
child (`cardMenu.ts`) gives it a `status:`, which un-nests it into that
column **and keeps the `parent:` link** — unlike "Un-parent", which
throws the relationship away. So do not widen `availableCards` and do not
invent a second relation. Surface that one gesture at the three moments a
human needs it: when the parent is about to be filed, when they are
looking at the children, and when the conflict box is already talking
about the pair.

Break-out lands the child in the board's **first** column (lowest
`position`). Both real children say they are unstarted follow-on work;
claiming In Progress by inheriting the parent's old column would lie.

The prompt fires on the board's terminal column, and its default is
today's behaviour — the children travel. It exists to make the sweep
loud, not to reverse it; the tick-box is the escape.

- [x] `cardCompletion.ts`, the pure module with unit tests:
      `completionCascadeFor(card, targetStatus, columns)` answering null
      unless the card is a plan with nested children whose target is the
      done column it is not already in, `firstColumnOf` next to
      `doneColumnOf` (one place decides which column is which), and the
      prompt's title/lines. `plans/done/` is a SLUG rule daemon-side
      (`is_done_status`), so a board whose last column is "Shipped" gets
      the warning without the line about the folder.
- [x] `guardCompletionCascade` — the write side, `askConfirmChecked` so
      one prompt carries both answers (dialog.ts's `ConfirmCheck` is
      exactly this case). Ticked: write each child the first column's
      name, then proceed. Tests drive it with `./dialog` mocked.
- [x] Wire every human gesture that can file a plan: the board drag
      (`planCommitFromMerged`, ahead of `dropHold` so the card is not
      held under the prompt), `cardMenu`'s "Move to", the detail modal's
      status select (revert the select on cancel), and the rail header's
      "Move all to…" (`moveRailCardsAction`, whose cards are `CardEntry`
      and need the nesting rule from `orchestration.ts`).
- [x] Column delete: `executeMoveCards` relocates a column into another,
      so add the travelling children as a consequence LINE in
      `KanbanColumn.svelte`'s existing prompt — a second dialog on top of
      that one is how a human learns to dismiss both.
- [x] The detail modal's Tasks list says the rule in one line and gives
      each nested child a "Break out" button beside "Un-parent".
- [x] `nested-with-parent` gains a "Break out" repair in
      `OrchestrationConflicts.svelte`, the way `same-worktree` has "Run
      in sequence".
- [x] `gavin-mcp`: `gavin_set_plan_field`'s description says nested
      children travel, and the reply after a move into `done/` names the
      ones that went with it. No protocol change — the MCP scans the tree
      it already knows how to scan.
- [x] Suites green — `cargo test --workspace`, and in `app/`: `npm test
      && npm run check && npm run build`.
- [x] Smoke passes in `smokeChecklist.ts`: the drag-to-Done prompt with
      the box left alone and with it ticked, and the conflict repair.
