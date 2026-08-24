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

- [x] **Step 1: Failing tests:** middle band nests / edge bands slot the column; collapsed plan → nest index 0; expanded plan → index by child midpoints; canNest false → never nests; column with no plans unchanged; existing slot/auto-column/threshold tests still pass after the `cards` removal (delete the dead free-form cases).
- [x] **Step 2:** FAIL → implement → PASS (full vitest). **Step 3:** Commit — `feat(app): nest-aware drop targets` + the trailer.

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

- [x] **Step 1: Failing tests:** nested placeholder appears only in the matching plan's builder; column builders suppress placeholders during nest targeting; nest no-op detection (sourceColumnId compare doesn't apply — controller receives `sourceNest: string | null` + sourceIndex via beginCandidate, glue supplies it); commit fires with nest target. **Step 2:** implement → PASS. **Step 3:** Commit — `feat(app): nested display slots + nest no-op rules` + the trailer.

---

### Task 3: planDrop — nest/free commit rules

**Files:**
- Modify: `app/src/lib/planDrop.ts` (+ test)

**Interfaces (produces):** `planCommitFromMerged` resolves the dragged `CardView` by id across columns, auto columns, and nested children, then:

- **nest target:** write `parent: <plan fileName>` (skip when unchanged) → write `status` `""` (skip when already null) → order writes among that plan's `nestedChildren` (dragged excluded) via `computeOrderWrites`. Patch each on success (`parent`, `status` with `""` → patched to null, `order`).
- **column target:** as today, **plus**: when the dragged card's status is null (a nested child being freed), always write the column's name even into its parent's own column.
- Cross-context nesting attempts (plan in another context) are filtered out at the hit-test feed (glue only marks same-context plans nestable) — assert the commit guards anyway (returns an error string, no writes).

- [x] **Step 1: Failing tests** (mocked backend, call-order assertions like the existing ones): nest writes parent+status-removal+order in order; unchanged-parent skips; freeing a nested child into the parent's column writes status; cross-context guard. **Step 2:** implement → PASS. **Step 3:** Commit — `feat(app): nest and free commit rules` + the trailer.

---

### Task 4: Glue + components — the interactive nested area

**Files:**
- Modify: `app/src/lib/kanbanDragGlue.ts`, `app/src/lib/BoardCard.svelte`, `app/src/lib/KanbanColumn.svelte`, `app/src/lib/AutoKanbanColumn.svelte`

- [x] **Step 1:** Data contract: card wrappers gain `data-kb-kind={card.kind}`; BoardCard's nested area gets `data-kb-nest={card.id}` and each nested child its own `data-kb-plan` wrapper (established in plan 1) — measurement must attribute a `[data-kb-plan]` inside a `[data-kb-nest]` to that plan's `nest.children`, never to the column's top-level list. Glue: `canNest` = dragged wrapper's kind is `task` AND target plans share the dragged card's context (compare via a `data-kb-ctx` attribute on wrappers); `beginCandidate` passes canNest + sourceNest (closest `[data-kb-nest]` value or null).
- [x] **Step 2:** BoardCard auto-expands while targeted: `expanded || $dragState?.target?.nest === card.id || $dropHold?.target?.nest === card.id`; nested area renders `buildNestedSlots` with placeholder (drop-hold keeps it during writes, same as columns). KanbanColumn/AutoKanbanColumn planSlots suppress placeholders per Task 2's rule automatically (builder change).
- [ ] **Step 3:** _(gates ✅ re-run on the live tree 2026-08-24 pass 3; the pointer-drag half
  below is now unblocked and scripted — `test-fixtures/card-nesting/GUI-PASS.md`
  steps 1–4)_ svelte-check 0 / vitest green; manual dev pass: drag a task over a plan → expands, placeholder inside; drop → `parent:` written, `status:` line gone (`cat`); drag nested child out to a column → `status:` written, chip persists; drop-hold shows no flash; Escape mid-nest-drag cancels cleanly; notes/plans refuse to nest.
- [x] **Step 4:** Commit — `feat(app): interactive nesting on the board` + the trailer.

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

- [x] **Step 1: Failing tests:** toggle both directions + indentation preserved + mismatch errors (index out of range, text drift, non-checkbox line); promote happy path (exact resulting file bytes + exact rewritten line), checked item keeps `[x]`, collision suffix, ambiguity + missing errors, no writes on error. Protocol roundtrips + version guard update.
- [x] **Step 2:** implement → `cargo test` green. **Step 3:** Commit — `feat(daemon): validated checklist toggle + task promotion (v4)` + the trailer.

