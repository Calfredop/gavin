# Kanban card model — final form (session log, 2026-08-20)

Brainstorm for the board's real-world gavin integration: a card can be a
simple reminder, a single agent task (prompt), or a multi-task plan — one
ontology, fully integrated with the `.gavin*` md-file system. Decisions are
numbered C1… (this log); phase decisions D1–D34
(`2026-08-06-agent-orchestration-brainstorm.md`) still govern, and the
Trello-rework decisions K1–K8 (`2026-08-19-kanban-trello-brainstorm.md`)
provide the interaction engine this builds on.

## Decisions

- **C1 (2026-08-20):** **All cards are files** (recommended, approved — owner
  added: the column ref must live in the md file, which `status:` already is).
  One `.md` per card in `.gavin*/plans/`, `kind: note | task | plan` in
  frontmatter, kind absent = plan (full backward compatibility). SQLite keeps
  only columns, the label vocabulary (name + color), and runtime session
  bindings.
- **C2 (2026-08-20):** **Plans = body checklists + promotable child tasks**
  (recommended, approved — owner added: promoted task cards must be placeable
  INSIDE the plan card's context, with UI optimized for it). Child = own file
  with `parent: <file>` (same context, tasks only, no recursion). Nesting rule:
  a child with no `status:` renders nested inside its plan card; writing a
  status frees it into a column; the file alone tells the whole story.
- **C3 (2026-08-20):** **Run on tasks and plans** (recommended, approved —
  owner added: agents must be able to promote checklist items via MCP). Task
  body = the prompt; plan run = pointer prompt (read the file, execute, keep
  statuses current). App writes `status: In Progress` on launch; never
  auto-completes. Session bindings runtime-only (SQLite keyed by path); one
  live session per card. Notes are not runnable.
- **C4 (2026-08-20):** **Two-speed composer** (recommended, approved): Enter =
  note file in that column; kind chips (note · task · plan) expand the composer
  in place (prompt/body textarea + context picker). Promotion lives in the plan
  detail view. Agents create everything through `gavin_create_plan` extended
  with kind/parent.
- **C5 (2026-08-20):** **No migration — wipe** (owner override of the
  convert-flow recommendation: dev state, no release). SQLite card storage and
  the free-form card system are removed outright; the daemon drops the cards
  table. Label definitions stay in SQLite as the vocabulary; file cards
  reference them by name via `labels:` (slug-matched, like columns).

## Section approvals

All four design sections approved as presented (2026-08-20): card file
format; nesting-aware board + drag semantics; run contract + card_sessions +
MCP additions (`gavin_promote_task`, create_plan kind/parent, checkbox-only
progress); surfaces + verification + three-plan build order (card model core →
nesting interaction → run & bindings).

Spec: `docs/superpowers/specs/2026-08-20-kanban-card-model-design.md`.

## Execution notes — plan 1 (card model core, 2026-08-20)

- All 11 tasks executed inline on `main`. Tasks 1–5 (protocol v3 + daemon)
  folded into one commit as the plan anticipated: removing the Card types
  breaks crate-by-crate compilation until the wipe lands.
- Deviations, all safety-driven: nested children do NOT yet carry
  `data-kb-plan` wrappers (the glue would count them into the column's slot
  geometry and corrupt drag indices — plan 2 owns nested measurement); their
  presses stop propagation so a nested click can't drag/open the parent.
  "Open in Plans tab" gained a tiny `requestedExplorerPath` store so the
  explorer preselects the file (the alternative was landing on an unselected
  tree).
- The stale gavin-mcp session incident from plan-writing repeated as
  designed: this session's MCP shim predates v3; plan cards were authored as
  files directly (the gavin skill's documented fallback).
- Gates at completion: cargo 265, vitest 394 (+ new pure suites for
  cardCompose/planChecklist), svelte-check 0 errors / 0 kanban warnings,
  production build clean. Manual smoke (new "Card kinds" section) pending —
  requires a daemon restart to pick up protocol v3.

## Execution notes — plan 2 (nesting interaction, 2026-08-20)

- All 7 tasks executed inline. Tasks 1–4 folded into one commit (the
  DropTarget/DragKind signature change spans five modules coherently).
- Design deviations, logged: nest eligibility rides the MEASUREMENT (the
  glue emits nest info only for a task drag's same-context plans) instead of
  a `canNest` parameter — one source of truth, no controller plumbing.
  `ChecklistItem` gained `rawText` so the daemon validates toggles against
  the raw line bytes while the UI displays the link's inner text. The
  SKILL.md interim note was skipped — plan 3 rewrites the file wholesale.
- **Incident (verification):** a `head`-truncated cargo grep hid a failing
  gavin-mcp suite for one commit (the tools/list count assertion after
  adding gavin_promote_task). Caught by re-running with full output to a
  file; fixed (8 → 9). Lesson: pipe test output to a file and grep THAT —
  truncation can hide a failing suite between two passing ones.
- Gates at completion: cargo 270, vitest 401, svelte-check 0 errors / 0
  kanban warnings, build clean. Manual smoke ("Nesting & promotion"
  section) pending — needs a daemon restart (protocol v4).

## Execution notes — plan 3 (run & bindings, 2026-08-20)

- All 7 tasks executed inline. card_sessions ride the Board reply (protocol
  v5); the run flow reuses handleAgentSessionSpawned so app-run cards land
  under the exact D19 posture; prompt/command composition is pure and
  snapshot-tested (POSIX single-quoting included).
- BoardCard reads bindings/session status from the stores directly (the old
  KanbanCard precedent) with workspaceId/onRun optional so the drag preview
  stays inert. Running a nested task frees it (In Progress removes nesting) —
  deliberate, noted in code.
- The known flaky daemon socket test (attach_from_a_new_connection…) tripped
  once under parallel load and passed in isolation + a full re-run — same
  signature as the phase log's 2026-08-07 entry.
- Gates at completion: cargo 272, vitest 415, svelte-check 0 errors / 0
  kanban warnings, build clean.

**The card-model effort is code-complete across all three plans.** Remaining:
the human smoke passes (Card kinds · Nesting & promotion · Run & bindings
sections) — the running daemon must be restarted first (protocol v5), and
"Set up agent integration" re-run so the new SKILL.md lands in the repo.
