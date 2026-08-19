# Kanban Trello-Quality Rework — Design Spec

A focused improvement session on the kanban board (hub `KanbanBoard` + per-context
`BoardPane`). Brief: `docs/superpowers/briefs/2026-08-19-kanban-trello-brief.md`.
Session decisions (K1–K8) live in
`docs/superpowers/brainstorms/2026-08-19-kanban-trello-brainstorm.md`. Phase
constraints still govern: files are truth (D2), column ↔ status by name (D6),
per-session boards are projections (D7, D14–D17).

**Goal:** Trello-grade drag interaction (floating tilted preview, real placeholder
gap, FLIP reflow, auto-scroll, click-vs-drag threshold), manual ordering of plan
cards via a new `order:` frontmatter field, the nine confirmed defects fixed, and
both board surfaces rendering through one component.

**Out of scope (deferred, K8):** keyboard-accessible card *moves* (a11y warnings
are still fixed — cards become focusable and open with Enter); interleaving plan
cards with free-form cards in one sequence; fractional ranks for free-form cards;
any change to free-form persistence (SQLite `setBoard`) semantics.

---

## 1. Pointer-drag engine (K1)

HTML5 drag-and-drop leaves the kanban surfaces entirely. A new engine:

- **`app/src/lib/pointerDrag.ts`** — pure math, no DOM types beyond rect shapes,
  fully vitest-covered: activation threshold, hit-testing, auto-scroll zones.
- **A drag-state store** (writable in the same module or a sibling): at most one
  active drag app-wide — `{ kind: "card" | "plan" | "column", id, sourceColumnId,
  target: { columnId, index } | null, pointer, grabOffset, previewSize }`.
- **Thin component glue**: `onpointerdown/move/up` handlers + rect measurement in
  `KanbanColumn` / `KanbanBoard`; no logic in components beyond measuring and
  calling the pure functions.

**Lifecycle.** `pointerdown` on a card records a candidate only. Movement past a
~5px threshold activates the drag: `setPointerCapture`, floating preview, source
card hidden. If `pointerup` arrives below threshold it is a click → opens the
detail modal (defect 3 fixed by construction). `Escape` cancels an active drag
and restores the source position. Pointer capture means no dragleave/dragenter
edge cases.

**Hit-testing contract.** Per move, `computeDropTarget(pointer, columnRects,
cardRectsByColumn, dragged)` returns `{ columnId, index } | null`, where `index`
is computed against the visual list **without the dragged card** (it is hidden
during the drag). That is exactly the post-removal index `moveCard` /
`reorderColumn`'s remove-then-insert expects — the off-by-one class (defects 1–2)
is eliminated by construction, not by caller-side adjustment. Kind-aware
slotting: a `card` drag targets slots in the free-form block, a `plan` drag slots
in the plan block (K4), a `column` drag targets column midpoints. A drag over an
auto column: `plan` → that auto column (status only for cross-column, order
within it per §2); `card`/`column` → no target.

**Live preview.** The target renders as a real placeholder gap (an empty slot
sized like the dragged card) at the computed index. Card lists and the column
strip use keyed `{#each}` + `animate:flip` (svelte/animate, zero deps), so
neighbors slide smoothly as the target moves.

**Floating preview.** One fixed-position, `pointer-events: none` layer rendered
by the board root, containing a re-render of the dragged card component at the
grabbed size, translated to pointer − grabOffset, tilted ~3° with a drop shadow
(K2). On release it animates briefly to the target slot's rect, then the real
card takes over (drop-settle).

**Auto-scroll.** While a drag is active, an rAF loop scrolls a column's card list
(vertical) or the board strip (horizontal) when the pointer is within an edge
zone (~40px); zone→velocity is a pure function. Rects are re-measured after
scroll frames.

**HTML5 exit + ripple.** `kanban-card`, `kanban-column`, `plan-card` leave the
`DragPayload` union in `dragDrop.ts`; the now-dead exclusion guards in
`Sidebar.svelte` (and any in `Pane.svelte`) are removed — `svelte-check` enforces
the ripple. Cards/columns lose `draggable`, which also removes the
double-payload latent bug (defect 5). Workspace/page/pane/tab dragging is
untouched.

## 2. Plan-card manual ordering — `order:` frontmatter (K3, K4)

