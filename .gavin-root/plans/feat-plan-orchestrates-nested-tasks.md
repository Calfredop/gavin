---
complexity: complex
title: [feat] starting a plan runs its nested tasks as their own sessions
status: In Progress
---
Starting a plan that has nested tasks should orchestrate them: each nested
task runs in its own session, rather than the plan's session doing that
work itself.

## Decided (interview 2026-10-29)

- **Opt-in** with `children: sequence | parallel` in the plan's frontmatter;
  absent = today's behaviour exactly.
- **The rail scheduler expands** an opted-in plan's card step: each nested
  task runs as a card run (in child order, or all at once), then the plan's
  own session with a "your nested tasks are finished; integrate, verify, set
  Done" prompt. The step is done when the plan reaches Done.
- **Board Run** on an opted-in plan puts it on a rail of its own (named after
  the plan, the plan as its one step) and starts it, reusing that rail if it
  exists.
- **A child is finished when its link `- [x] [title](./child.md)` in the plan
  is ticked** (ADR 0012). It never gains a status and stays nested
  throughout. A child with no link line gets one appended at start; its
  agent ticks its own line with the new `gavin_tick_item` and never writes
  its status.
- **Every child runs in the plan's checkout.** Worktree-per-child is a
  separate follow-up card.
- **A stalled child stalls the plan's step** ("nested task `x.md` stalled:
  …"). Resume continues that child's conversation, and auto-resume applies
  when the rail allows it. Ticked children never re-run; Mark done skips the
  rest.
- **A child placed as its own step** on any rail is skipped by the expansion,
  and `nested-with-parent` rises to `live` on an opted-in plan.
- **The Companion gets full parity.**
- Vocabulary: **Nested task**, **Orchestrated plan** in `CONTEXT.md`.

The nested tasks run in sequence, top to bottom; each needs the ones above it.

- [x] [[orch-nested] daemon: children: field, gavin_tick_item, nested-run rows](./orch-nested-01-daemon.md)
- [x] [[orch-nested] scheduler expands an orchestrated plan's step](./orch-nested-02-scheduler.md)
- [x] [[orch-nested] desk: Children toggle, nested run state on the plan's card](./orch-nested-03-desk-ui.md)
- [x] [[orch-nested] Companion parity for orchestrated plans](./orch-nested-04-companion.md)
- [x] [[orch-nested] skills: develop proposes children:, agents tick their line](./orch-nested-05-skills.md)
- [x] All five nested tasks finished, and `cargo test --workspace`, `npm test && npm run check`, and the companion suites green together in one detached worktree.
  2026-10-29, detached worktree at HEAD + this work's 68 files: every crate green (the daemon's under a temp `$HOME`, its three `$HOME`-bound tests under the real one); app 8422 tests, check 0 errors, build; Companion 933 tests, check 0 errors, build.
- [x] End to end in an isolated daemon (temp `$HOME`): a plan with `children: sequence` and two trivial children runs child 1, then child 2, then the plan's session; each child's link ends ticked, no child ever gains a `status:`, and the plan ends Done.
  2026-10-29: daemon and gavin-mcp from that worktree, `HOME=/tmp/gve2e`. A driver ran the real `nextActions` and made the executor's writes over the socket; each child was a session that called the real gavin-mcp (`gavin_tick_item`), the plan's session `gavin_set_plan_field(status, Done)`. Order: begin, one launched, one ticked, two launched (its missing line appended at begin), two ticked, plan launched, step done, rail complete. Neither child ever had a `status:`; all three filed under `done/`. The desk executor itself is covered by the unit suites; the running app is the Human test below.
- [ ] Human test: in the running app, Run a plan carrying `children: sequence` and two small nested tasks — each child opens as its own tab on the plan's rail page, the plan's card shows each child's run state while staying one card, and the plan's session starts only after both children are ticked.
- [ ] Human test: on a real phone, open that plan's card — each child shows running / done / stalled, and switching its Children toggle between off, sequence and parallel writes the plan's frontmatter on the desk.

## Background (what happened before, 2026-10-29)

- Run / a rail step launched ONE agent with `DEFAULT_RUN_PLAN`
  (`app/src/lib/agents/actionPromptDefaults.ts`), whose prompt never
  mentions nested children.
- A promoted child shows up as a `- [ ] [item](./child.md)` link, so the
  plan agent usually did it inline; a child made with `parent:` alone is not
  referenced by the plan file at all.
- Running a child by hand writes `In Progress`, which un-nests it
  (`cardRunActions.ts`).
- On a rail, nested children ride inside the plan's step as display only
  (`availableCards` filters them out; `nested-with-parent` warns if one is
  placed separately). A step finishes on its card reaching the done column
  (spec O6), which a nested child never can on its own — hence ADR 0012.