---

### Task 6: MCP tool, Tauri commands, live modal

**Files:**
- Modify: `crates/gavin-mcp/src/main.rs`, `app/src-tauri/src/session.rs` (or the file its kanban/gavin commands live in), `app/src/lib/backend.ts`, `app/src/lib/CardDetailModal.svelte`

- [x] **Step 1:** MCP: `gavin_promote_task { plan_path, item }` → `PromoteChecklistItem`, description: "Promote a plan's checklist item into a nested task card (rewrites the item into a link)." Tauri commands `set_checklist_item`, `promote_checklist_item` + `backend.setChecklistItem/promoteChecklistItem`.
- [x] **Step 2:** Modal: checklist checkboxes become real inputs — toggle calls `setChecklistItem` with the parsed `lineIndex`/`text`; on success re-read the file content (the modal already holds it); on the mismatch error, re-read and show "file changed — try again" inline. Unpromoted items get a Promote button → `promoteChecklistItem` → re-read + tree patch via the watcher (optimistic: `patchPlanCreated` with a synthesized child). Children list gains **Un-parent** → `set_plan_field(child, "parent", "")` + patch (child reappears in the first column per the no-status/no-parent rule).
- [ ] **Step 3:** _(gates ✅ and the `/mcp` promotion clause ✅; the modal clauses are
  scripted as `GUI-PASS.md` steps 5–7. The plan's own drift recipe — "edit the
  file in a terminal mid-modal" — does **not** reach the retry path: the modal
  watches its own file and re-reads before you can click. GUI-PASS.md carries a
  recipe that does)_ svelte-check 0 / vitest green / cargo green; manual: tick under a concurrent agent edit (simulate: edit the file in a terminal mid-modal) surfaces the retry path; promote from the modal and from a real agent (`/mcp` session) both nest a child; un-parent lands the card in column one.
- [x] **Step 4:** Commit — `feat(app): promotion + live checklist + un-parent` + the trailer.

---

### Task 7: Checklist, docs, sweep

- [x] **Step 1:** Smoke section additions (`nest-drag-in`, `nest-drag-out`, `nest-autoexpand`, `promote-ui`, `promote-mcp`, `checklist-toggle`, `unparent`); fixture README gains a worked nesting walkthrough (seed plan + promote one seeded checklist item). `SKILL.md` note: promotion exists (full skill rewrite waits for plan 3).
- [ ] **Step 2:** _(all four gates ✅; execution notes appended; card stays In Progress
  pending the GUI pass, which is now runnable — see pass 3 below)_ Full gates (`cargo test`, vitest, svelte-check, build) + manual pass of the new items; append execution notes to the brainstorm log; set plan 2's gavin card Done.
- [x] **Step 3:** Commit — `docs: nesting interaction checklist + execution log` + the trailer.

---

## Re-verification — 2026-08-24

Tasks 1–7 shipped on 2026-08-20 (`d8df159`, `8d41f99`, `1d43dc7`, `4139b39`).
The card went back to In Progress on 2026-08-21 (`16868b9`) because the manual
smoke pass had never run, not because code was missing. Re-ran the automated
gates against today's tree (protocol is now v13, six versions past this plan's
v4 — nesting/promotion survived every bump):

- `cargo test -p protocol -p gavin-daemon -p gavin-mcp` — **320 passed, 0 failed**
- `vitest run` — **1150 passed, 66 files**, including the nest suites
  (`pointerDrag` 15, `kanbanDrag` 25, `planDrop` 12, `planChecklist` 6)
- `svelte-check` — **0 errors from this plan's code**. The 13 errors in the run
  are all "Property `modifiedAt` is missing in type … `CardView`": a field a
  concurrent session added to `planBoard.ts` (uncommitted, not present at HEAD),
  which invalidates shared test fixtures. 0 kanban warnings; the 28 warnings are
  pre-existing a11y ones in Sidebar/Pane/LayoutTree/TitleBar/FileEditor/Tooltip.

Spec conformance re-read, not just re-run: `BoardCard.nestTargeted` auto-expands
off `$dragState ?? $dropHold`, the nested area carries `data-kb-nest`, the glue
derives nest eligibility from same-context `data-kb-ctx` task drags, and
`unparentChild` writes `parent: ""` then patches. All seven smoke items
(`nest-drag-in`, `nest-drag-out`, `nest-autoexpand`, `nest-note-refuses`,
`promote-ui`, `promote-mcp`, `checklist-toggle`, `unparent`) are still in
`smokeChecklist.ts`.

