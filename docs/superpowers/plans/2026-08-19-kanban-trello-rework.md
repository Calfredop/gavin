# Kanban Trello-Quality Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the kanban board's HTML5 drag-and-drop with a zero-dependency pointer-event engine (placeholder gap, FLIP reflow, tilted floating preview, auto-scroll, click-vs-drag threshold), add manual plan-card ordering via a new `order:` frontmatter field, fix the nine confirmed defects, and render both board surfaces through one component path.

**Architecture:** All drag math lives in pure `.ts` modules (`pointerDrag.ts` geometry, `kanbanDrag.ts` state machine, `planOrder.ts` order writes) tested by vitest; Svelte components carry only data attributes and one delegated glue module (`kanbanDragGlue.ts`). Hit-testing returns indices computed against the visual list *without* the dragged item — the post-removal index `moveCard`/`reorderColumn` expect — eliminating the off-by-one class by construction. Plan-card order is an integer frontmatter field written through the existing byte-preserving `set_plan_field`.

**Tech Stack:** Svelte 5 (runes, `svelte/animate` flip), TypeScript, vitest, Tauri, Rust daemon (cargo), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-19-kanban-trello-rework-design.md` (decisions K1–K8 in `docs/superpowers/brainstorms/2026-08-19-kanban-trello-brainstorm.md`)

## Global Constraints

- **Zero new npm/cargo dependencies** (K1).
- **Files are truth:** plan cards only ever write frontmatter through `setPlanFrontmatterField`; never plan positions to SQLite.
- **Patch-on-success:** `patchPlanField` is called only after the corresponding write resolves.
- **`npx svelte-check` must stay at 0 errors** after every task (run from `app/`).
- **No Svelte component tests** — vitest cannot preprocess `.svelte`; all testable logic goes in pure `.ts` modules.
- **Work directly on `main`, no worktrees. Commit per task, do not push.**
- Every commit message ends with the trailer (referenced below as "the trailer"):

  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01V58rPGKNUn1ptEie618yHf
  ```

- Test commands: `cargo test` (repo root), `cd app && npx vitest run [file]`, `cd app && npx svelte-check`.

---

### Task 1: Daemon + protocol `order` support

**Files:**
- Modify: `crates/protocol/src/lib.rs` (PlanFileInfo struct ~line 245, `PROTOCOL_VERSION` line 14, fixture ~line 732, version test ~line 841)
- Modify: `crates/daemon/src/gavin.rs` (`plan_file_info` ~line 84, `set_plan_field` ~line 239, tests at bottom)
- Modify: `crates/gavin-mcp/src/main.rs` (~line 115: `gavin_set_plan_field` schema)

**Interfaces:**
- Produces: `PlanFileInfo.order: Option<i64>` (serde camelCase → JSON `order`), `set_plan_field(path, "order", "<i64>")` accepted, `PROTOCOL_VERSION == 2`.

- [ ] **Step 1: Write failing daemon tests** in `crates/daemon/src/gavin.rs`'s test module, next to the existing `plan_with_full_frontmatter_parses_all_fields`:

```rust
#[test]
fn plan_order_parses_integer_and_flags_garbage() {
    let p = Path::new("/x/plans/a.md");
    let ok = plan_file_info(p, "---\ntitle: A\norder: 2048\n---\n");
    assert_eq!(ok.order, Some(2048));
    assert!(!ok.parse_warning);

    let none = plan_file_info(p, "---\ntitle: A\n---\n");
    assert_eq!(none.order, None);
    assert!(!none.parse_warning);

    let bad = plan_file_info(p, "---\ntitle: A\norder: soon\n---\n");
    assert_eq!(bad.order, None);
    assert!(bad.parse_warning);
}

#[test]
fn set_plan_field_accepts_integer_order_and_rejects_garbage() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p.md");
    std::fs::write(&path, "---\ntitle: T\nstatus: To Do\n---\nbody\n").unwrap();
    assert!(set_plan_field(&path, "order", "1.5").is_err());
    assert!(set_plan_field(&path, "order", "soon").is_err());
    set_plan_field(&path, "order", "1024").unwrap();
    let content = std::fs::read_to_string(&path).unwrap();
    assert_eq!(content, "---\norder: 1024\ntitle: T\nstatus: To Do\n---\nbody\n");
}
```

