# Card Nesting Interaction Implementation Plan (2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nesting becomes interactive — task drags target plan interiors and nested areas, promotion and checklist toggling ship (daemon ops + MCP tool + detail-modal UI), un-parent works.

**Architecture:** `pointerDrag` gains nest targets (pure, tested); `planDrop` learns nest/free commit rules; the daemon gains `SetChecklistItem`/`PromoteChecklistItem` (byte-surgical, validated); the modal's checklist becomes live. Builds strictly on plan 1's interfaces (`CardView`, `planChecklist.ts`, `BoardCard`). Protocol bumps to 4.

**Tech Stack:** Rust daemon, Svelte 5, TypeScript, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-20-kanban-card-model-design.md` §2 (interaction), §3 (checklist + promote), §6 plan 2.

## Global Constraints

Same as plan 1 (zero deps; files are truth; patch-on-success; svelte-check 0 errors / 0 kanban warnings; main; commit per task with the trailer; no push). Prerequisite: plan 1 landed.

---

### Task 1: pointerDrag — nest targets

**Files:**
- Modify: `app/src/lib/pointerDrag.ts` (+ test)

**Interfaces (produces):**

```typescript
// DropTarget gains an optional nest discriminator:
export interface DropTarget { columnId: string; index: number; nest?: string }
// nest = the receiving plan card's path; index = slot among its nested
// children; columnId = the plan's column key (placeholder scoping).

// MeasuredColumn: `cards` is REMOVED (free-form died in plan 1; the dead
// "card" drag kind goes with it -- dragKind param drops entirely, every
// card drag is the former "plan" path). planCards entries become:
export interface MeasuredCard extends Measured {
  nest?: { rect: Rect; children: Measured[] } | null; // plan cards while a task drags
}
export function computeDropTarget(pointer, columns, canNest: boolean, maxSnapPx?): DropTarget | null
```

Rules: with `canNest`, a pointer inside a plan card's **middle band** (between 25% and 75% of its height) targets `{ nest: planId, index: <slot among nest.children midpoints, 0 when collapsed> }`; the outer bands keep meaning before/after in the column; inside an expanded `nest.rect`, child midpoints pick the slot. Without `canNest` (dragging a note/plan), plan cards behave as plain slot geometry.

- [ ] **Step 1: Failing tests:** middle band nests / edge bands slot the column; collapsed plan → nest index 0; expanded plan → index by child midpoints; canNest false → never nests; column with no plans unchanged; existing slot/auto-column/threshold tests still pass after the `cards` removal (delete the dead free-form cases).
- [ ] **Step 2:** FAIL → implement → PASS (full vitest). **Step 3:** Commit — `feat(app): nest-aware drop targets` + the trailer.

---

### Task 2: kanbanDrag — nested slots + no-op rules

**Files:**
- Modify: `app/src/lib/kanbanDrag.ts` (+ test)

**Interfaces (produces):**

```typescript
// beginCandidate gains `canNest: boolean` (glue passes kind === "task");
// controller threads it into computeDropTarget. ActiveDrag/DropHold target
// carries nest. New builder for the nested area:
export function buildNestedSlots<T>(children: T[], idOf: (t: T) => string,
  drag: DropHold | null, planId: string): Slot<T>[]