**Still blocked (the 3 unticked steps):** the GUI smoke pass needs the app on a
daemon built from this tree. Today's daemon predates v13, so every `gavin_*` MCP
call errors ("the gavin daemon is older than this app") — the same restart
dependency logged on 2026-08-20, unchanged. The restart was not taken: it kills
the shared daemon, and seven agent sessions were live in this worktree. Half of
`promote-mcp` does check out — `gavin_promote_task` is listed in the MCP tool
set with the description this plan specifies.


## Second re-verification — 2026-08-24 (clean worktree + live daemon)

The earlier pass ran in the shared worktree, where five other agent sessions
have uncommitted WIP; its svelte-check noise and inflated test counts both came
from that. This pass re-ran everything in a **detached worktree at HEAD**
(`ae44a78`), so the numbers describe this plan's committed code and nothing
else:

- `cargo test -p protocol -p gavin-daemon -p gavin-mcp` — **312 passed, 0 failed**
  (the fs-watcher module that flakes under shared-tree contention passed clean)
- `vitest run` — **1128 passed, 66 files**; the four nest suites
  (`pointerDrag` 15, `kanbanDrag` 25, `planDrop` 12, `planChecklist` 6) = 58/58
- `svelte-check` — **0 errors, 28 warnings**, 0 of them in kanban code. This
  *confirms* the previous pass's attribution: the 13 `modifiedAt` errors it saw
  were another session's uncommitted `planBoard.ts`, not this plan's code.
- `vite build` — **✓ built**, adapter-static wrote the site

**Correction to the previous note:** it recorded the tree as protocol v13.
HEAD is **v12**; the v13 bump is a concurrent session's uncommitted Archive
work. This plan's v4 surface is unchanged either way.

### Backend half of the smoke pass — actually executed

The GUI smoke pass has been blocked since 2026-08-20 on "the app needs a daemon
built from this tree", and restarting the shared daemon is not acceptable while
other sessions are live. That blocker turns out to only cover the *pointer*
half: `protocol::socket_path()` derives from `$HOME` alone, so a daemon built
from this worktree can be run under a throwaway `HOME` on its own socket,
against a fixture workspace, touching nothing the running app owns.

Driven over that socket (`test-fixtures/card-nesting/nesting_smoke.py`):

| Smoke item | Verified here | Still needs a human |
|---|---|---|
| `checklist-toggle` | tick, untick, indentation preserved, drift refused with **no write** | the modal rendering the retry message |
| `promote-ui` | promotion writes the child + rewrites the line to a link; missing and ambiguous items refused, no child written | the Promote button itself |
| `nest-drag-in` | `parent:` written, `status:` line removed | the drag, auto-expand, placeholder |
| `nest-drag-out` | `status:` written, `parent:` retained | the drag, chip persistence |
| `unparent` | `parent:` removed, `status:` retained | the card landing in column one |

And through the real MCP server, in the same script:

- `promote-mcp` — **fully verified, both halves.** `tools/list` carries
  `gavin_promote_task` with exactly this plan's description and a
  `{plan_path, item}` schema, and an actual `tools/call` created the nested task
  (`kind: task`, `parent:`, no `status:`) and rewrote the plan line to a link.