(Match the existing tests' tempfile/setup idioms in that module — reuse their helper if one exists.)

- [ ] **Step 2: Run to verify failure** — `cargo test -p gavin-daemon plan_order` → FAIL (no `order` field / "field not allowed").

- [ ] **Step 3: Implement.**
  - `crates/protocol/src/lib.rs`: add `pub order: Option<i64>,` to `PlanFileInfo` (after `priority`); update the doc comment to mention order. Fix the struct literal in the fixture test (~line 732) by adding `order: None`. Bump `pub const PROTOCOL_VERSION: u32 = 1;` → `2` and the `assert_eq!(PROTOCOL_VERSION, 1)` test → `2` (deliberate: the app will send `order` writes that pre-order daemons reject, so a stale daemon must trip the version overlay, not fail per-drop).
  - `crates/daemon/src/gavin.rs`, in `plan_file_info` after the `priority` block:

```rust
let order = match get("order") {
    None => None,
    Some(raw) => match raw.trim().parse::<i64>() {
        Ok(n) => Some(n),
        Err(_) => {
            warning = true;
            None
        }
    },
};
```

  and add `order,` to the `PlanFileInfo { ... }` literal.
  - In `set_plan_field`'s allow-list match:

```rust
"order" => {
    if value.trim().parse::<i64>().is_err() {
        anyhow::bail!("order must be an integer: {value}");
    }
}
```

  - `crates/gavin-mcp/src/main.rs` line ~115–117: description → `"Update one frontmatter field (status, priority, or order) of a plan file, preserving every other byte."`, enum → `["status", "priority", "order"]`.

- [ ] **Step 4: Run full workspace tests** — `cargo test` → all pass (compile errors will point at any struct literal still missing `order`).

- [ ] **Step 5: Commit** — `git add -A crates && git commit` with message `feat(daemon): integer order frontmatter field on plans (protocol v2)` + the trailer.

---

### Task 2: Frontend plumbing for `order`

**Files:**
- Modify: `app/src/lib/gavin.ts` (PlanFileInfo interface, ~line 4)
- Modify: `app/src/lib/backend.ts` (`setPlanFrontmatterField`, line 141)
- Modify: `app/src/lib/gavinState.ts` (`patchPlanField`, line 42)
- Test: `app/src/lib/gavinState.test.ts`

**Interfaces:**
- Produces: `PlanFileInfo.order: number | null`; `setPlanFrontmatterField(path, key: "status" | "priority" | "order", value: string)`; `patchPlanField(workspaceId, path, key: "status" | "priority" | "order", value: string)` — for `"order"` it stores `Number(value)` (skips the patch if not a finite number).

- [ ] **Step 1: Write failing test** in `gavinState.test.ts`, following that file's existing patchPlanField test setup (a seeded `gavinTrees` store with one context/plan):

```typescript
it("patchPlanField order stores a number and ignores garbage", () => {
  // seed gavinTrees["ws-1"] with one plan at path "/r/.gavin-root/plans/a.md" (copy the file's existing seeding helper)
  patchPlanField("ws-1", "/r/.gavin-root/plans/a.md", "order", "2048");
  expect(get(gavinTrees)["ws-1"].contexts[0].plans[0].order).toBe(2048);
  patchPlanField("ws-1", "/r/.gavin-root/plans/a.md", "order", "soon");
  expect(get(gavinTrees)["ws-1"].contexts[0].plans[0].order).toBe(2048);
});
```

- [ ] **Step 2: Run to verify failure** — `cd app && npx vitest run src/lib/gavinState.test.ts` → FAIL (type + behavior).

- [ ] **Step 3: Implement.**
  - `gavin.ts`: add `order: number | null;` to `PlanFileInfo`.
  - `backend.ts`: widen the key union to `"status" | "priority" | "order"`.
  - `gavinState.ts` `patchPlanField`: widen the key union the same way and replace the ternary body with:

```typescript
plans: ctx.plans.map((p) => {
  if (p.path !== path) return p;
  if (key === "status") return { ...p, status: value };
  if (key === "priority") return { ...p, priority: value.toLowerCase() as PlanFileInfo["priority"] };
  const n = Number(value);
  return Number.isFinite(n) ? { ...p, order: n } : p;
}),
```

  - Any test fixtures constructing `PlanFileInfo` objects now need `order: null` — fix compile errors where vitest/svelte-check flags them.

- [ ] **Step 4: Verify** — `npx vitest run src/lib/gavinState.test.ts` PASS, then `npx vitest run` (full) and `npx svelte-check` → 0 errors.

- [ ] **Step 5: Commit** — `feat(app): order field plumbing (PlanFileInfo, backend, patchPlanField)` + the trailer.

---

### Task 3: planBoard sorts by order

**Files:**
- Modify: `app/src/lib/planBoard.ts` (PlanCardView, `planView`, the `entries.sort`)
- Test: `app/src/lib/planBoard.test.ts`

**Interfaces:**
- Produces: `PlanCardView.order: number | null`; plan cards everywhere sort by `(order ?? +∞, contextFolder, fileName)`.

- [ ] **Step 1: Write failing tests** (reuse the file's existing board/tree builders):

```typescript
it("sorts plan cards by order, unordered last by folder/filename", () => {
  // three plans, same status "To Do": a.md order 2000, b.md order 1000, c.md no order
  // expect merged first column planCards = [b, a, c]
});

it("order ties fall back to folder then filename", () => {
  // two plans with order 1000 in different contexts — the lexicographically
  // earlier folderPath wins
});
```

(Write them as real tests against `mergePlanCards`, mirroring the file's existing fixture style; every plan fixture gains `order`.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/planBoard.test.ts` → FAIL.

- [ ] **Step 3: Implement.** `PlanCardView` gains `order: number | null`; `planView` copies `plan.order`; replace the sort comparator:

```typescript
entries.sort((a, b) => {
  const ao = a.plan.order ?? Number.POSITIVE_INFINITY;
  const bo = b.plan.order ?? Number.POSITIVE_INFINITY;
  if (ao < bo) return -1;
  if (ao > bo) return 1;
  return (
    a.ctx.folderPath.localeCompare(b.ctx.folderPath) ||
    a.plan.fileName.localeCompare(b.plan.fileName)
  );
});
```

- [ ] **Step 4: Verify** — planBoard tests PASS, full `npx vitest run` PASS, `npx svelte-check` 0 errors.

- [ ] **Step 5: Commit** — `feat(app): plan cards sort by order frontmatter` + the trailer.

---

### Task 4: planOrder.ts — pure order-write math

**Files:**
- Create: `app/src/lib/planOrder.ts`
- Test: `app/src/lib/planOrder.test.ts`

**Interfaces:**
- Produces: `computeOrderWrites(cards: OrderedPlanCard[], targetIndex: number, draggedPath: string): OrderWrite[]` where `OrderedPlanCard = { path: string; order: number | null }`, `OrderWrite = { path: string; order: number }`, `ORDER_GAP = 1024`. `cards` = target column's plan block in visual order **with the dragged card excluded**; `targetIndex` = post-removal slot.

- [ ] **Step 1: Write failing tests** in `planOrder.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { computeOrderWrites, ORDER_GAP } from "./planOrder";

const c = (path: string, order: number | null) => ({ path, order });

describe("computeOrderWrites", () => {
  it("empty column: single write at ORDER_GAP", () => {
    expect(computeOrderWrites([], 0, "d")).toEqual([{ path: "d", order: ORDER_GAP }]);
  });

  it("append after an ordered tail: single write, +GAP", () => {
    expect(computeOrderWrites([c("a", 1024)], 1, "d")).toEqual([{ path: "d", order: 2048 }]);
  });

  it("insert at head before an ordered card: single write, -GAP", () => {
    expect(computeOrderWrites([c("a", 1024)], 0, "d")).toEqual([{ path: "d", order: 0 }]);
  });

  it("midpoint between ordered neighbors with room", () => {
    expect(computeOrderWrites([c("a", 1024), c("b", 2048)], 1, "d")).toEqual([
      { path: "d", order: 1536 },
    ]);
  });

  it("gap exhausted: renumbers the whole block in visual order", () => {
    expect(computeOrderWrites([c("a", 1024), c("b", 1025)], 1, "d")).toEqual([
      { path: "a", order: 1024 },
      { path: "d", order: 2048 },
      { path: "b", order: 3072 },
    ]);
  });

  it("unordered neighbor: materializes the block", () => {
    expect(computeOrderWrites([c("a", 1024), c("b", null)], 1, "d")).toEqual([
      { path: "a", order: 1024 },
      { path: "d", order: 2048 },
      { path: "b", order: 3072 },
    ]);
  });

  it("drop at end after an unordered card materializes too", () => {
    expect(computeOrderWrites([c("a", null)], 1, "d")).toEqual([
      { path: "a", order: 1024 },
      { path: "d", order: 2048 },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — module doesn't exist.

- [ ] **Step 3: Implement** `app/src/lib/planOrder.ts`:

```typescript
// Pure math for manual plan-card ordering (spec §2). `order:` is an
// integer frontmatter field; cards sort by (order ?? +Infinity,
// contextFolder, fileName). Given a drop, this computes the minimal set
// of frontmatter writes: one midpoint write in the steady state, a
// block renumber when the gap is exhausted or a needed neighbor has no
// order yet (first manual ordering in a column materializes the block).

export interface OrderedPlanCard {
  path: string;
  order: number | null;
}

export interface OrderWrite {
  path: string;
  order: number;
}

export const ORDER_GAP = 1024;

// cards: the target column's plan block in visual order, dragged card
// EXCLUDED. targetIndex: the post-removal slot (0..cards.length).
export function computeOrderWrites(
  cards: OrderedPlanCard[],
  targetIndex: number,
  draggedPath: string
): OrderWrite[] {
  const clamped = Math.max(0, Math.min(targetIndex, cards.length));
  const before = clamped > 0 ? cards[clamped - 1] : null;
  const after = clamped < cards.length ? cards[clamped] : null;

  if ((before && before.order === null) || (after && after.order === null)) {
    return renumber(cards, clamped, draggedPath);
  }
  if (!before && !after) return [{ path: draggedPath, order: ORDER_GAP }];
  if (!before) return [{ path: draggedPath, order: (after as OrderedPlanCard).order! - ORDER_GAP }];
  if (!after) return [{ path: draggedPath, order: before.order! + ORDER_GAP }];
  if (after.order! - before.order! >= 2) {
    return [{ path: draggedPath, order: Math.floor((before.order! + after.order!) / 2) }];
  }
  return renumber(cards, clamped, draggedPath);
}

function renumber(cards: OrderedPlanCard[], targetIndex: number, draggedPath: string): OrderWrite[] {
  const paths = cards.map((c) => c.path);
  paths.splice(targetIndex, 0, draggedPath);
  return paths.map((path, i) => ({ path, order: (i + 1) * ORDER_GAP }));
}
```

- [ ] **Step 4: Verify** — `npx vitest run src/lib/planOrder.test.ts` PASS.

- [ ] **Step 5: Commit** — `feat(app): planOrder pure order-write math` + the trailer.

---

### Task 5: planDrop.ts — plan-drop orchestration

**Files:**
- Create: `app/src/lib/planDrop.ts`
- Test: `app/src/lib/planDrop.test.ts`

**Interfaces:**
- Consumes: `computeOrderWrites` (Task 4), `backend.setPlanFrontmatterField` (Task 2), `patchPlanField` (Task 2).
- Produces: `applyPlanDrop(spec: PlanDropSpec): Promise<string | null>` with `PlanDropSpec = { workspaceId: string; path: string; statusTarget: string | null; targetColumn: OrderedPlanCard[]; targetIndex: number }` — returns an error message naming the failed file, or null. Used by both board surfaces (Tasks 12–13).

- [ ] **Step 1: Write failing tests** in `planDrop.test.ts` (mock `./backend` like `kanbanState.test.ts` does; seed `gavinTrees` for patch assertions):

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./backend", () => ({ setPlanFrontmatterField: vi.fn() }));

import * as backend from "./backend";
import { applyPlanDrop } from "./planDrop";

beforeEach(() => vi.clearAllMocks());

it("cross-column: writes status first, then order writes, in call order", async () => {
  vi.mocked(backend.setPlanFrontmatterField).mockResolvedValue(undefined);
  const err = await applyPlanDrop({
    workspaceId: "ws",
    path: "/p/d.md",
    statusTarget: "In Progress",
    targetColumn: [{ path: "/p/a.md", order: 1024 }],
    targetIndex: 1,
  });
  expect(err).toBeNull();
  expect(vi.mocked(backend.setPlanFrontmatterField).mock.calls).toEqual([
    ["/p/d.md", "status", "In Progress"],
    ["/p/d.md", "order", "2048"],
  ]);
});

it("same-column: no status write", async () => {
  vi.mocked(backend.setPlanFrontmatterField).mockResolvedValue(undefined);
  await applyPlanDrop({
    workspaceId: "ws", path: "/p/d.md", statusTarget: null,
    targetColumn: [], targetIndex: 0,
  });
  expect(vi.mocked(backend.setPlanFrontmatterField).mock.calls).toEqual([
    ["/p/d.md", "order", "1024"],
  ]);
});

it("failure mid-batch stops and names the failing file", async () => {
  vi.mocked(backend.setPlanFrontmatterField)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("disk full"));
  const err = await applyPlanDrop({
    workspaceId: "ws", path: "/p/d.md", statusTarget: null,
    // unordered neighbor forces a renumber: writes a.md then d.md then b.md
    targetColumn: [{ path: "/p/a.md", order: null }, { path: "/p/b.md", order: null }],
    targetIndex: 1,
  });
  expect(err).toContain("d.md");
  expect(err).toContain("disk full");
  expect(backend.setPlanFrontmatterField).toHaveBeenCalledTimes(2);
});
```

(Also assert `patchPlanField` effects by seeding `gavinTrees` with the involved plans and checking status/order after — copy the seeding helper from `gavinState.test.ts`.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** `app/src/lib/planDrop.ts`:

```typescript
import * as backend from "./backend";
import { patchPlanField } from "./gavinState";
import { computeOrderWrites, type OrderedPlanCard } from "./planOrder";

export interface PlanDropSpec {
  workspaceId: string;
  path: string; // the dragged plan file
  statusTarget: string | null; // column name / auto status when the column changed
  targetColumn: OrderedPlanCard[]; // target plan block, visual order, dragged excluded
  targetIndex: number; // post-removal slot
}

// Applies a plan-card drop: status first (cross-column only), then the
// order writes. Each field is patched into gavinTrees only after its
// write resolves (the optimistic-patch contract). On failure: stop --
// the ~2.5s watcher push reconciles whatever landed -- and return an
// error naming the file that failed. Null on success.
export async function applyPlanDrop(spec: PlanDropSpec): Promise<string | null> {
  let current = spec.path;
  try {
    if (spec.statusTarget !== null) {
      await backend.setPlanFrontmatterField(spec.path, "status", spec.statusTarget);
      patchPlanField(spec.workspaceId, spec.path, "status", spec.statusTarget);
    }
    for (const w of computeOrderWrites(spec.targetColumn, spec.targetIndex, spec.path)) {
      current = w.path;
      await backend.setPlanFrontmatterField(w.path, "order", String(w.order));
      patchPlanField(spec.workspaceId, w.path, "order", String(w.order));
    }
    return null;
  } catch (e) {
    const fileName = current.split("/").at(-1) ?? current;
    return `Couldn't update ${fileName}: ${e instanceof Error ? e.message : e}`;
  }
}
```

Note: `computeOrderWrites` emits the dragged card's write first only in the single-write cases; in renumbers the loop order is block order — the failure test above depends on that (a.md, d.md, b.md).

- [ ] **Step 4: Verify** — planDrop tests PASS, full vitest PASS.

- [ ] **Step 5: Commit** — `feat(app): applyPlanDrop orchestration (status + order, patch-on-success)` + the trailer.

---

### Task 6: kanban.ts index contract — docs + regression tests

**Files:**
- Modify: `app/src/lib/kanban.ts` (doc comments on `moveCard` ~line 58 and `reorderColumn` ~line 163 only — no behavior change)
- Test: `app/src/lib/kanban.test.ts`

- [ ] **Step 1: Add regression tests** pinning the brief's worked example:

```typescript
it("moveCard targetIndex is POST-removal: index 1 puts A before C in [A,B,C]", () => {
  // board with one column, cards A,B,C at positions 0,1,2
  const moved = moveCard(board, "A", "col-1", 1);
  expect(moved.columns[0].cards.map((c) => c.id)).toEqual(["B", "A", "C"]);
});

it("moveCard to end of same column", () => {
  const moved = moveCard(board, "A", "col-1", 2);
  expect(moved.columns[0].cards.map((c) => c.id)).toEqual(["B", "C", "A"]);
});

it("reorderColumn targetIndex is POST-removal", () => {
  // columns X,Y,Z; reorder X to index 1 -> Y,X,Z
  const next = reorderColumn(board, "X", 1);
  expect(next.columns.map((c) => c.id)).toEqual(["Y", "X", "Z"]);
});
```

(Build fixtures with the file's existing helpers.)

- [ ] **Step 2: Run** — these should PASS already (the functions were correct; the *callers* were wrong). If any fails, stop: that's new information, use superpowers:systematic-debugging.

- [ ] **Step 3: Document the contract.** Extend `moveCard`'s comment with: `targetIndex is the index in the target column AFTER the card's removal (a caller computing an index against the pre-removal list will be off by one when moving down within the same column).` Same idea on `reorderColumn`.

- [ ] **Step 4: Full vitest PASS.**

- [ ] **Step 5: Commit** — `test(app): pin post-removal index contract of moveCard/reorderColumn` + the trailer.

---

### Task 7: kanbanState resilience — rollback, save errors, refresh

**Files:**
- Modify: `app/src/lib/kanbanState.ts`
- Test: `app/src/lib/kanbanState.test.ts`

**Interfaces:**
- Produces: `saveErrors` (writable store `Record<string, string>`), `dismissSaveError(workspaceId)`, `refreshBoard(workspaceId): Promise<void>`. `mutateAndPersist` rolls back on failure. Used by Tasks 15 (banner UI + staleness wiring).

- [ ] **Step 1: Write failing tests:**

```typescript
it("failed setBoard rolls the store back and records a save error", async () => {
  vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());
  await fetchBoard("ws-1");
  vi.mocked(backend.setBoard).mockRejectedValue(new Error("daemon gone"));
  await addCardAction("ws-1", "c1", { id: "x", title: "t", description: "", labelIds: [], priority: "none", position: 0 });
  expect(get(kanbanState)["ws-1"]).toEqual(emptyBoard()); // rolled back
  expect(get(saveErrors)["ws-1"]).toContain("daemon gone");
});

it("a successful save clears the workspace's save error", async () => { /* fail once, then succeed, expect saveErrors["ws-1"] undefined */ });

it("rollback is skipped when a later mutation already changed the store", async () => {
  // mutation A's setBoard hangs then rejects AFTER mutation B applied optimistically;
  // use a manually-resolved promise for A. Expect store to keep B's board.
});

it("refreshBoard refetches and replaces", async () => {
  vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());
  await fetchBoard("ws-1");
  const richer: Board = { ...emptyBoard(), labels: [{ id: "l", name: "L", color: "#fff" }] };
  vi.mocked(backend.getBoard).mockResolvedValue(richer);
  await refreshBoard("ws-1");
  expect(get(kanbanState)["ws-1"]).toEqual(richer);
});

it("refreshBoard is skipped while a save is in flight", async () => {
  // setBoard returns a pending promise; call refreshBoard; expect getBoard NOT called a second time
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** in `kanbanState.ts`:

```typescript
export const saveErrors = writable<Record<string, string>>({});

export function dismissSaveError(workspaceId: string): void {
  saveErrors.update((e) => {
    if (!(workspaceId in e)) return e;
    const { [workspaceId]: _removed, ...rest } = e;
    return rest;
  });
}

const pendingSaves = new Map<string, number>();

async function mutateAndPersist(workspaceId: string, mutate: (board: Board) => Board): Promise<void> {
  const current = get(kanbanState)[workspaceId];
  if (!current) return;
  const updated = mutate(current);
  kanbanState.update((s) => ({ ...s, [workspaceId]: updated }));
  pendingSaves.set(workspaceId, (pendingSaves.get(workspaceId) ?? 0) + 1);
  try {
    await backend.setBoard(workspaceId, updated.columns, updated.labels);
    dismissSaveError(workspaceId);
  } catch (e) {
    // Roll back the optimistic update -- but only if no later mutation
    // has already replaced it (reference equality: every mutation makes
    // a fresh board object).
    kanbanState.update((s) => (s[workspaceId] === updated ? { ...s, [workspaceId]: current } : s));
    saveErrors.update((err) => ({
      ...err,
      [workspaceId]: String(e instanceof Error ? e.message : e),
    }));
  } finally {
    pendingSaves.set(workspaceId, (pendingSaves.get(workspaceId) ?? 1) - 1);
  }
}

// Re-reads the board from SQLite (spec §3, staleness). Skipped while a
// mutation is in flight so optimistic state is never clobbered; checked
// again after the fetch for saves that started meanwhile.
export async function refreshBoard(workspaceId: string): Promise<void> {
  if ((pendingSaves.get(workspaceId) ?? 0) > 0) return;
  try {
    const board = await backend.getBoard(workspaceId);
    if ((pendingSaves.get(workspaceId) ?? 0) > 0) return;
    kanbanState.update((s) => ({ ...s, [workspaceId]: board }));
    clearError(workspaceId);
  } catch {
    // Keep showing the board we have; the load-error overlay is only
    // for a board we never managed to load.
  }
}
```

Also add a test-only `__resetForTesting` mirroring `gavinState.ts` if `pendingSaves` leaks between tests.

- [ ] **Step 4: Verify** — kanbanState tests PASS, full vitest PASS, svelte-check 0 errors.

- [ ] **Step 5: Commit** — `feat(app): kanban save rollback + error surface + refreshBoard` + the trailer.

---

### Task 8: pointerDrag.ts — pure geometry

**Files:**
- Create: `app/src/lib/pointerDrag.ts`
- Test: `app/src/lib/pointerDrag.test.ts`

**Interfaces:**
- Produces (consumed by Task 9's controller and Task 10's glue):

```typescript
export interface Point { x: number; y: number }
export interface Rect { left: number; top: number; width: number; height: number }
export interface Measured { id: string; rect: Rect }
export interface MeasuredColumn {
  id: string;            // real column id, or "auto:<status>"
  rect: Rect;
  auto: boolean;         // auto columns accept only plan drags
  cards: Measured[];     // free-form block, visual order, dragged EXCLUDED
  planCards: Measured[]; // plan block, visual order, dragged EXCLUDED
}
export interface DropTarget { columnId: string; index: number }
export const DRAG_THRESHOLD_PX = 5;
export function exceedsThreshold(start: Point, current: Point): boolean
export function computeDropTarget(pointer: Point, columns: MeasuredColumn[], dragKind: "card" | "plan", maxSnapPx?: number): DropTarget | null
export function computeColumnDropIndex(pointer: Point, columns: Measured[]): number
export function autoScrollVelocity(pointerCoord: number, rectStart: number, rectEnd: number, edgePx?: number, maxPxPerFrame?: number): number
```

- [ ] **Step 1: Write failing tests** (`pointerDrag.test.ts`; helper `r = (left, top, width, height)`):

```typescript
describe("exceedsThreshold", () => {
  it("false under 5px, true at 5px", () => {
    expect(exceedsThreshold({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(false);
    expect(exceedsThreshold({ x: 0, y: 0 }, { x: 5, y: 0 })).toBe(true);
  });
});

describe("computeDropTarget", () => {
  // two real columns col1 x:[0,240], col2 x:[252,492]; col1 has cards A y:[0,50), B y:[56,106)
  it("index 0 above A's midpoint, 1 between midpoints, 2 below B's midpoint", ...);
  it("post-removal by construction: with dragged excluded, [B,C] hover before C's midpoint gives index 1", ...);
  it("picks the nearest column when pointer is in the gap between columns", ...);
  it("null when farther than maxSnapPx from every column", ...);
  it("card drags skip auto columns entirely; plan drags target them", ...);
  it("kind selects the block: plan drag indexes planCards, card drag indexes cards", ...);
  it("pointer above/below a column still targets it (vertical position only picks the slot)", ...);
});

describe("computeColumnDropIndex", () => {
  it("counts columns whose horizontal midpoint is left of the pointer", ...);
  it("clamps to the ends for far-left / far-right pointers", ...);
});

describe("autoScrollVelocity", () => {
  it("0 in the middle", () => expect(autoScrollVelocity(500, 0, 1000)).toBe(0));
  it("negative near the start edge, ramping to max at/past the edge", ...);
  it("positive near the end edge", ...);
});
```

(Write each `...` out as a real assertion when implementing this task — synthetic rects, exact expected indices.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** `pointerDrag.ts`:

```typescript
// Pure geometry for the kanban pointer-drag engine (spec §1). Operates
// on plain rect/point shapes measured by kanbanDragGlue -- never on DOM
// types -- so every decision here is unit-testable. All indices are
// computed against lists WITH THE DRAGGED ITEM EXCLUDED (it is hidden
// while dragging), which is exactly the post-removal index that
// kanban.moveCard / reorderColumn expect.

export interface Point { x: number; y: number }
export interface Rect { left: number; top: number; width: number; height: number }
export interface Measured { id: string; rect: Rect }

export interface MeasuredColumn {
  id: string; // real column id, or "auto:<status>"
  rect: Rect;
  auto: boolean; // auto columns accept only plan drags
  cards: Measured[];
  planCards: Measured[];
}

export interface DropTarget { columnId: string; index: number }

export const DRAG_THRESHOLD_PX = 5;

export function exceedsThreshold(start: Point, current: Point): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= DRAG_THRESHOLD_PX;
}

function horizontalDistance(rect: Rect, x: number): number {
  if (x < rect.left) return rect.left - x;
  const right = rect.left + rect.width;
  return x > right ? x - right : 0;
}

export function computeDropTarget(
  pointer: Point,
  columns: MeasuredColumn[],
  dragKind: "card" | "plan",
  maxSnapPx = 100
): DropTarget | null {
  let best: MeasuredColumn | null = null;
  let bestDist = Infinity;
  for (const col of columns) {
    if (dragKind === "card" && col.auto) continue;
    const d = horizontalDistance(col.rect, pointer.x);
    if (d < bestDist) {
      bestDist = d;
      best = col;
    }
  }
  if (!best || bestDist > maxSnapPx) return null;
  const list = dragKind === "card" ? best.cards : best.planCards;
  let index = 0;
  for (const item of list) {
    if (pointer.y > item.rect.top + item.rect.height / 2) index += 1;
  }
  return { columnId: best.id, index };
}

export function computeColumnDropIndex(pointer: Point, columns: Measured[]): number {
  let index = 0;
  for (const col of columns) {
    if (pointer.x > col.rect.left + col.rect.width / 2) index += 1;
  }
  return index;
}

// Signed px/frame: negative scrolls toward the start edge. Ramps
// linearly from 0 at edgePx inside the rect to maxPxPerFrame at (or
// past) the edge itself.
export function autoScrollVelocity(
  pointerCoord: number,
  rectStart: number,
  rectEnd: number,
  edgePx = 40,
  maxPxPerFrame = 12
): number {
  const fromStart = pointerCoord - rectStart;
  const fromEnd = rectEnd - pointerCoord;
  if (fromStart < fromEnd && fromStart < edgePx) {
    return -Math.round(((edgePx - Math.max(fromStart, 0)) / edgePx) * maxPxPerFrame);
  }
  if (fromEnd < edgePx) {
    return Math.round(((edgePx - Math.max(fromEnd, 0)) / edgePx) * maxPxPerFrame);
  }
  return 0;
}
```

- [ ] **Step 4: Verify** — pointerDrag tests PASS.

- [ ] **Step 5: Commit** — `feat(app): pointerDrag pure geometry (threshold, hit-testing, auto-scroll)` + the trailer.

---

### Task 9: kanbanDrag.ts — DOM-free drag controller + display slots

**Files:**
- Create: `app/src/lib/kanbanDrag.ts`
- Test: `app/src/lib/kanbanDrag.test.ts`

**Interfaces:**
- Consumes: everything Task 8 produces.
- Produces (consumed by Tasks 10–14):

```typescript
export type DragKind = "card" | "plan" | "column";
export interface ActiveDrag {
  kind: DragKind;
  id: string;                     // card id / plan path / column id
  sourceColumnId: string | null;  // null for column drags
  sourceIndex: number;            // index within its block/strip at grab (post-removal frame)
  target: DropTarget | null;      // column drags use { columnId: "", index }
  pointer: Point;
  grabOffset: Point;
  size: { width: number; height: number };
}
export const dragState: Writable<ActiveDrag | null>;
export interface DragCallbacks {
  measure: () => MeasuredColumn[];
  measureColumns: () => Measured[];
  commit: (drag: ActiveDrag & { target: DropTarget }) => void;
  click: (kind: DragKind, id: string) => void;
}
export function beginCandidate(kind: DragKind, id: string, sourceColumnId: string | null, sourceIndex: number, start: Point, itemRect: Rect, cbs: DragCallbacks): void
export function movePointer(p: Point): void
export function refreshTarget(): void          // re-hit-test at the current pointer (auto-scroll frames)
export function endPointer(): void
export function cancelDrag(): void
export type Slot<T> = { type: "item"; item: T } | { type: "placeholder" };
export function buildDisplaySlots<T>(items: T[], idOf: (t: T) => string, drag: ActiveDrag | null, columnKey: string, kind: "card" | "plan"): Slot<T>[]
export function buildColumnSlots<T>(columns: T[], idOf: (t: T) => string, drag: ActiveDrag | null): Slot<T>[]
```

Semantics: `beginCandidate` never activates; the first `movePointer` past `DRAG_THRESHOLD_PX` activates and sets `dragState`. `endPointer` below threshold → `click`; active with non-null target → `commit` **unless** it's a no-op (same column and `target.index === sourceIndex`; for columns, `target.index === sourceIndex`); always clears state. `cancelDrag` clears without committing. `commit`/`click` are fire-and-forget from the controller's perspective.

- [ ] **Step 1: Write failing tests** covering: click below threshold; activation at threshold sets `dragState` with grabOffset/size; movePointer recomputes target via `measure`; column drags use `measureColumns`; endPointer commits with final target; no-op drop (same column+index) does NOT commit but still clears; cancelDrag clears without commit; refreshTarget re-measures without a new pointer; a second beginCandidate while idle after end works (state fully reset). Use fake callbacks recording calls and returning synthetic `MeasuredColumn[]`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** Module-level `candidate` + `callbacks` refs (like `gavinState.ts`'s module state), `dragState` writable. `movePointer`: update candidate/drag pointer; activate on threshold (set store with `target` computed immediately); when active, recompute target: `kind === "column"` → `{ columnId: "", index: computeColumnDropIndex(p, callbacks.measureColumns()) }`, else `computeDropTarget(p, callbacks.measure(), kind)`. `buildDisplaySlots`: filter out the dragged item when `drag` matches kind; insert `{type:"placeholder"}` at `drag.target.index` when `drag.target?.columnId === columnKey && drag.kind === kind`. `buildColumnSlots`: same for `kind === "column"` against `drag.target.index`. Include a `__resetForTesting()` export.

- [ ] **Step 4: Verify** — kanbanDrag tests PASS, full vitest PASS.

- [ ] **Step 5: Commit** — `feat(app): kanbanDrag controller + display-slot builders` + the trailer.

---

### Task 10: Hub board wiring — free-form cards drag end-to-end

**Files:**
- Create: `app/src/lib/kanbanDragGlue.ts` (DOM measurement, delegated events, auto-scroll loop)
- Create: `app/src/lib/KanbanDragPreview.svelte` (floating tilted preview layer)
- Modify: `app/src/lib/KanbanCard.svelte` (drop HTML5 attrs, add data attrs + keyboard open)
- Modify: `app/src/lib/KanbanColumn.svelte` (slot-based card list with flip + placeholder)
- Modify: `app/src/lib/KanbanBoard.svelte` (attach glue, render preview)

No new vitest tests (DOM-only glue); verification is svelte-check + manual.

**kanbanDragGlue.ts responsibilities** (keep it dumb — every decision already lives in Tasks 8–9):

```typescript
// Data-attribute contract (rendered by the components):
//   [data-kb-col]      column root; value = column id or "auto:<status>"; [data-kb-auto] marks auto
//   [data-kb-cards]    the scrollable card-list element inside a column
//   [data-kb-card]     free-form card wrapper; value = card id
//   [data-kb-plan]     plan card wrapper; value = plan path
//   [data-kb-colgrab]  column drag handle (header); value = column id
export interface BoardDragOptions {
  root: HTMLElement;
  allowCards: boolean;    // free-form card dragging (hub only)
  allowColumns: boolean;  // column dragging (hub only)
  commit: (drag: ActiveDrag & { target: DropTarget }) => void;
  click: (kind: DragKind, id: string) => void;
}
export function attachBoardDrag(opts: BoardDragOptions): () => void
```

`attachBoardDrag` adds ONE `pointerdown` listener (delegation): ignore non-primary buttons and events whose target `closest("button, input, a, textarea")`; find the nearest `[data-kb-card] / [data-kb-plan] / [data-kb-colgrab]`; compute sourceColumnId + sourceIndex by walking the DOM (`closest("[data-kb-col]")`, index = position among the block's siblings); `root.setPointerCapture(e.pointerId)`; call `beginCandidate` with a `DragCallbacks` whose `measure` walks `root.querySelectorAll("[data-kb-col]")` building `MeasuredColumn[]` from `getBoundingClientRect()` (excluding the dragged id from card lists), and whose `measureColumns` collects `[data-kb-col]:not([data-kb-auto])` rects excluding the dragged column. `pointermove` → `movePointer`; `pointerup`/`pointercancel` → `endPointer`/`cancelDrag`; `keydown` Escape (window listener while active) → `cancelDrag`. It also owns the rAF auto-scroll loop while a drag is active: each frame, apply `autoScrollVelocity` for the board strip (horizontal, using `root`'s rect/scrollLeft) and for the column under the pointer (vertical, the `[data-kb-cards]` element), and call `refreshTarget()` after scrolling. Detach removes all listeners.

**KanbanCard.svelte**: remove `draggable`, `ondragstart`, `onclick`, and `handleDragStart`; the wrapper div keeps `role="button"` `tabindex="0"` and gains `onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}`; add `style="user-select: none"` via the `.card` CSS rule. (Opening by pointer becomes the glue's `click` callback — the card no longer handles it.)

**KanbanColumn.svelte**: delete every HTML5 handler (`handleColumnDragStart/DragOver/Drop`, `handleCardDragOver/Drop/SlotDragOver`) and the `draggable` attr. The card list becomes:

```svelte
<script>
  import { dragState, buildDisplaySlots } from "./kanbanDrag";
  import { flip } from "svelte/animate";
  const cardSlots = $derived(buildDisplaySlots(column.cards, (c) => c.id, $dragState, column.id, "card"));
  const planSlots = $derived(buildDisplaySlots(planCards, (p) => p.id, $dragState, column.id, "plan"));
</script>

<div class="column" data-kb-col={column.id}>
  <div class="header" data-kb-colgrab={column.id}>…existing header content…</div>
  <div class="cards" data-kb-cards>
    {#each cardSlots as slot (slot.type === "item" ? slot.item.id : "__ph__")}
      <div animate:flip={{ duration: 150 }}>
        {#if slot.type === "item"}
          <div data-kb-card={slot.item.id}>
            <KanbanCard card={slot.item} … />
          </div>
        {:else}
          <div class="slot-placeholder" style:height="{$dragState?.size.height ?? 40}px"></div>
        {/if}
      </div>
    {/each}
    {#each planSlots as slot (slot.type === "item" ? slot.item.id : "__ph__")}
      …same shape with data-kb-plan={slot.item.id} and PlanKanbanCard…
    {/each}
  </div>
  …add-card button…
</div>
```

`.slot-placeholder`: `border: 1px dashed #555; border-radius: 6px; background: #202020; margin-bottom: 6px;`.

**KanbanBoard.svelte**: `bind:this={boardEl}` on `.board`; an `$effect` attaching/detaching the glue:

```typescript
$effect(() => {
  if (!boardEl) return;
  return attachBoardDrag({
    root: boardEl,
    allowCards: true,
    allowColumns: true,
    commit: handleDragCommit,
    click: (kind, id) => {
      if (kind === "card") openCardId = id;
      else if (kind === "plan") openPlanPath = id;
    },
  });
});

function handleDragCommit(drag: ActiveDrag & { target: DropTarget }): void {
  if (drag.kind === "card") {
    void moveCardAction(workspaceId, drag.id, drag.target.columnId, drag.target.index);
  }
  // "column" in Task 11, "plan" in Task 12
}
```

Render `<KanbanDragPreview {board} merged={merged} labels={board.labels} />` inside the board wrapper. **KanbanDragPreview.svelte**: reads `$dragState`; when active, looks up the dragged card (`board` for cards, `merged` for plans — columns render a simple shell with the column name); renders in a `position: fixed; pointer-events: none; z-index: 1000` div at `left/top = pointer − grabOffset`, `width = size.width`, `transform: rotate(3deg)`, `box-shadow: 0 8px 24px rgba(0,0,0,0.5)`. Reuse `KanbanCard`/`PlanKanbanCard` inside it with no-op callbacks.

- [ ] **Step 1: Implement `kanbanDragGlue.ts`** per the contract above.
- [ ] **Step 2: Implement `KanbanDragPreview.svelte`.**
- [ ] **Step 3: Rewire `KanbanCard.svelte`, `KanbanColumn.svelte`, `KanbanBoard.svelte`** as specified. Column drag handles and plan drops keep compiling (their HTML5 paths are gone; columns/plans just don't drag until Tasks 11–12 — clicking still works via the glue).
- [ ] **Step 4: Verify** — `npx svelte-check` 0 errors; full vitest PASS; then `cd app && npm run tauri dev`, Smoke Test workspace → Seed demo data, and manually confirm: click opens modal without drag; drag shows tilted preview + placeholder; **downward same-column move lands exactly at the placeholder** (the old off-by-one repro); cross-column works; Escape cancels; auto-scroll at board edge; flip animation on reflow.
- [ ] **Step 5: Commit** — `feat(app): pointer-drag engine wired for free-form cards on the hub board` + the trailer.

---

### Task 11: Hub board — column drag

**Files:**
- Modify: `app/src/lib/KanbanBoard.svelte`
- Modify: `app/src/lib/KanbanColumn.svelte` (only if the grab-handle cursor CSS lives there)

- [ ] **Step 1: Render the column strip through `buildColumnSlots`:** in `KanbanBoard.svelte`, wrap the `{#each board.columns}` in slots (`buildColumnSlots(board.columns, (c) => c.id, $dragState)`), each slot child carrying `animate:flip={{ duration: 150 }}`; the placeholder is an empty column-shaped div (`width: 240px; border: 1px dashed #555; border-radius: 8px; align-self: stretch;`). Keep auto columns and the add-column button outside the slotted strip, after it.
- [ ] **Step 2: Commit handler:** in `handleDragCommit`, add:

```typescript
if (drag.kind === "column") {
  void reorderColumnAction(workspaceId, drag.id, drag.target.index);
}
```

(The controller already skips no-op drops.) Add `cursor: grab` to the header CSS; the glue's `[data-kb-colgrab]` from Task 10 already starts the drag; `merged.columns[columnIndex]` lookups must key by column id (`merged` is derived from the same board array — verify the pairing still holds while a drag is live, since slots only affect rendering, not `board.columns`).
- [ ] **Step 3: Verify** — svelte-check 0 errors; manual: drag a column by its header in both directions — it lands exactly at the placeholder (old defect 2 repro was direction-dependent); card drags inside columns still work; column click-targets (rename) still work.
- [ ] **Step 4: Commit** — `feat(app): column reordering via pointer drag` + the trailer.

---

### Task 12: Hub board — plan-card drag with ordering + auto columns

**Files:**
- Create: `app/src/lib/AutoKanbanColumn.svelte`
- Modify: `app/src/lib/KanbanBoard.svelte`

**Interfaces:**
- Consumes: `applyPlanDrop` (Task 5), `PlanCardView.order` (Task 3), slots (Task 9).

- [ ] **Step 1: Extract `AutoKanbanColumn.svelte`** from KanbanBoard's inline auto-column markup: props `{ status: string; planCards: PlanCardView[]; onOpenPlan: (path: string) => void }`; root div `data-kb-col={"auto:" + status} data-kb-auto`, dashed styling moved from KanbanBoard, plan cards rendered through `buildDisplaySlots(planCards, (p) => p.id, $dragState, "auto:" + status, "plan")` with flip + `data-kb-plan` wrappers, same as Task 10's plan block.
- [ ] **Step 2: Plan commit in `handleDragCommit`:**

```typescript
if (drag.kind === "plan") {
  const targetKey = drag.target.columnId;
  const isAuto = targetKey.startsWith("auto:");
  const planCards = isAuto
    ? (merged?.autoColumns.find((a) => "auto:" + a.status === targetKey)?.planCards ?? [])
    : (merged?.columns.find((dc) => dc.column.id === targetKey)?.planCards ?? []);
  const statusTarget =
    drag.sourceColumnId === targetKey
      ? null
      : isAuto
        ? targetKey.slice("auto:".length)
        : (board?.columns.find((c) => c.id === targetKey)?.name ?? null);
  void applyPlanDrop({
    workspaceId,
    path: drag.id,
    statusTarget,
    targetColumn: planCards.filter((p) => p.id !== drag.id).map((p) => ({ path: p.id, order: p.order })),
    targetIndex: drag.target.index,
  }).then((err) => {
    if (err) planWriteError = err;
  });
}
```

Delete the now-dead `setPlanStatus` + `onPlanDrop` prop chain (KanbanBoard → KanbanColumn) and KanbanBoard's HTML5 auto-column handlers.
- [ ] **Step 3: Verify** — svelte-check 0 errors; vitest PASS; manual: reorder plan cards within a column (placeholder honest, lands where shown; `order:` lines appear in the files — check with `cat`); drag across columns updates `status:` + order; drop on an auto column adopts its status; free-form cards cannot target auto columns; the ⚠ broken-frontmatter seed card still drags (status write still works on it).
- [ ] **Step 4: Commit** — `feat(app): plan cards manually orderable; auto columns share the engine` + the trailer.

---

### Task 13: BoardPane consolidation (planOnly mode)

**Files:**
- Modify: `app/src/lib/KanbanColumn.svelte` (new `mode` prop)
- Modify: `app/src/lib/BoardPane.svelte` (render KanbanColumn/AutoKanbanColumn; delete hand-rolled columns)

**Interfaces:**
- Produces: `KanbanColumn` prop `mode: "full" | "planOnly"` (default `"full"`). planOnly: no free-form cards, no add-card button, no rename/delete (header is plain text + count, no `data-kb-colgrab`), plan cards fully draggable.

- [ ] **Step 1: Add `mode` to KanbanColumn** — `{#if mode === "full"}` around: the free-form `cardSlots` block, the add-card button, rename input/handlers, delete button, and the `data-kb-colgrab` attribute (planOnly header is a plain div). Everything else (plan slots, data attrs, flip) is shared.
- [ ] **Step 2: Rewrite BoardPane's board area** to `KanbanColumn mode="planOnly"` per merged column + `AutoKanbanColumn` per auto column + `KanbanDragPreview` + an `$effect` attaching `attachBoardDrag({ root, allowCards: false, allowColumns: false, commit, click })` with the same plan-commit handler as Task 12 (extract that handler into a small shared helper in `planDrop.ts` — `planCommitFromMerged(workspaceId, drag, board, merged)` returning the error-or-null promise — so hub and pane don't duplicate it; move the Task 12 hub code to use it too). Keep BoardPane's overlays (`error` / `contextExists` / loading) untouched. Delete `allowPlanDrop`/`dropOn`/`setPlanStatus` and the hand-rolled column markup/CSS.
- [ ] **Step 3: Verify** — svelte-check 0; vitest PASS; manual: open a context board beside a terminal — same drag feel, plan reorder + restatus works, no free-form cards/composers appear, column headers not draggable/renamable there; hub board unaffected.
- [ ] **Step 4: Commit** — `refactor(app): BoardPane renders through KanbanColumn (planOnly mode)` + the trailer.

---

### Task 14: Remove kanban kinds from HTML5 dragDrop

**Files:**
- Modify: `app/src/lib/dragDrop.ts` (union + DRAG_KINDS, lines 9–27)
- Modify: `app/src/lib/Sidebar.svelte` (dead guards at lines ~245 and ~283)
- Test: `app/src/lib/dragDrop.test.ts` (drop kanban-kind cases)

- [ ] **Step 1: Delete** `"kanban-card" | "kanban-column" | "plan-card"` variants from `DragPayload` and `DRAG_KINDS`. Run `npx svelte-check` — fix every resulting error: the two Sidebar guard branches (delete the branches; keep the surrounding logic), any dragDrop.test.ts cases for those kinds (delete them), and anything else it flags. Grep `kanban-card\|kanban-column\|plan-card` across `app/src` — the only survivors should be historical docs, `smokeChecklist.ts` copy (updated in Task 17), and nothing in live code.
- [ ] **Step 2: Verify** — svelte-check 0 errors; full vitest PASS; manual: sidebar workspace/page reordering and pane/tab drags still work (they share `dragDrop.ts`).
- [ ] **Step 3: Commit** — `refactor(app): kanban drag kinds leave the HTML5 dragDrop payload` + the trailer.

---

### Task 15: Save-error banner + staleness wiring

**Files:**
- Modify: `app/src/lib/KanbanBoard.svelte`, `app/src/lib/BoardPane.svelte`

**Interfaces:**
- Consumes: `saveErrors`, `dismissSaveError`, `refreshBoard` (Task 7).

- [ ] **Step 1: Banner.** In KanbanBoard, derive `const saveError = $derived($saveErrors[workspaceId] ?? null);` and render it exactly like the existing `plan-error` strip (same CSS class, message `Couldn't save: {saveError}`, ✕ → `dismissSaveError(workspaceId)`), above the board next to `planWriteError`. Same in BoardPane.
- [ ] **Step 2: Staleness.** In both components add:

```typescript
$effect(() => {
  const onFocus = () => void refreshBoard(workspaceId);
  window.addEventListener("focus", onFocus);
  return () => window.removeEventListener("focus", onFocus);
});
```

In BoardPane additionally refetch on reveal: `$effect(() => { if (visible) void refreshBoard(workspaceId); });` — and in KanbanBoard refetch once on mount (`$effect(() => { void refreshBoard(workspaceId); })`, alongside the existing `fetchBoard`), since the hub board remounts when its tab is revisited (`refreshBoard`'s in-flight guard makes this safe).
- [ ] **Step 3: Verify** — svelte-check 0; manual: `pkill -x gavin-daemon`, drag a card → card snaps back + banner appears; use the recovery flow, next drag succeeds and clears the banner; window blur/refocus refetches (edit SQLite via a second instance if handy, else confirm no flicker/regression).
- [ ] **Step 4: Commit** — `feat(app): save-failure banner + focus/visibility board refresh` + the trailer.

---

### Task 16: Inline composers

**Files:**
- Modify: `app/src/lib/KanbanColumn.svelte` (add-card composer), `app/src/lib/KanbanBoard.svelte` (add-column composer)

- [ ] **Step 1: Card composer.** Replace the `+ Add card` button behavior: clicking sets `composing = true`, rendering at the list bottom:

```svelte
{#if composing}
  <textarea
    class="composer"
    rows="2"
    placeholder="Card title…"
    bind:value={composerText}
    bind:this={composerEl}
    onkeydown={(e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitComposer(); }
      if (e.key === "Escape") cancelComposer();
    }}
    onblur={() => (composerText.trim() ? commitComposer() : cancelComposer())}
  ></textarea>
{:else}
  <button type="button" class="add-card" onclick={openComposer}>+ Add card</button>
{/if}
```

`openComposer` focuses via `$effect`/`tick`; `commitComposer` trims, requires non-empty, calls the existing `onAddCard` **changed to `onAddCard(title: string)`** (KanbanBoard's `addCardTo(columnId, title)` uses the title instead of `"New card"`), clears the text, and **keeps the composer open** (Trello-style rapid entry); `cancelComposer` closes it. Composer hidden in planOnly mode (inside the Task 13 `mode === "full"` guard).
- [ ] **Step 2: Column composer.** Same pattern for `+ Add column` in KanbanBoard (single-line `<input>`, Enter commits `addColumn(name)` — no more `"New column"` — Esc/empty-blur cancels, stays open on commit).
- [ ] **Step 3: Verify** — svelte-check 0; manual: Enter adds with typed title and keeps the field; Esc closes; blur with text commits; empty commit is a no-op; card lands at column end.
- [ ] **Step 4: Commit** — `feat(app): inline card/column composers` + the trailer.

---

### Task 17: Hover affordances, counts, drop-settle

**Files:**
- Modify: `app/src/lib/KanbanCard.svelte`, `app/src/lib/KanbanColumn.svelte`, `app/src/lib/KanbanDragPreview.svelte`, `app/src/lib/AutoKanbanColumn.svelte`

- [ ] **Step 1: Hover affordances.** KanbanCard's `.delete`: `opacity: 0; transition: opacity 120ms;` with `.card:hover .delete, .card:focus-within .delete { opacity: 1; }`. Card hover lift: `.card { transition: box-shadow 120ms, border-color 120ms; } .card:hover { border-color: #666; box-shadow: 0 2px 8px rgba(0,0,0,0.35); }` (same treatment in PlanKanbanCard if its delete-less header allows — hover lift only).
- [ ] **Step 2: Counts.** KanbanColumn header gains `<span class="count">{column.cards.length + planCards.length}</span>` (planOnly: `planCards.length`; AutoKanbanColumn: its planCards length) styled `color: #888; font-weight: normal; font-size: 0.85em; margin-left: 6px;`.
- [ ] **Step 3: Drop-settle.** In KanbanDragPreview, when `$dragState` transitions active → null after a commit, keep the last preview rendered and animate `left/top` to the just-dropped card's slot rect (query `[data-kb-card="<id>"]`/`[data-kb-plan="<id>"]` post-commit via `requestAnimationFrame`), `transition: transform 140ms ease, left 140ms, top 140ms; transform: rotate(0deg)`, then remove it. If the slot lookup fails (e.g. plan card moved out of the filtered view), just remove the preview immediately.
- [ ] **Step 4: Verify** — svelte-check 0; manual polish pass: hover shows delete, counts correct on all three column flavors, release visually settles into the slot, nothing jumps.
- [ ] **Step 5: Commit** — `feat(app): kanban hover affordances, counts, drop-settle` + the trailer.

---

### Task 18: A11y — kanban warnings to zero

**Files:**
- Modify: whatever `npx svelte-check` lists in kanban files (expected: KanbanCard, PlanKanbanCard, KanbanColumn, KanbanBoard, AutoKanbanColumn, BoardPane)

- [ ] **Step 1: Run `npx svelte-check`** and list every remaining warning in the kanban components (baseline was 8; Tasks 10–17 fixed some and must not have added any).
- [ ] **Step 2: Fix each for real** — no `<!-- svelte-ignore -->` suppressions: keyboard handlers where interactivity exists (cards already got Enter/Space in Task 10; verify PlanKanbanCard did too), the column-rename `<span role="button">` becomes a real `<button class="name">` styled as text (`background: none; border: none; padding: 0; font: inherit; color: inherit; text-align: left; cursor: text;`), `role="list"` divs get matching semantics or lose the role.
- [ ] **Step 3: Verify** — `npx svelte-check` → 0 errors AND 0 warnings in kanban files; keyboard pass: Tab reaches cards, Enter opens, Esc closes modal, rename reachable by keyboard.
- [ ] **Step 4: Commit** — `fix(app): kanban a11y warnings to zero` + the trailer.

---

### Task 19: Smoke checklist + fixture README

**Files:**
- Modify: `app/src/lib/smokeChecklist.ts` (+ its test if item ids are asserted), `test-fixtures/gavin-orchestration/README.md`

- [ ] **Step 1: Update the checklist sections** covering the board: replace HTML5-era items with the new interactions, stable new ids, e.g.: `drag-threshold` (click opens, small jiggle doesn't), `drag-placeholder` (placeholder gap matches landing spot, downward same-column included), `drag-tilt` (tilted preview + settle), `drag-autoscroll` (board edge + column edge), `plan-reorder` (plan card reorder writes `order:` and survives the ~3s watcher echo), `plan-restatus-order` (cross-column writes status + order), `column-reorder` (both directions exact), `composer-card` / `composer-column`, `save-failure` (kill daemon → snap-back + banner), `board-refresh` (refocus refetches). Keep hints in the existing voice. Update the fixture README's step-by-step to match.
- [ ] **Step 2: Verify** — `npx vitest run src/lib/smokeChecklist.test.ts` PASS (fix id assertions), svelte-check 0.
- [ ] **Step 3: Commit** — `docs(app): smoke checklist covers the pointer-drag board` + the trailer.

---

### Task 20: Final verification sweep

- [ ] **Step 1: Full suites** — `cargo test` (all green), `cd app && npx vitest run` (all green), `npx svelte-check` (0 errors, kanban warnings 0).
- [ ] **Step 2: Full manual smoke pass** — `npm run tauri dev`, Seed demo data, walk the ENTIRE updated checklist including the pre-existing sections (plans on the board, per-session boards, agents page) to catch regressions; both surfaces; broken-frontmatter card; daemon-kill recovery.
- [ ] **Step 3: Close the loop** — append any incidents/decisions discovered during execution to `docs/superpowers/brainstorms/2026-08-19-kanban-trello-brainstorm.md`; set the gavin plan card for this work to Done.
- [ ] **Step 4: Commit** any doc/checklist stragglers — `docs: kanban rework execution log` + the trailer. Do not push.