**Format.** Optional integer field, e.g. `order: 1024`. Plan-card sort key
everywhere becomes **(order ?? +∞, contextFolder, fileName)** — ordered cards
first, unordered cards keep today's deterministic tail. Non-integer `order:`
sets `parseWarning` and counts as absent (same precedent as a typo'd priority).

**Write scheme.** New pure module **`app/src/lib/planOrder.ts`**:
`computeOrderWrites(planCardsInTargetColumn, targetIndex, draggedId)` →
`Array<{ path, order }>`:

- Both neighbors ordered, gap ≥ 2 → one write: the integer midpoint.
- Gap exhausted, or a needed neighbor unordered → renumber the block: dragged
  card slotted at `targetIndex`, all cards spaced 1024 from 1024. Plan columns
  are small; a handful of surgical writes is fine.
- First-ever ordering in a column therefore materializes the block once; the
  steady state is one write per drop.

**Drop semantics.** Same-column positional drop of a plan card → order writes
only. Cross-column → `status:` write **first**, then order writes. Every write
goes through the existing byte-preserving `setPlanFrontmatterField`;
`patchPlanField` applies per field **only after that field's write resolves**
(the optimistic-patch contract holds). A failure mid-batch: stop, show the
existing error strip naming the file; the ~2.5s watcher push reconciles whatever
landed.

**Daemon.** `gavin::set_plan_field`'s allow-list gains `"order"`, validated as an
i64 (the allow-list stays an allow-list). `plan_file_info` parses `order` into
`PlanFileInfo.order: Option<i64>` (invalid → `parse_warning`, order absent) →
protocol struct → TS `PlanFileInfo.order: number | null` → `patchPlanField`
accepts `"order"` with a numeric value. The MCP `gavin_set_plan_field` tool
inherits the field through the same function.

**Two surfaces, one truth.** Order values are global per file; both surfaces
sort by the same key, so the relative order of any two cards agrees everywhere.
A midpoint computed in the filtered `BoardPane` may interleave with other
contexts' cards on the hub board — pairwise consistency still holds.

## 3. State layer (defects 6, 7 — K6)

**Save failures.** `mutateAndPersist` wraps `setBoard` in try/catch: on failure
the store **rolls back** to the pre-mutation board and a per-workspace,
dismissible "Couldn't save: …" banner shows on the board (reusing the plan-error
strip styling; distinct from the load-failure overlay). No unhandled rejections;
callers keep their `void action(...)` shape.

**Staleness.** `fetchBoard` keeps its warm-cache behavior, plus a
`refreshBoard(workspaceId)` that refetches and replaces — called on window focus
and when a board surface mounts/becomes visible — **skipped while any mutation
for that workspace is in flight** so optimistic state is never clobbered.

## 4. One rendering path (defect 8 — K5)

`BoardPane` drops its hand-rolled column markup and renders **`KanbanColumn`
with a `planOnly` mode**: no free-form cards, no add-card composer, read-only
header (its exact current feature set). Auto columns become a shared rendering
(today they are duplicated in `KanbanBoard` and `BoardPane`). Every drag and
polish behavior is built once and works identically on both surfaces.

## 5. Correctness contracts + a11y (defects 1, 2, 5, 9)

`moveCard` / `reorderColumn` keep remove-then-insert semantics; their doc
comments state the contract (**"targetIndex is post-removal"**) and regression
tests pin the worked `[A,B,C]` example from the brief. The engine supplies
post-removal indices by construction (§1). The eight svelte-check warnings are
fixed for real: cards are focusable (`role="button"`, `tabindex="0"`,
Enter/Space opens), the column-rename span becomes a real button styled as text.

## 6. Polish (K2, K7)

- **Inline composers:** "+ Add card" / "+ Add column" open an in-place input —
  Enter commits, Esc or empty cancels; no more literal "New card"/"New column".
- **Hover affordances:** card delete buttons visible on hover/focus-within only.
- **Column counts:** header shows the column's card count (free-form + plan).
- **Drop-settle:** preview animates to its slot on release (§1).
- Smooth, non-jumpy layout: placeholder keeps column heights stable; flip
  animations cover reflow.

## 7. Verification

- **vitest (pure modules):** `pointerDrag` (threshold, hit-testing over
  synthetic rects incl. kind-aware slotting and post-removal indices,
  auto-scroll zones), `planOrder` (midpoint, renumber, materialize),
  `planBoard` (sort with `order`), `kanban.ts` regressions.
- **cargo test:** order parse (valid/invalid/absent), allow-list accept/reject,
  byte-preserving `order:` line writes.
- **`npx svelte-check`:** stays at 0 errors; the a11y warning count drops by 8;
  the dragDrop kind-removal ripple must compile clean.
- **Manual:** Smoke Test workspace pass; `smokeChecklist.ts` and
  `test-fixtures/gavin-orchestration/README.md` updated for the new
  interactions (drag threshold, placeholder, plan reorder, composers,
  auto-scroll, save-failure banner).