**What is genuinely left:** the pointer-driven half of `nest-drag-in`,
`nest-drag-out`, `nest-autoexpand`, `nest-note-refuses`, plus the modal halves
of `promote-ui`, `checklist-toggle` and `unparent`. Those need a human dragging
in the real window — the app is a native WKWebView, not a driveable browser, and
WKWebView pointer capture is exactly the thing that cannot be trusted to a
synthetic harness. The *logic* under the two pure-GUI items is unit-covered
("middle band of a nestable plan targets nest index 0; edge bands slot the
column"; "a plan without nest info never nests (note/plan drags, cross-context)").

The harness is checked in at `test-fixtures/card-nesting/` (**28/28**) with a
README mapping each smoke item to its covered / human-only halves. It is safe
to run while the app is up, and it fails loudly if the daemon binary is stale.

The card stays **In Progress** for that reason, and only that reason.


## Third re-verification — 2026-08-24 (the GUI blocker lifted)

**The daemon blocker that held the three open steps since 2026-08-20 is gone.**
Both earlier passes recorded the same obstacle: the app ran a daemon older than
the tree, so every `gavin_*` call errored, and restarting it was unacceptable
with several agent sessions live. That is no longer the state. The running
daemon (`target/debug/gavin-daemon`) is now **v13** — it reports v13 over the
socket, and `gavin-mcp` refuses it in the opposite direction ("the gavin daemon
is newer than this gavin-mcp"), which only happens when the daemon has moved
ahead. v13 is nine versions past this plan's v4 surface, so the app can serve
every nesting op the GUI pass exercises. **No restart is needed to run it.**

(`gavin-mcp` was rebuilt from the current tree in this pass, so it matches
again. Existing MCP client processes keep the old binary until a `/mcp`
reconnect.)

### Gates re-run against the live working tree

Both earlier passes measured a *detached worktree at HEAD*, deliberately, to
exclude other sessions' WIP. This pass measured the **shared tree as it
actually stands** — HEAD `ae44a78` plus ~76 dirty files from concurrent
sessions — because that is the code the app is running and therefore the code
the human's GUI pass will exercise. Nesting is unaffected by any of it:

- nest suites — **58/58** (`pointerDrag` 15, `kanbanDrag` 25, `planDrop` 12,
  `planChecklist` 6)
- `cargo test -p gavin-daemon checklist` — **6/6**, now including
  `promote_checklist_item_works_from_an_archived_plan`, a test the concurrent
  Archive session added: promotion survived that work too
- `svelte-check` — **0 errors, 28 warnings**, none in kanban. (Pass 2 predicted
  this: the 13 `modifiedAt` errors pass 1 saw were another session's
  uncommitted `planBoard.ts`. They are gone now, from the same dirty tree.)
- `nesting_smoke.py` — **28/28**, against a v13 daemon this time rather than
  v12. The whole backend half still holds nine protocol versions on.

### The pointer half is confirmed human-only

Re-checked rather than assumed: `app/src/lib/backend.ts` routes every board
call through Tauri `invoke`, so the app served at `localhost:1420` by the dev
server renders an empty board in a normal browser — there is nothing to drag,
and no amount of synthetic pointer work changes that. Driving it would mean
mocking the whole backend, which would test the mock. The earlier assessment
stands.

### What this pass added

- `test-fixtures/card-nesting/seed_gui_fixture.py` — seeds a durable throwaway
  workspace with exactly the shapes the pass needs (a plan with a tickable and
  a promotable item, a pre-nested child, a free task, and **a note *and* a
  second plan**, since the smoke item is "notes *and plans* refuse to nest" and
  the old temp fixture had neither). `--show` prints each card's kind and
  whether it is nested or free-standing, so every step's file effect is
  checkable without reading frontmatter; `--reset` re-seeds, guarded so it will
  only delete a directory carrying this script's own marker.
- `test-fixtures/card-nesting/GUI-PASS.md` — the seven smoke items plus
  Escape-cancel, as an ordered eight-step ~10-minute pass. Each step carries
  its ✅ assertions, the order minimises re-seeds, and a symptom →
  source-file table covers triage if one fails.

**Two corrections to earlier notes, both found by checking the code:**

1. The retry-path recipe in Task 6 Step 3 does not work as written.
   `CardDetailModal.svelte:64` watches its own file and re-reads on
   `file-changed`, so a single terminal `sed` is repaired long before a human
   can click, and the tick then succeeds against fresh text — the drift branch
   never runs. Reaching it needs the edit to land inside the re-read window
   (`RESCAN_DEBOUNCE` is 150ms, `gavin.rs:1289`); GUI-PASS.md step 5 uses a
   flip loop for that. The daemon-side refusal is unaffected and stays verified
   (`nesting_smoke.py`: drift refused, wrote nothing).
2. `nest-autoexpand` is **not** a separate id in `smokeChecklist.ts`, though
   Task 7 Step 1 and both earlier sections name it as one — the section has
   **seven** items, and auto-expand is asserted inside `nest-drag-in`'s text
   ("Dragging a task over a plan card auto-expands it"). Left folded rather
   than split: a separate item would duplicate an assertion the human already
   has to make. The earlier list of "all seven smoke items" in fact named eight.

**Still open, and now the only thing open:** a human running GUI-PASS.md. The
card stays **In Progress** for that and only that.