// buildDisplaySlots: when drag.target?.nest is set, NO placeholder in any
// column (the card is leaving column flow); dragged stays hidden.
```

No-op rule extension: a nest drop where the dragged card is already nested in that plan at that index → no commit. Column drags unaffected.

- [ ] **Step 1: Failing tests:** nested placeholder appears only in the matching plan's builder; column builders suppress placeholders during nest targeting; nest no-op detection (sourceColumnId compare doesn't apply — controller receives `sourceNest: string | null` + sourceIndex via beginCandidate, glue supplies it); commit fires with nest target. **Step 2:** implement → PASS. **Step 3:** Commit — `feat(app): nested display slots + nest no-op rules` + the trailer.

---

### Task 3: planDrop — nest/free commit rules

**Files:**
- Modify: `app/src/lib/planDrop.ts` (+ test)

**Interfaces (produces):** `planCommitFromMerged` resolves the dragged `CardView` by id across columns, auto columns, and nested children, then:

- **nest target:** write `parent: <plan fileName>` (skip when unchanged) → write `status` `""` (skip when already null) → order writes among that plan's `nestedChildren` (dragged excluded) via `computeOrderWrites`. Patch each on success (`parent`, `status` with `""` → patched to null, `order`).
- **column target:** as today, **plus**: when the dragged card's status is null (a nested child being freed), always write the column's name even into its parent's own column.
- Cross-context nesting attempts (plan in another context) are filtered out at the hit-test feed (glue only marks same-context plans nestable) — assert the commit guards anyway (returns an error string, no writes).

- [ ] **Step 1: Failing tests** (mocked backend, call-order assertions like the existing ones): nest writes parent+status-removal+order in order; unchanged-parent skips; freeing a nested child into the parent's column writes status; cross-context guard. **Step 2:** implement → PASS. **Step 3:** Commit — `feat(app): nest and free commit rules` + the trailer.

---

### Task 4: Glue + components — the interactive nested area

**Files:**
- Modify: `app/src/lib/kanbanDragGlue.ts`, `app/src/lib/BoardCard.svelte`, `app/src/lib/KanbanColumn.svelte`, `app/src/lib/AutoKanbanColumn.svelte`

- [ ] **Step 1:** Data contract: card wrappers gain `data-kb-kind={card.kind}`; BoardCard's nested area gets `data-kb-nest={card.id}` and each nested child its own `data-kb-plan` wrapper (established in plan 1) — measurement must attribute a `[data-kb-plan]` inside a `[data-kb-nest]` to that plan's `nest.children`, never to the column's top-level list. Glue: `canNest` = dragged wrapper's kind is `task` AND target plans share the dragged card's context (compare via a `data-kb-ctx` attribute on wrappers); `beginCandidate` passes canNest + sourceNest (closest `[data-kb-nest]` value or null).
- [ ] **Step 2:** BoardCard auto-expands while targeted: `expanded || $dragState?.target?.nest === card.id || $dropHold?.target?.nest === card.id`; nested area renders `buildNestedSlots` with placeholder (drop-hold keeps it during writes, same as columns). KanbanColumn/AutoKanbanColumn planSlots suppress placeholders per Task 2's rule automatically (builder change).
- [ ] **Step 3:** svelte-check 0 / vitest green; manual dev pass: drag a task over a plan → expands, placeholder inside; drop → `parent:` written, `status:` line gone (`cat`); drag nested child out to a column → `status:` written, chip persists; drop-hold shows no flash; Escape mid-nest-drag cancels cleanly; notes/plans refuse to nest.
- [ ] **Step 4:** Commit — `feat(app): interactive nesting on the board` + the trailer.

---

### Task 5: Daemon — checklist toggle + promote (protocol v4)

**Files:**
- Modify: `crates/protocol/src/lib.rs`, `crates/daemon/src/gavin.rs`, `crates/daemon/src/server.rs`

**Interfaces (produces):**

```rust
Request::SetChecklistItem { path, line_index: u32, expected_text: String, checked: bool }
Request::PromoteChecklistItem { plan_path, item: String }  -> Response::TaskPromoted { path }
pub fn set_checklist_item(path, line_index, expected_text, checked) -> Result<()>
pub fn promote_checklist_item(plan_path, item) -> Result<PathBuf>
```

`set_checklist_item`: the file's `line_index` line must match `^(\s*- \[)( |x)(\] )(.*)$` AND its text portion equal `expected_text` — else error ("changed on disk"); rewrite only the checkbox char, preserve everything else + trailing-newline rule. `promote_checklist_item`: find lines whose text equals `item` (trimmed) and which are NOT already links; 0 → "no such item", >1 → "ambiguous"; derive the context folder from the plan path (`…/<ctx>/.gavin*/plans/x.md`), slug the item (Rust port of `slugFileName` + `-2` collision suffix against the plans dir), `create_plan_file(ctx, file, item, None(status), None, Some(item), Some("task"), Some(plan_file_name))`, then rewrite the line to `- [<kept mark>] [<item>](./<file>)`. `PROTOCOL_VERSION` 3 → 4.

- [ ] **Step 1: Failing tests:** toggle both directions + indentation preserved + mismatch errors (index out of range, text drift, non-checkbox line); promote happy path (exact resulting file bytes + exact rewritten line), checked item keeps `[x]`, collision suffix, ambiguity + missing errors, no writes on error. Protocol roundtrips + version guard update.
- [ ] **Step 2:** implement → `cargo test` green. **Step 3:** Commit — `feat(daemon): validated checklist toggle + task promotion (v4)` + the trailer.

---

### Task 6: MCP tool, Tauri commands, live modal

**Files:**
- Modify: `crates/gavin-mcp/src/main.rs`, `app/src-tauri/src/session.rs` (or the file its kanban/gavin commands live in), `app/src/lib/backend.ts`, `app/src/lib/CardDetailModal.svelte`

- [ ] **Step 1:** MCP: `gavin_promote_task { plan_path, item }` → `PromoteChecklistItem`, description: "Promote a plan's checklist item into a nested task card (rewrites the item into a link)." Tauri commands `set_checklist_item`, `promote_checklist_item` + `backend.setChecklistItem/promoteChecklistItem`.
- [ ] **Step 2:** Modal: checklist checkboxes become real inputs — toggle calls `setChecklistItem` with the parsed `lineIndex`/`text`; on success re-read the file content (the modal already holds it); on the mismatch error, re-read and show "file changed — try again" inline. Unpromoted items get a Promote button → `promoteChecklistItem` → re-read + tree patch via the watcher (optimistic: `patchPlanCreated` with a synthesized child). Children list gains **Un-parent** → `set_plan_field(child, "parent", "")` + patch (child reappears in the first column per the no-status/no-parent rule).
- [ ] **Step 3:** svelte-check 0 / vitest green / cargo green; manual: tick under a concurrent agent edit (simulate: edit the file in a terminal mid-modal) surfaces the retry path; promote from the modal and from a real agent (`/mcp` session) both nest a child; un-parent lands the card in column one.
- [ ] **Step 4:** Commit — `feat(app): promotion + live checklist + un-parent` + the trailer.

---

### Task 7: Checklist, docs, sweep

- [ ] **Step 1:** Smoke section additions (`nest-drag-in`, `nest-drag-out`, `nest-autoexpand`, `promote-ui`, `promote-mcp`, `checklist-toggle`, `unparent`); fixture README gains a worked nesting walkthrough (seed plan + promote one seeded checklist item). `SKILL.md` note: promotion exists (full skill rewrite waits for plan 3).
- [ ] **Step 2:** Full gates (`cargo test`, vitest, svelte-check, build) + manual pass of the new items; append execution notes to the brainstorm log; set plan 2's gavin card Done.
- [ ] **Step 3:** Commit — `docs: nesting interaction checklist + execution log` + the trailer.
