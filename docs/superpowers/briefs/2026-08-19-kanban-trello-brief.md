# Session brief: make the kanban board Trello-quality

You are picking up a focused improvement session on **gavin**'s kanban board. The
board works but feels glitchy, and the interaction model is far below the Trello
bar the owner wants. Your job: diagnose properly, redesign the interaction, and
ship it — without breaking the file-backed semantics the rest of the platform
depends on.

**Follow the superpowers workflow**: this is a redesign, so brainstorm →
spec → plan → execute. Use `superpowers:systematic-debugging` for the defect
list below (root cause before fixes; several already have confirmed root
causes, listed here as evidence, not as instructions to patch blindly).

---

## 1. Where the board lives

| File | Lines | Responsibility |
|---|---|---|
| `app/src/lib/KanbanBoard.svelte` | 226 | Hub board: columns, auto columns, plan/free-form merge, modals, error strip |
| `app/src/lib/KanbanColumn.svelte` | 249 | One column: header/rename/delete, card list, all card + column drop handling |
| `app/src/lib/KanbanCard.svelte` | 146 | Free-form card (SQLite-backed) |
| `app/src/lib/PlanKanbanCard.svelte` | 96 | Plan card (file-backed, dashed styling) |
| `app/src/lib/BoardPane.svelte` | 204 | Per-context board opened beside a terminal — **re-implements column rendering** |
| `app/src/lib/kanban.ts` | 203 | Pure board mutations (addCard, moveCard, reorderColumn, …) — fully unit-tested |
| `app/src/lib/kanbanState.ts` | 133 | Store + actions; every mutation persists the WHOLE board via `setBoard` |
| `app/src/lib/planBoard.ts` | 126 | Pure projection of plan files into display columns (`mergePlanCards`, `slugStatus`) |
| `app/src/lib/dragDrop.ts` | 86 | App-wide drag payload union + helpers (shared with sidebar and panes) |
| `CardDetailModal.svelte` / `PlanDetailModal.svelte` | 234 / 120 | Card detail editors |

Daemon side (only relevant if you change persistence): `crates/daemon/src/kanban.rs`
(SQLite), `crates/daemon/src/gavin.rs` (`set_plan_field` — the surgical
frontmatter writer).

## 2. Confirmed defects (evidence-backed, verify before fixing)

1. **Off-by-one on same-list downward moves.** `moveCard` and `reorderColumn`
   (`kanban.ts`) both *remove* the item, then insert at an index the caller
   computed against the **pre-removal** array. Worked example: cards `[A,B,C]`,
   drag `A` and drop it *before* `C` → caller passes index 2 → after removal the
   list is `[B,C]` → insert at 2 → `[B,C,A]`. The card lands *after* `C`, not
   before it. Upward moves are correct, so the behaviour is asymmetric — a
   classic source of "it doesn't go where I dropped it".
2. **Column reorder has no before/after notion at all.** `KanbanColumn.svelte`'s
   `handleColumnDrop` passes the hovered column's `position` verbatim, so where a
   column lands flips depending on drag direction (see defect 1).
3. **Click fires after drag.** Both card components are `draggable="true"` *and*
   carry `onclick={onOpen}` with no drag-guard, so finishing a drag frequently
   opens the detail modal. (`KanbanCard.svelte:44`, `PlanKanbanCard.svelte:17`.)
4. **Zero drop feedback.** No placeholder, no insertion line, no drag-ghost
   styling anywhere in the kanban components — you cannot see where a card will
   land. `Pane.svelte` already implements this pattern for terminal tabs
   (`tabReorderState` + `.drop-before` / `.drop-after` CSS); copy its approach or
   replace it with something better.
5. **Card dragstart doesn't stop propagation.** The card's `dragstart` bubbles to
   the column's own `dragstart`, so a single drag attaches *two* payload types to
   the same `dataTransfer`. `getDragKind` currently masks it (it checks
   `kanban-card` before `kanban-column`), but it is latent breakage — `Pane.svelte`
   hit this exact bug with tabs vs panes and fixed it with `stopPropagation`.
6. **Persist failures are silent.** `kanbanState.mutateAndPersist` has no
   try/catch and every caller does `void someAction(...)`, so a failed
   `setBoard` leaves optimistic UI diverged from SQLite plus an unhandled
   rejection. Compare `layoutState.persistWorkspaces`, which surfaces errors.
7. **The board never refreshes.** `fetchBoard` early-returns whenever the
   workspace key is already in the store, so the SQLite board is read exactly
   once per app run; only `retryFetchBoard` clears it. Plan cards *do* update
   live (watcher pushes), which makes the staleness of free-form cards feel
   arbitrary.
8. **Rendering is duplicated.** `BoardPane.svelte` re-implements columns instead
   of reusing `KanbanColumn`, so every polish item must be built twice or the two
   surfaces drift. Consolidating first will likely pay for itself.
