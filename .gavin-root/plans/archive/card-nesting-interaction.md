---
order: 1024
title: Card nesting interaction (plan 2/3)
status: Done
priority: high
---
# Card nesting interaction (plan 2/3)

Nest drag targets, promote (daemon + MCP + UI), live checklist toggling,
un-parent. Protocol v4.

- Spec: docs/superpowers/specs/2026-08-20-kanban-card-model-design.md
- Plan: docs/superpowers/plans/2026-08-20-card-nesting-interaction.md (7 tasks)

**All 7 tasks shipped and committed 2026-08-20.** Everything that can be
verified without a person is verified. What is left is one ~10-minute pass with
a mouse — the checklist below.

**The blocker is gone (2026-08-24, pass 3).** These items were stuck since
2026-08-20 on "the app runs a daemon older than this tree, and restarting it
would kill seven live agent sessions". The running daemon is now **v13**, nine
versions past this plan's v4 surface, so it serves every nesting op the pass
needs. **No restart required.**

## The pass

Seed a throwaway workspace, open it in gavin, and work the list. Full steps and
their ✅ assertions: `test-fixtures/card-nesting/GUI-PASS.md`.

```sh
python3 test-fixtures/card-nesting/seed_gui_fixture.py         # seed
python3 test-fixtures/card-nesting/seed_gui_fixture.py --show  # what hit disk
```

- [ ] `nest-drag-in` — task onto a plan's middle band: auto-expands, placeholder inside, none in any column, no flash on drop
- [ ] Escape mid-nest-drag cancels cleanly, nothing left stuck expanded
- [ ] `nest-note-refuses` — a note and a second plan both refuse; the middle band stays a plain column slot for them
- [ ] `nest-drag-out` — drag a nested child to a column: it frees, parent chip persists
- [ ] `checklist-toggle` — a tick rewrites only that line; the drift case surfaces "File changed — checklist re-read, try again."
- [ ] `promote-ui` — Promote turns the item into a link and the child appears nested, no manual refresh
- [ ] `unparent` — Un-parent in the children list lands the card in the first column

Then `rm -rf ~/gavin-nesting-gui-fixture`, close the fixture workspace, tick the
matching items in the in-app smoke checklist, and set this card **Done**.

## Already verified — nothing to redo

- `promote-mcp` — **fully verified end to end**, both halves. `tools/list`
  carries `gavin_promote_task` with this plan's exact description and a
  `{plan_path, item}` schema, and a real `tools/call` created the nested task
  and rewrote the line to a link.
- Every **file effect** behind the drag and modal items — `parent:` written and
  `status:` removed, `status:` written and `parent:` retained, un-parent,
  promotion, checklist tick/untick with indentation preserved, and a drifted
  edit refused **writing nothing**. `test-fixtures/card-nesting/nesting_smoke.py`
  — **28/28**, run against a v13 daemon.
- Gates, on the shared tree as the app is actually running it: nest suites
  **58/58**, `cargo test -p gavin-daemon checklist` **6/6**, `svelte-check`
  **0 errors / 28 warnings, none in kanban**. At HEAD in a detached worktree
  (pass 2): cargo **312/0**, vitest **1128 / 66 files**, `vite build` ✓.

The pointer half cannot be automated, and this was re-checked rather than
assumed: `backend.ts` routes every board call through Tauri `invoke`, so the dev
server's page renders an empty board in a normal browser — there is nothing to
drag. The rules underneath are unit-covered; what needs eyes is the wiring.
