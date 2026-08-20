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