9. **Eight a11y/type warnings** sit in kanban files (`role="button"` divs with no
   keyboard handlers, etc.). `npx svelte-check` lists them; the repo is otherwise
   at 0 errors and should stay there.

## 3. The Trello bar (what "not glitchy" means here)

Discuss and prioritise with the owner — do not assume all of it is in scope:

- Drag with a floating card preview, a real placeholder gap, and animated
  reflow (FLIP-style), instead of the browser's default HTML5 ghost.
- Insertion indicator that always matches where the card will land.
- Auto-scroll when dragging near a board/column edge.
- Inline composers: "+ Add card" opens a title field in place (today it
  immediately creates a card literally titled "New card"; same for columns).
- Click vs drag disambiguation (movement threshold), so opening a card is
  deliberate.
- Card affordances on hover; column card counts; smooth, non-jumpy layout.
- Optional, needs a decision: keyboard-accessible moves.

**Key architecture question to settle in the brainstorm:** HTML5 drag-and-drop
(current) cannot produce Trello-grade feel. Three options — (a) stay on HTML5 DnD
and only fix correctness + indicators, (b) hand-roll pointer-event dragging in a
reusable module (matches this codebase's zero-dependency instincts, more work),
(c) adopt `svelte-dnd-action` (the one realistic dependency; it brings FLIP
animation and accessible dragging). Present the trade-offs and let the owner
choose.

## 4. Hard constraints — do not break these

- **Files are truth.** Plan cards are a *projection* of `.gavin*/plans/*.md`
  frontmatter. Dragging one writes only its `status:` line through
  `SetPlanFrontmatterField` → `gavin::set_plan_field`, which is byte-preserving.
  Never write a plan card's position to SQLite.
- **Plan-card ordering is deterministic** (by context folder, then filename) and
  drop *index* is intentionally ignored for plan cards. Trello-style manual
  ordering of plan cards would need a new frontmatter field (e.g. `order:`) —
  that is a design decision to raise explicitly, not to sneak in.
- **The optimistic-patch dance is deliberate.** After a successful write,
  `patchPlanField` updates `gavinTrees` immediately because the confirming
  watcher push takes ~2.5 s (500 ms debounce + 2 s rescan floor). Patch only on
  success; never before the write resolves.
- **Column names are the status vocabulary** (slug-insensitive matching in
  `planBoard.slugStatus`). Renaming a column does *not* rewrite plan files —
  know this before touching rename.
- **`dragDrop.ts` payload kinds are app-wide.** Adding or renaming a kind ripples
  into `Sidebar.svelte` and `Pane.svelte` exclusion guards; a previous change
  broke sidebar narrowing exactly this way. `npx svelte-check` catches it.
- **No Svelte component tests.** This repo's vitest setup cannot preprocess
  `.svelte` files (a test that merely *imports* a component fails at collection).
  Therefore: **put all drag/index math in pure `.ts` modules and test it there** —
  that is the main lever for making this work verifiable. Component behaviour is
  covered by the manual checklist only.
- **Two surfaces, one behaviour:** the hub board and the per-context `BoardPane`
  must stay consistent.

## 5. How to run and verify

```bash
# app (from app/):   npm run tauri dev        <- note the word order
cargo test                 # 250 tests: daemon, app, protocol, gavin-mcp
cd app && npx vitest run   # 291 tests
cd app && npx svelte-check # must stay at 0 errors
```

Manual pass: the dev-only **Smoke Test** workspace has a *Seed demo data* button
(creates plan cards incl. an auto-column case and a ⚠ broken-frontmatter card)
and a **Checklist** tab. `test-fixtures/gavin-orchestration/README.md` has the
step-by-step version. If the app ever reports *"the gavin daemon is older than
this app"*, click **Restart daemon & retry** in the error overlay.

## 6. Working preferences (owner's standing choices)

- Works directly on `main`, no worktrees.
- **Inline execution** of plans (not subagent-driven) — this session has
  repeatedly hit the 200-subagent cap.
- Ask clarifying questions **one at a time**, with a recommended option.
- Commit per completed task; end messages with the project's `Co-Authored-By`
  trailer. Push only when asked.
- Keep decisions and incidents appended to
  `docs/superpowers/brainstorms/` session logs, following the existing style.

## 7. Context worth reading first

- `docs/superpowers/specs/2026-08-06-agent-orchestration-plans-kanban-design.md`
  — why plan cards project the way they do (D14–D17).
- `docs/superpowers/brainstorms/2026-08-06-agent-orchestration-brainstorm.md`
  — the whole phase's decision log (D1–D22).
- `app/src/lib/Pane.svelte` — the drag/drop and drop-indicator patterns that
  already work well in this codebase.
