# Kanban Trello-quality rework — session log (2026-08-19)

Focused improvement session on the kanban board, from
`docs/superpowers/briefs/2026-08-19-kanban-trello-brief.md`. Decisions are
numbered K1… to keep them distinct from the phase log's D-sequence
(`2026-08-06-agent-orchestration-brainstorm.md`), which still governs.

## Decisions

- **K1 (2026-08-19):** **Hand-rolled pointer-event drag engine** (recommended,
  approved) over fixing HTML5 DnD or adopting `svelte-dnd-action`. Rationale:
  kanban drag kinds are never consumed outside the board surfaces (Sidebar/Pane
  only exclude them), Svelte 5's built-in `animate:flip` provides FLIP reflow
  with zero deps, and all index/hit-test math lands in pure `.ts` modules — the
  repo's only real verification lever since components can't be unit-tested.
  HTML5 DnD kinds (`kanban-card`/`kanban-column`/`plan-card`) are removed from
  `dragDrop.ts` and dead guards cleaned up.
- **K2 (2026-08-19):** **Full polish scope approved:** auto-scroll at edges,
  inline composers, hover affordances + column counts, **plus** (owner
  addition) rich animations and a Trello-style **tilt on the dragged card**.
- **K3 (2026-08-19):** **Manual plan-card ordering IS in scope** (user override
  of the defer recommendation): new integer `order:` frontmatter field, written
  through the existing surgical field writer; daemon allow-list gains `"order"`
  with i64 validation; sort key (order ?? +∞, contextFolder, fileName).
- **K4 (2026-08-19):** **Plan cards stay their own orderable block** after the
  free-form cards (recommended, approved) — no interleaving with free-form
  cards this session; that would force fractional ranks onto the SQLite
  position model. Interleave remains possible later without wasted work.
- **K5 (2026-08-19):** **BoardPane reuses KanbanColumn** via a `planOnly` mode;
  auto-column rendering also shared. One rendering path, both surfaces.
- **K6 (2026-08-19):** **Persist failures roll back + banner; staleness fixed
  by focus/visibility refetch** guarded against in-flight mutations.
- **K7 (2026-08-19):** **Index contract pinned:** `moveCard`/`reorderColumn`
  keep remove-then-insert; the engine supplies post-removal indices by
  construction; regression tests pin the brief's `[A,B,C]` worked example.
- **K8 (2026-08-19):** **Deferred:** keyboard-accessible card moves (the eight
  a11y warnings still get fixed — focusable cards, Enter opens), free-form
  fractional ranks, plan/free-form interleaving.

## Incidents

- Concurrent session detected in the same working tree during brainstorming
  (`app/package.json` gained CodeMirror deps — sub-4 file viewer work). This
  session adds no dependencies and its file set barely overlaps; flagged at the
  spec review gate.
