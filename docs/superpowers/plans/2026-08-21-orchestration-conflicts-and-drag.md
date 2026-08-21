# Orchestration Tab — SP2 "Conflicts and direct manipulation" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Orchestration tab shows what will collide and lets you rearrange it by hand — a conflicts box with severity colour and pairing badges, drag to build sequential or parallel stages, an unplaced-cards drawer, and real worktree/page binding.

**Architecture:** Conflict detection is one more pure function in `orchestration.ts`, computed at render time from the plan, the gavin tree and the worktree list — no new persistence. Drag gets its own pure hit-tester (`orchestrationDrag.ts`) and DOM glue (`orchestrationDragGlue.ts`) rather than bending the kanban engine: the geometry is genuinely different (rails are columns, stages are rows, a stage's middle band means "make this parallel"), but the primitives (`exceedsThreshold`, `autoScrollVelocity`) and the WKWebView gesture pattern are reused verbatim. Binding gets a small dedicated dialog that delegates worktree creation to the existing `GitForkDialog`.

**Tech Stack:** Svelte 5 (runes), TypeScript, vitest. No Rust changes in SP2.

**Spec:** `docs/superpowers/specs/2026-08-21-orchestration-tab-design.md` — read it alongside this plan, especially §5 (conflicts), §6.3–6.5 (box, colouring, drag) and §7 (bindings).

**Depends on:** SP1 (`docs/superpowers/plans/2026-08-21-orchestration-rails-that-run.md`) must be complete and merged. This plan assumes `orchestration.ts`, `orchestrationState.ts`, `OrchestrationHubView.svelte`, `OrchestrationRail.svelte` and `OrchestrationStepChip.svelte` exist as SP1 left them.

## Global Constraints

- **Gavin never blocks a run because of a conflict** (spec O4). Everything here is display and repair; no code path may refuse to launch a step because a conflict exists.
- **Two independent colour axes** (spec O9): *severity* is the colour (`--surface-danger`/`--border-danger` for `live`, `--surface-warning`/`--border-warning` for `potential`), *group identity* is a number badge. Never encode pairing as a hue. The `--lane-*` tokens stay reserved for the git graph.
- Conflicts are **computed at render time and never persisted**. The only stored conflict data is `conflictNotes`, which the agent writes (SP3).
- `detectConflicts` takes `worktrees: WorktreeInfo[] | null`; **null means "not loaded yet"** and must suppress `worktree-missing`, exactly as `nextActions` already does.
- Drag indices are computed against lists **with the dragged step excluded**, so they are post-removal indices by construction — the same contract `kanbanDrag` documents.
- Do not modify `pointerDrag.ts`, `kanbanDrag.ts`, `kanbanDragGlue.ts` or `KanbanDragPreview.svelte`. Import from `pointerDrag.ts`; leave the kanban engine alone.
- Svelte components carry no unit tests in this project; all logic under test lives in `orchestration.ts`, `orchestrationDrag.ts` and `orchestrationState.ts`.
- Test commands: `cd app && npm test`; type check `cd app && npm run check`.
- Commit after every task.

---

### Task 0: Plan card on the board

**Files:**
- Create: `.gavin-root/plans/orchestration-conflicts-and-drag.md`

- [ ] **Step 1: Create the card**

```
gavin_create_plan(
  context_folder: ".gavin-root",
  file_name: "orchestration-conflicts-and-drag",
  title: "Orchestration tab — Conflicts and direct manipulation (SP2 of 3)",
  status: "In Progress",
  priority: "high",
  kind: "plan",
  body: <the markdown below>
)
```

Body:

```markdown
# Orchestration tab — Conflicts and direct manipulation (SP2 of 3)

The conflicts box, severity colouring with pairing badges, drag to build
sequential or parallel stages, the unplaced-cards drawer, and real
worktree/page binding.

Spec: `docs/superpowers/specs/2026-08-21-orchestration-tab-design.md`
Plan: `docs/superpowers/plans/2026-08-21-orchestration-conflicts-and-drag.md`

## Steps

- [ ] `detectConflicts`, numbering and lookup helpers (+ tests)
- [ ] Conflicts box with hover linking
- [ ] Severity colouring and pairing badges on chips and rail headers
- [ ] Move mutators for steps between stages and rails (+ tests)
- [ ] `orchestrationDrag.ts` pure hit-testing (+ tests)
- [ ] `orchestrationDragGlue.ts` controller and DOM glue
- [ ] Drag wiring: data attributes, placeholders, floating preview
- [ ] Unplaced-cards drawer
- [ ] Rail binding dialog: worktree and page
```

- [ ] **Step 2: Commit**

```bash
git add .gavin-root/plans/orchestration-conflicts-and-drag.md
git commit -m "docs(plan): orchestration SP2 card"
```

Tick each item as you finish the matching task.

---

### Task 1: `detectConflicts`

**Files:**
- Modify: `app/src/lib/orchestration.ts`
- Modify: `app/src/lib/orchestration.test.ts`

**Interfaces:**
- Consumes: SP1's `Orchestration`, `Rail`, `cardIndex`, `effectiveWorktree`, `stepStateOf`, `CardEntry`.
- Produces: `ConflictSeverity`, `Conflict`, `NumberedConflict`; `detectConflicts(orch, tree, worktrees) → Conflict[]`; `numberConflicts(conflicts) → NumberedConflict[]`; `numbersForStep(numbered, stepId) → number[]`; `numbersForRail(numbered, railId) → number[]`; `severityForStep(numbered, stepId) → ConflictSeverity | null`; `severityForRail(numbered, railId) → ConflictSeverity | null`; `describeConflict(c, cards, orch) → string`.

- [ ] **Step 1: Write the failing tests**

Append to `app/src/lib/orchestration.test.ts`. The helpers `board`, `plan`, `tree`, `rail` from SP1's Task 5 are already in scope.

```ts
import {
  detectConflicts,
  numberConflicts,
  numbersForStep,
  numbersForRail,
  severityForStep,
} from "./orchestration";
import type { Conflict } from "./orchestration";
import type { WorktreeInfo } from "./git";

const WT: WorktreeInfo[] = [
  { path: "/x/main", head: "a", branch: "main", isMain: true, locked: false, prunable: false },
  { path: "/x/wt-a", head: "b", branch: "a", isMain: false, locked: false, prunable: false },
];

function bound(id: string, worktreePath: string | null, stages: Array<Array<[string, string]>>) {
  return { ...rail(id, stages), worktreePath };
}

function orchOf(rails: ReturnType<typeof bound>[], overrides: Partial<Orchestration> = {}): Orchestration {
  return { ...emptyOrchestration(), rails, ...overrides };
}

const CARDS = tree([plan("a.md"), plan("b.md"), plan("c.md")]);
const A = "/ws/.gavin-root/plans/a.md";
const B = "/ws/.gavin-root/plans/b.md";
const C = "/ws/.gavin-root/plans/c.md";

describe("detectConflicts — same worktree", () => {
  it("flags a parallel stage: two agents in one checkout", () => {
    const o = orchOf([bound("r1", "/x/wt-a", [[["t1", A], ["t2", B]]])]);
    const found = detectConflicts(o, CARDS, WT);
    expect(found).toEqual([
      {
        kind: "same-worktree",
        scope: "stage",
        severity: "potential",
        stepIds: ["t1", "t2"],
        worktreePath: "/x/wt-a",
      },
    ]);
  });

  it("does NOT flag different stages of one rail — they are strictly sequential", () => {
    const o = orchOf([bound("r1", "/x/wt-a", [[["t1", A]], [["t2", B]]])]);
    expect(detectConflicts(o, CARDS, WT)).toEqual([]);
  });

  it("flags two rails sharing a worktree, whatever stage each is on", () => {
    const o = orchOf([
      bound("r1", "/x/wt-a", [[["t1", A]], [["t2", B]]]),
      bound("r2", "/x/wt-a", [[["t3", C]]]),
    ]);
    const found = detectConflicts(o, CARDS, WT);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "same-worktree", scope: "rails", worktreePath: "/x/wt-a" });
    expect(found[0].kind === "same-worktree" && found[0].stepIds.sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("does not flag rails on different worktrees", () => {
    const o = orchOf([
      bound("r1", "/x/wt-a", [[["t1", A]]]),
      bound("r2", "/x/main", [[["t2", B]]]),
    ]);
    expect(detectConflicts(o, CARDS, WT)).toEqual([]);
  });

  it("ignores done steps", () => {
    const o = orchOf([bound("r1", "/x/wt-a", [[["t1", A], ["t2", B]]])], {
      stepRuns: [{ stepId: "t1", state: "done", sessionId: null, reason: null }],
    });
    expect(detectConflicts(o, CARDS, WT)).toEqual([]);
  });

  it("is live when two of the group are actually running", () => {
    const o = orchOf([bound("r1", "/x/wt-a", [[["t1", A], ["t2", B]]])], {
      stepRuns: [
        { stepId: "t1", state: "running", sessionId: "s1", reason: null },
        { stepId: "t2", state: "running", sessionId: "s2", reason: null },
      ],
    });
    expect(detectConflicts(o, CARDS, WT)[0].severity).toBe("live");
  });

  it("is only potential when a single step of the group is running", () => {
    const o = orchOf([bound("r1", "/x/wt-a", [[["t1", A], ["t2", B]]])], {
      stepRuns: [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }],
    });
    expect(detectConflicts(o, CARDS, WT)[0].severity).toBe("potential");
  });

  it("treats unbound rails by their cards' context folder, so two unbound rails collide", () => {
    const o = orchOf([bound("r1", null, [[["t1", A]]]), bound("r2", null, [[["t2", B]]])]);
    const found = detectConflicts(o, CARDS, WT);
    expect(found.some((c) => c.kind === "same-worktree" && c.worktreePath === "/ws/.gavin-root")).toBe(true);
  });
});

describe("detectConflicts — the other kinds", () => {
  it("flags the same card placed on two steps", () => {
    const o = orchOf([bound("r1", "/x/wt-a", [[["t1", A]], [["t2", A]]])]);
    const found = detectConflicts(o, CARDS, WT);
    expect(found).toContainEqual({
      kind: "duplicate-card",
      severity: "potential",
      stepIds: ["t1", "t2"],
      cardPath: A,
    });
  });

  it("flags a rail whose bound worktree is gone", () => {
    const o = orchOf([bound("r1", "/x/vanished", [[["t1", A]]])]);
    expect(detectConflicts(o, CARDS, WT)).toContainEqual({
      kind: "worktree-missing",
      severity: "potential",
      railId: "r1",
      worktreePath: "/x/vanished",
    });
  });

  it("suppresses worktree-missing while the worktree list is unknown", () => {
    const o = orchOf([bound("r1", "/x/vanished", [[["t1", A]]])]);
    expect(detectConflicts(o, CARDS, null).some((c) => c.kind === "worktree-missing")).toBe(false);
  });

  it("flags an unbound rail that has steps", () => {
    const o = orchOf([bound("r1", null, [[["t1", A]]])]);
    expect(detectConflicts(o, CARDS, WT)).toContainEqual({
      kind: "rail-unbound",
      severity: "potential",
      railId: "r1",
    });
  });

  it("does not flag an unbound rail with no steps — that is just unfinished setup", () => {
    const o = orchOf([bound("r1", null, [])]);
    expect(detectConflicts(o, CARDS, WT)).toEqual([]);
  });

  it("surfaces the agent's declared notes", () => {
    const o = orchOf([bound("r1", "/x/wt-a", [[["t1", A]], [["t2", B]]])], {
      conflictNotes: [{ id: "n1", stepIds: ["t1", "t2"], note: "both rewrite GitDiff.svelte" }],
    });
    expect(detectConflicts(o, CARDS, WT)).toContainEqual({
      kind: "declared",
      severity: "potential",
      id: "n1",
      stepIds: ["t1", "t2"],
      note: "both rewrite GitDiff.svelte",
    });
  });
});

describe("numberConflicts", () => {
  it("puts live first, then orders by kind, and numbers from one", () => {
    const conflicts: Conflict[] = [
      { kind: "rail-unbound", severity: "potential", railId: "r9" },
      { kind: "declared", severity: "potential", id: "n1", stepIds: ["t1"], note: "x" },
      { kind: "same-worktree", scope: "stage", severity: "live", stepIds: ["t1", "t2"], worktreePath: "/x/wt-a" },
      { kind: "duplicate-card", severity: "potential", stepIds: ["t3", "t4"], cardPath: A },
    ];
    expect(numberConflicts(conflicts).map((n) => [n.n, n.conflict.kind])).toEqual([
      [1, "same-worktree"],
      [2, "duplicate-card"],
      [3, "rail-unbound"],
      [4, "declared"],
    ]);
  });

  it("is stable for two conflicts of the same kind and severity", () => {
    const conflicts: Conflict[] = [
      { kind: "duplicate-card", severity: "potential", stepIds: ["t9"], cardPath: B },
      { kind: "duplicate-card", severity: "potential", stepIds: ["t1"], cardPath: A },
    ];
    expect(numberConflicts(conflicts).map((n) => n.conflict)).toEqual([
      { kind: "duplicate-card", severity: "potential", stepIds: ["t1"], cardPath: A },
      { kind: "duplicate-card", severity: "potential", stepIds: ["t9"], cardPath: B },
    ]);
  });
});

describe("conflict lookups", () => {
  const numbered = numberConflicts([
    { kind: "same-worktree", scope: "stage", severity: "live", stepIds: ["t1", "t2"], worktreePath: "/x/wt-a" },
    { kind: "duplicate-card", severity: "potential", stepIds: ["t2", "t3"], cardPath: A },
    { kind: "rail-unbound", severity: "potential", railId: "r2" },
  ]);

  it("collects every badge a step belongs to", () => {
    expect(numbersForStep(numbered, "t2")).toEqual([1, 2]);
    expect(numbersForStep(numbered, "t7")).toEqual([]);
  });

  it("collects rail-level badges separately", () => {
    expect(numbersForRail(numbered, "r2")).toEqual([3]);
  });

  it("takes the highest severity when a step is in several conflicts", () => {
    expect(severityForStep(numbered, "t2")).toBe("live");
    expect(severityForStep(numbered, "t3")).toBe("potential");
    expect(severityForStep(numbered, "t7")).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd app && npm test -- orchestration`
Expected: FAIL — `detectConflicts is not a function`.

- [ ] **Step 3: Implement it**

Append to `app/src/lib/orchestration.ts`:

```ts
// ---- Conflicts -------------------------------------------------------------
// Computed at render time from the plan, the tree and the worktree list;
// nothing here is persisted. Gavin never BLOCKS on any of this (spec
// O4) -- the box and the colouring are the whole intervention.

export type ConflictSeverity = "live" | "potential";

export type Conflict =
  | {
      kind: "same-worktree";
      /// "stage" -- a parallel stage, two agents deliberately put in one
      /// checkout. "rails" -- two or more rails bound to one checkout,
      /// which have no ordering guarantee between them.
      scope: "stage" | "rails";
      severity: ConflictSeverity;
      stepIds: string[];
      worktreePath: string;
    }
  | { kind: "duplicate-card"; severity: "potential"; stepIds: string[]; cardPath: string }
  | { kind: "worktree-missing"; severity: "potential"; railId: string; worktreePath: string }
  | { kind: "rail-unbound"; severity: "potential"; railId: string }
  | { kind: "declared"; severity: "potential"; id: string; stepIds: string[]; note: string };

export interface NumberedConflict {
  /// The badge, 1-based. Shared by the box row and every chip in it --
  /// pairing is carried by this number, never by a hue (spec O9).
  n: number;
  conflict: Conflict;
}

const KIND_ORDER: Conflict["kind"][] = [
  "same-worktree",
  "duplicate-card",
  "worktree-missing",
  "rail-unbound",
  "declared",
];

export function conflictStepIds(c: Conflict): string[] {
  return c.kind === "worktree-missing" || c.kind === "rail-unbound" ? [] : c.stepIds;
}

export function conflictRailId(c: Conflict): string | null {
  return c.kind === "worktree-missing" || c.kind === "rail-unbound" ? c.railId : null;
}

interface PlacedStep {
  stepId: string;
  railId: string;
  stageId: string;
  cardPath: string;
  worktree: string | null;
  state: StepState;
}

function placedSteps(orch: Orchestration, cards: Map<string, CardEntry>): PlacedStep[] {
  const out: PlacedStep[] = [];
  for (const rail of orch.rails) {
    for (const stage of rail.stages) {
      for (const step of stage.steps) {
        out.push({
          stepId: step.id,
          railId: rail.id,
          stageId: stage.id,
          cardPath: step.cardPath,
          worktree: effectiveWorktree(rail, cards.get(step.cardPath)),
          state: stepStateOf(orch, step.id),
        });
      }
    }
  }
  return out;
}

/// live when at least TWO of the group are actually running right now --
/// one running step cannot collide with anything by itself.
function severityOf(group: PlacedStep[]): ConflictSeverity {
  return group.filter((s) => s.state === "running").length >= 2 ? "live" : "potential";
}

export function detectConflicts(
  orch: Orchestration,
  tree: GavinTree | undefined,
  worktrees: WorktreeInfo[] | null
): Conflict[] {
  const cards = cardIndex(tree);
  const steps = placedSteps(orch, cards).filter((s) => s.state !== "done");
  const conflicts: Conflict[] = [];

  // 1. A parallel stage IS a same-worktree conflict by construction: its
  // steps share the rail's checkout. That is intended, and saying so out
  // loud beats pretending it is safe (spec §5).
  const byStage = new Map<string, PlacedStep[]>();
  for (const s of steps) {
    if (!s.worktree) continue;
    const group = byStage.get(s.stageId) ?? [];
    group.push(s);
    byStage.set(s.stageId, group);
  }
  for (const group of byStage.values()) {
    if (group.length < 2) continue;
    conflicts.push({
      kind: "same-worktree",
      scope: "stage",
      severity: severityOf(group),
      stepIds: group.map((s) => s.stepId),
      worktreePath: group[0].worktree as string,
    });
  }

  // 2. Across rails there is NO ordering guarantee, so every not-done
  // step in a shared checkout is a potential collision with every other.
  // Reported once per worktree rather than as a pair explosion.
  const byWorktree = new Map<string, PlacedStep[]>();
  for (const s of steps) {
    if (!s.worktree) continue;
    const group = byWorktree.get(s.worktree) ?? [];
    group.push(s);
    byWorktree.set(s.worktree, group);
  }
  for (const [worktreePath, group] of byWorktree) {
    if (new Set(group.map((s) => s.railId)).size < 2) continue;
    conflicts.push({
      kind: "same-worktree",
      scope: "rails",
      severity: severityOf(group),
      stepIds: group.map((s) => s.stepId),
      worktreePath,
    });
  }

  // 3. One card on two steps would be run twice.
  const byCard = new Map<string, PlacedStep[]>();
  for (const s of steps) {
    const group = byCard.get(s.cardPath) ?? [];
    group.push(s);
    byCard.set(s.cardPath, group);
  }
  for (const [cardPath, group] of byCard) {
    if (group.length < 2) continue;
    conflicts.push({
      kind: "duplicate-card",
      severity: "potential",
      stepIds: group.map((s) => s.stepId),
      cardPath,
    });
  }

  // 4/5. Rail-level bindings. `worktrees === null` means the refs
  // snapshot has not loaded -- unknown must never read as "gone".
  const known = worktrees ? new Set(worktrees.map((w) => w.path)) : null;
  for (const rail of orch.rails) {
    if (rail.worktreePath) {
      if (known && !known.has(rail.worktreePath)) {
        conflicts.push({
          kind: "worktree-missing",
          severity: "potential",
          railId: rail.id,
          worktreePath: rail.worktreePath,
        });
      }
    } else if (rail.stages.some((s) => s.steps.length > 0)) {
      // An EMPTY unbound rail is just setup you have not finished.
      conflicts.push({ kind: "rail-unbound", severity: "potential", railId: rail.id });
    }
  }

  // 6. The agent's own judgement, rendered beside the computed ones.
  for (const note of orch.conflictNotes) {
    conflicts.push({
      kind: "declared",
      severity: "potential",
      id: note.id,
      stepIds: note.stepIds,
      note: note.note,
    });
  }

  return conflicts;
}

/// Live first, then by kind, then stably by the first id involved --
/// so a badge keeps its number across re-renders that changed nothing.
export function numberConflicts(conflicts: Conflict[]): NumberedConflict[] {
  const keyOf = (c: Conflict) => conflictStepIds(c)[0] ?? conflictRailId(c) ?? "";
  return [...conflicts]
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === "live" ? -1 : 1;
      const ka = KIND_ORDER.indexOf(a.kind);
      const kb = KIND_ORDER.indexOf(b.kind);
      if (ka !== kb) return ka - kb;
      return keyOf(a).localeCompare(keyOf(b));
    })
    .map((conflict, i) => ({ n: i + 1, conflict }));
}

export function numbersForStep(numbered: NumberedConflict[], stepId: string): number[] {
  return numbered.filter((x) => conflictStepIds(x.conflict).includes(stepId)).map((x) => x.n);
}

export function numbersForRail(numbered: NumberedConflict[], railId: string): number[] {
  return numbered.filter((x) => conflictRailId(x.conflict) === railId).map((x) => x.n);
}

function highestSeverity(matches: NumberedConflict[]): ConflictSeverity | null {
  if (matches.length === 0) return null;
  return matches.some((x) => x.conflict.severity === "live") ? "live" : "potential";
}

export function severityForStep(
  numbered: NumberedConflict[],
  stepId: string
): ConflictSeverity | null {
  return highestSeverity(numbered.filter((x) => conflictStepIds(x.conflict).includes(stepId)));
}

export function severityForRail(
  numbered: NumberedConflict[],
  railId: string
): ConflictSeverity | null {
  return highestSeverity(numbered.filter((x) => conflictRailId(x.conflict) === railId));
}

/// One line for the box. Titles come from the tree where the card
/// resolves, and fall back to the file name -- a conflict about a
/// missing card must still be describable.
export function describeConflict(
  c: Conflict,
  cards: Map<string, CardEntry>,
  orch: Orchestration
): string {
  const titleOfStep = (stepId: string): string => {
    for (const rail of orch.rails) {
      for (const stage of rail.stages) {
        for (const step of stage.steps) {
          if (step.id !== stepId) continue;
          return cards.get(step.cardPath)?.plan.title ?? (step.cardPath.split("/").pop() ?? step.cardPath);
        }
      }
    }
    return stepId;
  };
  const nameOfRail = (railId: string): string =>
    orch.rails.find((r) => r.id === railId)?.name ?? railId;
  const list = (ids: string[]): string => ids.map((id) => `“${titleOfStep(id)}”`).join(", ");

  const railNamesFor = (stepIds: string[]): string[] => {
    const names = new Set<string>();
    for (const rail of orch.rails) {
      for (const stage of rail.stages) {
        for (const step of stage.steps) {
          if (stepIds.includes(step.id)) names.add(rail.name);
        }
      }
    }
    return [...names];
  };

  switch (c.kind) {
    case "same-worktree": {
      if (c.scope === "stage") {
        return `${list(c.stepIds)} run in parallel in one checkout (${c.worktreePath})`;
      }
      const rails = railNamesFor(c.stepIds);
      return `rails ${rails.map((n) => `“${n}”`).join(" and ")} share ${c.worktreePath}: ${list(c.stepIds)}`;
    }
    case "duplicate-card":
      return `the same card is on two steps: ${list(c.stepIds)}`;
    case "worktree-missing":
      return `rail “${nameOfRail(c.railId)}” points at ${c.worktreePath}, which is not a worktree of this repo`;
    case "rail-unbound":
      return `rail “${nameOfRail(c.railId)}” has steps but no worktree — they will run in each card's own folder`;
    case "declared":
      return c.note;
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd app && npm test -- orchestration`
Expected: PASS — the whole orchestration suite, SP1's included.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/orchestration.ts app/src/lib/orchestration.test.ts
git commit -m "feat(app): orchestration conflict detection, numbering and lookups"
```

---

### Task 2: The conflicts box

**Files:**
- Create: `app/src/lib/OrchestrationConflicts.svelte`
- Modify: `app/src/lib/orchestrationState.ts`
- Modify: `app/src/lib/OrchestrationHubView.svelte`

**Interfaces:**
- Consumes: Task 1's `NumberedConflict`, `describeConflict`, `conflictStepIds`, `conflictRailId`.
- Produces: `highlightedConflict` (a `writable<number | null>` in `orchestrationState.ts`); the `OrchestrationConflicts` component with props `{ numbered, cards, orch, onBindWorktree: (railId: string) => void }`.

- [ ] **Step 1: Add the highlight store**

Append to `app/src/lib/orchestrationState.ts`:

```ts
/// Which conflict badge is hovered, app-wide. Hovering a box row lights
/// its chips; hovering a chip lights its rows. Ephemeral UI state, never
/// persisted -- which is why it lives here and not in the plan.
export const highlightedConflict = writable<number | null>(null);
```

and add `highlightedConflict.set(null);` to `__resetForTesting()`.

- [ ] **Step 2: Build the component**

Create `app/src/lib/OrchestrationConflicts.svelte`:

```svelte
<script lang="ts">
  import { ChevronDown, ChevronRight, TriangleAlert } from "@lucide/svelte";
  import { highlightedConflict } from "./orchestrationState";
  import { describeConflict, conflictRailId } from "./orchestration";
  import type { CardEntry, NumberedConflict, Orchestration } from "./orchestration";

  interface Props {
    numbered: NumberedConflict[];
    cards: Map<string, CardEntry>;
    orch: Orchestration;
    onBindWorktree: (railId: string) => void;
  }
  let { numbered, cards, orch, onBindWorktree }: Props = $props();

  let collapsed = $state(false);

  const liveCount = $derived(numbered.filter((x) => x.conflict.severity === "live").length);
</script>

<!-- Absent entirely when there are none: an empty box is noise. -->
{#if numbered.length > 0}
  <section class="conflicts" class:has-live={liveCount > 0}>
    <button type="button" class="head" onclick={() => (collapsed = !collapsed)}>
      {#if collapsed}<ChevronRight size={14} />{:else}<ChevronDown size={14} />{/if}
      <TriangleAlert size={14} />
      <span>
        {numbered.length}
        {numbered.length === 1 ? "conflict" : "conflicts"}
        {#if liveCount > 0}<em>· {liveCount} live</em>{/if}
      </span>
    </button>

    {#if !collapsed}
      <ul>
        {#each numbered as { n, conflict } (n)}
          {@const railId = conflictRailId(conflict)}
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <li
            class={conflict.severity}
            class:lit={$highlightedConflict === n}
            onmouseenter={() => highlightedConflict.set(n)}
            onmouseleave={() => highlightedConflict.set(null)}
          >
            <span class="badge">{n}</span>
            <span class="text">{describeConflict(conflict, cards, orch)}</span>
            {#if conflict.kind === "declared"}<span class="tag">agent note</span>{/if}
            {#if railId}
              <button type="button" class="fix" onclick={() => onBindWorktree(railId)}>
                Bind worktree…
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .conflicts {
    border-bottom: 1px solid var(--border-warning);
    background: var(--surface-warning);
    color: var(--text);
  }
  .conflicts.has-live {
    border-bottom-color: var(--border-danger);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 12px;
    background: none;
    border: none;
    color: var(--warning-text);
    font-size: 12px;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
  }
  .conflicts.has-live .head {
    color: var(--danger-text);
  }
  .head em {
    font-style: normal;
    font-weight: 400;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0 12px 8px;
    max-height: 22vh;
    overflow-y: auto;
  }
  li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 4px;
    border-radius: 4px;
    font-size: 12px;
  }
  li.lit {
    background: var(--surface-hover);
  }
  /* Severity is the colour; the badge number carries pairing. */
  .badge {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 1px solid var(--border-warning);
    color: var(--warning-text);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }
  li.live .badge {
    border-color: var(--border-danger);
    color: var(--danger-text);
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .tag {
    flex: none;
    color: var(--text-subtle);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .fix {
    flex: none;
    background: none;
    border: none;
    color: var(--accent-text);
    font-size: 11px;
    text-decoration: underline;
    cursor: pointer;
  }
</style>
```

- [ ] **Step 3: Wire it into the hub view**

In `app/src/lib/OrchestrationHubView.svelte`, add the imports:

```ts
  import OrchestrationConflicts from "./OrchestrationConflicts.svelte";
  import { detectConflicts, numberConflicts } from "./orchestration";
```

add the derived state beside the existing ones:

```ts
  // null, not [], while the refs snapshot is still loading -- unknown
  // must not read as "every worktree is gone".
  const worktrees = $derived($gitStore[workspaceId]?.refs?.worktrees ?? null);
  const numbered = $derived(orch ? numberConflicts(detectConflicts(orch, tree, worktrees)) : []);
```

and render it directly under the save-error strip, above the `{#if !orch}` block:

```svelte
  {#if orch}
    <OrchestrationConflicts
      {numbered}
      {cards}
      {orch}
      onBindWorktree={(railId) => (binding = railId)}
    />
  {/if}
```

Add `let binding = $state<string | null>(null);` beside `picking`. Task 9 turns it into the real dialog; until then it is only written, never read, and nothing renders for it. Do **not** add a placeholder `{#if binding}` block that clears the variable — assigning state during render is an update loop, not a stub.

- [ ] **Step 4: Type check**

Run: `cd app && npm run check && npm test`
Expected: clean, suite green.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/OrchestrationConflicts.svelte app/src/lib/orchestrationState.ts app/src/lib/OrchestrationHubView.svelte
git commit -m "feat(app): orchestration conflicts box with hover linking"
```

---

### Task 3: Severity colouring and pairing badges

**Files:**
- Modify: `app/src/lib/OrchestrationStepChip.svelte`
- Modify: `app/src/lib/OrchestrationRail.svelte`
- Modify: `app/src/lib/OrchestrationHubView.svelte`

**Interfaces:**
- Consumes: `numbersForStep`, `numbersForRail`, `severityForStep`, `severityForRail`, `highlightedConflict`.
- Produces: chips and rail headers that show their badges and take their severity colour.

- [ ] **Step 1: Badge the step chip**

In `app/src/lib/OrchestrationStepChip.svelte`, add to `Props`:

```ts
    /// Badge numbers this step belongs to, and the highest severity
    /// among them. Empty/null when the step is in no conflict.
    badges: number[];
    severity: "live" | "potential" | null;
```

destructure them, add `import { highlightedConflict } from "./orchestrationState";`, and render the badges just before the run-state marks:

```svelte
  {#each badges as n (n)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <span
      class="badge"
      class:lit={$highlightedConflict === n}
      onmouseenter={() => highlightedConflict.set(n)}
      onmouseleave={() => highlightedConflict.set(null)}
    >{n}</span>
  {/each}
```

Widen the wrapper's class to carry severity, keeping run state separate:

```svelte
<div class="chip {state}" class:sev-live={severity === "live"} class:sev-potential={severity === "potential"} ...>
```

and add to the `<style>` block:

```css
  /* Severity owns the FILL; run state owns the ring (SP1 left the fill
     free precisely for this). A stalled step keeps its danger fill. */
  .chip.sev-potential {
    background: var(--surface-warning);
    border-color: var(--border-warning);
  }
  .chip.sev-live {
    background: var(--surface-danger);
    border-color: var(--border-danger);
  }
  .badge {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1px solid currentColor;
    font-size: 9px;
    font-variant-numeric: tabular-nums;
    opacity: 0.75;
  }
  .badge.lit {
    opacity: 1;
    background: var(--surface-overlay);
  }
```

- [ ] **Step 2: Badge the rail header**

In `app/src/lib/OrchestrationRail.svelte`, add to `Props`:

```ts
    numbered: NumberedConflict[];
```

import `numbersForStep, numbersForRail, severityForStep, severityForRail` and `highlightedConflict`, then:

- render `numbersForRail(numbered, rail.id)` as badges in `.name-row`, coloured by `severityForRail(numbered, rail.id)`;
- pass each chip its own `badges={numbersForStep(numbered, step.id)}` and `severity={severityForStep(numbered, step.id)}`.

- [ ] **Step 3: Pass it down**

In `OrchestrationHubView.svelte`, add `{numbered}` to the `<OrchestrationRail ... />` props.

- [ ] **Step 4: Type check and eyeball**

Run: `cd app && npm run check`
Then run the app and confirm: a parallel stage's two chips both carry badge ①, the box row lights them on hover and vice versa, and in light and dark the warning/danger fills stay legible.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/OrchestrationStepChip.svelte app/src/lib/OrchestrationRail.svelte app/src/lib/OrchestrationHubView.svelte
git commit -m "feat(app): orchestration conflict colouring and pairing badges"
```

---

### Task 4: Move mutators

**Files:**
- Modify: `app/src/lib/orchestration.ts`
- Modify: `app/src/lib/orchestration.test.ts`
- Modify: `app/src/lib/orchestrationState.ts`

**Interfaces:**
- Consumes: SP1's `removeStep`, `renumber`, `sweepOrphans`.
- Produces: `moveStepToNewStage(orch, stepId, railId, index) → Orchestration`; `moveStepIntoStage(orch, stepId, stageId) → Orchestration`; and `moveStepToNewStageAction`, `moveStepIntoStageAction` in `orchestrationState.ts`.

**CONTRACT:** `index` counts stage positions in the target rail **with the dragged step's own stage removed if that removal emptied it** — which is exactly what the drag glue measures, since the dragged chip is excluded from measurement.

- [ ] **Step 1: Write the failing tests**

Append to `app/src/lib/orchestration.test.ts`:

```ts
import { moveStepToNewStage, moveStepIntoStage } from "./orchestration";

function built(): Orchestration {
  // r1: [t1] [t2, t3]   r2: [t4]
  let o = addRail(addRail(emptyOrchestration(), "r1", "backend"), "r2", "ui");
  o = addStage(o, "r1", "s1");
  o = addStep(o, "s1", "t1", "/x/a.md");
  o = addStage(o, "r1", "s2");
  o = addStep(o, "s2", "t2", "/x/b.md");
  o = addStep(o, "s2", "t3", "/x/c.md");
  o = addStage(o, "r2", "s3");
  o = addStep(o, "s3", "t4", "/x/d.md");
  return o;
}

const stageMap = (o: Orchestration) =>
  o.rails.map((r) => [r.id, r.stages.map((s) => s.steps.map((t) => t.id))]);

describe("moveStepIntoStage", () => {
  it("makes a step parallel with an existing stage's steps", () => {
    const o = moveStepIntoStage(built(), "t1", "s2");
    expect(stageMap(o)).toEqual([
      ["r1", [["t2", "t3", "t1"]]],
      ["r2", [["t4"]]],
    ]);
  });

  it("moves across rails, which changes the step's effective worktree", () => {
    const o = moveStepIntoStage(built(), "t4", "s1");
    expect(stageMap(o)).toEqual([
      ["r1", [["t1", "t4"], ["t2", "t3"]]],
      ["r2", []],
    ]);
  });

  it("is a no-op when the step is already in that stage", () => {
    const before = built();
    expect(stageMap(moveStepIntoStage(before, "t2", "s2"))).toEqual(stageMap(before));
  });

  it("renumbers positions after the move", () => {
    const o = moveStepIntoStage(built(), "t1", "s2");
    expect(o.rails[0].stages[0].steps.map((t) => t.position)).toEqual([0, 1, 2]);
    expect(o.rails[0].stages.map((s) => s.position)).toEqual([0]);
  });
});

describe("moveStepToNewStage", () => {
  it("inserts a fresh single-step stage at the index", () => {
    const o = moveStepToNewStage(built(), "t3", "r1", 0);
    expect(stageMap(o)).toEqual([
      ["r1", [["t3"], ["t1"], ["t2"]]],
      ["r2", [["t4"]]],
    ]);
  });

  it("appends at an index past the end", () => {
    const o = moveStepToNewStage(built(), "t1", "r1", 99);
    expect(stageMap(o)).toEqual([
      ["r1", [["t2", "t3"], ["t1"]]],
      ["r2", [["t4"]]],
    ]);
  });

  it("moves a step to another rail as its own stage", () => {
    const o = moveStepToNewStage(built(), "t1", "r2", 0);
    expect(stageMap(o)).toEqual([
      ["r1", [["t2", "t3"]]],
      ["r2", [["t1"], ["t4"]]],
    ]);
  });

  it("drops the stage the step vacated when it becomes empty", () => {
    const o = moveStepToNewStage(built(), "t1", "r2", 0);
    expect(o.rails[0].stages).toHaveLength(1);
  });

  it("keeps run state and notes for the moved step — the id survives", () => {
    let o = built();
    o = {
      ...o,
      stepRuns: [{ stepId: "t1", state: "running", sessionId: "s9", reason: null }],
      conflictNotes: [{ id: "n1", stepIds: ["t1", "t2"], note: "careful" }],
    };
    const moved = moveStepToNewStage(o, "t1", "r2", 0);
    expect(moved.stepRuns).toEqual([{ stepId: "t1", state: "running", sessionId: "s9", reason: null }]);
    expect(moved.conflictNotes).toHaveLength(1);
  });

  it("is a no-op for an unknown step or rail", () => {
    const before = built();
    expect(stageMap(moveStepToNewStage(before, "nope", "r1", 0))).toEqual(stageMap(before));
    expect(stageMap(moveStepToNewStage(before, "t1", "nope", 0))).toEqual(stageMap(before));
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd app && npm test -- orchestration`
Expected: FAIL — `moveStepToNewStage is not a function`.

- [ ] **Step 3: Implement them**

Append to `app/src/lib/orchestration.ts`:

```ts
/// The step and the stage it currently sits in, or null.
function locateStep(orch: Orchestration, stepId: string): { step: Step; stageId: string } | null {
  for (const rail of orch.rails) {
    for (const stage of rail.stages) {
      const step = stage.steps.find((t) => t.id === stepId);
      if (step) return { step, stageId: stage.id };
    }
  }
  return null;
}

/// Detach the step everywhere, dropping any stage it emptied. Shared by
/// both moves so "leave no empty stage behind" has exactly one
/// implementation.
function detachStep(orch: Orchestration, stepId: string): Orchestration {
  return {
    ...orch,
    rails: orch.rails.map((r) => ({
      ...r,
      stages: renumber(
        r.stages
          .map((s) => ({ ...s, steps: renumber(s.steps.filter((t) => t.id !== stepId)) }))
          .filter((s) => s.steps.length > 0)
      ),
    })),
  };
}

/// Drop onto an existing stage's band: the step joins it and runs in
/// PARALLEL with its steps, in that rail's checkout. No sweepOrphans --
/// the step id survives a move, so its run state and notes must too.
export function moveStepIntoStage(
  orch: Orchestration,
  stepId: string,
  stageId: string
): Orchestration {
  const found = locateStep(orch, stepId);
  if (!found || found.stageId === stageId) return orch;
  const detached = detachStep(orch, stepId);
  if (!detached.rails.some((r) => r.stages.some((s) => s.id === stageId))) return orch;
  return {
    ...detached,
    rails: detached.rails.map((r) => ({
      ...r,
      stages: r.stages.map((s) =>
        s.id === stageId
          ? { ...s, steps: renumber([...s.steps, { ...found.step, position: s.steps.length }]) }
          : s
      ),
    })),
  };
}

/// Drop into the gap between stages: the step becomes its own stage
/// there and runs SEQUENTIALLY. `index` is clamped, so "past the end"
/// appends rather than failing.
export function moveStepToNewStage(
  orch: Orchestration,
  stepId: string,
  railId: string,
  index: number
): Orchestration {
  const found = locateStep(orch, stepId);
  if (!found || !orch.rails.some((r) => r.id === railId)) return orch;
  const detached = detachStep(orch, stepId);
  return {
    ...detached,
    rails: detached.rails.map((r) => {
      if (r.id !== railId) return r;
      const stages = [...r.stages];
      const at = Math.max(0, Math.min(index, stages.length));
      stages.splice(at, 0, {
        id: crypto.randomUUID(),
        position: at,
        steps: [{ ...found.step, position: 0 }],
      });
      return { ...r, stages: renumber(stages) };
    }),
  };
}
```

`renumber` was declared in SP1's mutator block; reuse it rather than redeclaring.

- [ ] **Step 4: Add the action wrappers**

Append to `app/src/lib/orchestrationState.ts`, beside SP1's other `*Action` wrappers:

```ts
export function moveStepIntoStageAction(
  workspaceId: string,
  stepId: string,
  stageId: string
): Promise<void> {
  return mutatePlan(workspaceId, (o) => moveStepIntoStage(o, stepId, stageId));
}

export function moveStepToNewStageAction(
  workspaceId: string,
  stepId: string,
  railId: string,
  index: number
): Promise<void> {
  return mutatePlan(workspaceId, (o) => moveStepToNewStage(o, stepId, railId, index));
}
```

and extend the existing `import { addRail, ... } from "./orchestration";` with `moveStepIntoStage, moveStepToNewStage`.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cd app && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/orchestration.ts app/src/lib/orchestration.test.ts app/src/lib/orchestrationState.ts
git commit -m "feat(app): move steps between stages and rails"
```

---

### Task 5: `orchestrationDrag.ts` — pure hit-testing

**Files:**
- Create: `app/src/lib/orchestrationDrag.ts`
- Create: `app/src/lib/orchestrationDrag.test.ts`

**Interfaces:**
- Consumes: `Point`, `Rect`, `Measured` from `./pointerDrag`.
- Produces: `MeasuredStage`, `MeasuredRail`, `OrchDropTarget`; `computeOrchDropTarget(pointer, rails, drawerRect, maxSnapPx?) → OrchDropTarget | null`; `STAGE_BAND_LO`, `STAGE_BAND_HI`.

The rule mirrors the board's nest interaction so the app has one interaction language: a stage's **middle band (30%–70% of its height) means "join this stage"** — parallel; anywhere else counts stage midpoints passed and means "new stage at that index" — sequential.

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/orchestrationDrag.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeOrchDropTarget } from "./orchestrationDrag";
import type { MeasuredRail } from "./orchestrationDrag";

// Two rails side by side, each 200 wide. r1 has two stages of height
// 100 at y=0 and y=120; r2 has one stage at y=0.
const RAILS: MeasuredRail[] = [
  {
    id: "r1",
    rect: { left: 0, top: 0, width: 200, height: 400 },
    stages: [
      { id: "s1", position: 0, rect: { left: 10, top: 0, width: 180, height: 100 } },
      { id: "s2", position: 1, rect: { left: 10, top: 120, width: 180, height: 100 } },
    ],
  },
  {
    id: "r2",
    rect: { left: 220, top: 0, width: 200, height: 400 },
    stages: [{ id: "s3", position: 0, rect: { left: 230, top: 0, width: 180, height: 100 } }],
  },
];

describe("computeOrchDropTarget", () => {
  it("targets the drawer when the pointer is inside it", () => {
    const drawer = { left: 500, top: 0, width: 120, height: 400 };
    expect(computeOrchDropTarget({ x: 540, y: 40 }, RAILS, drawer)).toEqual({ kind: "unplace" });
  });

  it("joins a stage from its middle band — parallel", () => {
    expect(computeOrchDropTarget({ x: 100, y: 50 }, RAILS, null)).toEqual({
      kind: "into-stage",
      stageId: "s1",
    });
  });

  it("makes a new stage from a stage's top band — sequential, before it", () => {
    expect(computeOrchDropTarget({ x: 100, y: 10 }, RAILS, null)).toEqual({
      kind: "new-stage",
      railId: "r1",
      index: 0,
    });
  });

  it("makes a new stage from a stage's bottom band — sequential, after it", () => {
    expect(computeOrchDropTarget({ x: 100, y: 95 }, RAILS, null)).toEqual({
      kind: "new-stage",
      railId: "r1",
      index: 1,
    });
  });

  it("targets the gap between two stages", () => {
    expect(computeOrchDropTarget({ x: 100, y: 110 }, RAILS, null)).toEqual({
      kind: "new-stage",
      railId: "r1",
      index: 1,
    });
  });

  it("targets the end of the rail below the last stage", () => {
    expect(computeOrchDropTarget({ x: 100, y: 380 }, RAILS, null)).toEqual({
      kind: "new-stage",
      railId: "r1",
      index: 2,
    });
  });

  it("picks the rail by horizontal position only, so above the top still targets it", () => {
    expect(computeOrchDropTarget({ x: 300, y: -80 }, RAILS, null)).toEqual({
      kind: "new-stage",
      railId: "r2",
      index: 0,
    });
  });

  it("snaps to the nearest rail within maxSnapPx", () => {
    expect(computeOrchDropTarget({ x: 460, y: 300 }, RAILS, null)).toEqual({
      kind: "new-stage",
      railId: "r2",
      index: 1,
    });
  });

  it("is null beyond the snap distance", () => {
    expect(computeOrchDropTarget({ x: 900, y: 300 }, RAILS, null)).toBeNull();
  });

  it("targets index 0 of an empty rail", () => {
    const empty: MeasuredRail[] = [
      { id: "r9", rect: { left: 0, top: 0, width: 200, height: 400 }, stages: [] },
    ];
    expect(computeOrchDropTarget({ x: 100, y: 200 }, empty, null)).toEqual({
      kind: "new-stage",
      railId: "r9",
      index: 0,
    });
  });

  it("returns null when there are no rails at all", () => {
    expect(computeOrchDropTarget({ x: 100, y: 100 }, [], null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd app && npm test -- orchestrationDrag`
Expected: FAIL — cannot resolve `./orchestrationDrag`.

- [ ] **Step 3: Implement it**

Create `app/src/lib/orchestrationDrag.ts`:

```ts
// Pure geometry for dragging steps around the Orchestration grid.
// Deliberately NOT the kanban hit-tester: rails are columns but stages
// are rows, and the meaningful gesture is "gap between stages" vs
// "middle of a stage". The primitives (thresholds, auto-scroll) are
// reused from pointerDrag.ts; only the hit-testing is new.
//
// Like the kanban engine, every index here is computed against a list
// with the DRAGGED STEP EXCLUDED, which is exactly the post-removal
// index moveStepToNewStage expects.

import type { Point, Rect } from "./pointerDrag";

export interface MeasuredStage {
  id: string;
  position: number;
  rect: Rect;
}

export interface MeasuredRail {
  id: string;
  rect: Rect;
  stages: MeasuredStage[];
}

export type OrchDropTarget =
  | { kind: "new-stage"; railId: string; index: number }
  | { kind: "into-stage"; stageId: string }
  | { kind: "unplace" };

/// The middle band of a stage means "join it" (parallel); the outer
/// bands keep meaning before/after, which agrees with the midpoint rule
/// used for the gaps. Same 25/75-style split the board uses for nesting,
/// widened slightly because stage bands are shorter than cards.
export const STAGE_BAND_LO = 0.3;
export const STAGE_BAND_HI = 0.7;

function within(rect: Rect, p: Point): boolean {
  return (
    p.x >= rect.left &&
    p.x <= rect.left + rect.width &&
    p.y >= rect.top &&
    p.y <= rect.top + rect.height
  );
}

function horizontalDistance(rect: Rect, x: number): number {
  if (x < rect.left) return rect.left - x;
  const right = rect.left + rect.width;
  return x > right ? x - right : 0;
}

/// The drawer wins outright when the pointer is inside it; otherwise the
/// nearest rail by HORIZONTAL distance only, so dragging above or below
/// a rail still targets it (the board's rule, and the one that makes
/// long drags forgiving).
export function computeOrchDropTarget(
  pointer: Point,
  rails: MeasuredRail[],
  drawerRect: Rect | null,
  maxSnapPx = 100
): OrchDropTarget | null {
  if (drawerRect && within(drawerRect, pointer)) return { kind: "unplace" };

  let best: MeasuredRail | null = null;
  let bestDist = Infinity;
  for (const rail of rails) {
    const d = horizontalDistance(rail.rect, pointer.x);
    if (d < bestDist) {
      bestDist = d;
      best = rail;
    }
  }
  if (!best || bestDist > maxSnapPx) return null;

  const stages = [...best.stages].sort((a, b) => a.position - b.position);

  for (const stage of stages) {
    if (pointer.y < stage.rect.top || pointer.y > stage.rect.top + stage.rect.height) continue;
    const y = (pointer.y - stage.rect.top) / stage.rect.height;
    if (y >= STAGE_BAND_LO && y <= STAGE_BAND_HI) return { kind: "into-stage", stageId: stage.id };
    break;
  }

  let index = 0;
  for (const stage of stages) {
    if (pointer.y > stage.rect.top + stage.rect.height / 2) index += 1;
  }
  return { kind: "new-stage", railId: best.id, index };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd app && npm test -- orchestrationDrag`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/orchestrationDrag.ts app/src/lib/orchestrationDrag.test.ts
git commit -m "feat(app): orchestration drag hit-testing"
```

---

### Task 6: The drag controller and DOM glue

**Files:**
- Modify: `app/src/lib/orchestrationDrag.ts`
- Modify: `app/src/lib/orchestrationDrag.test.ts`
- Create: `app/src/lib/orchestrationDragGlue.ts`

**Interfaces:**
- Consumes: `exceedsThreshold`, `autoScrollVelocity` from `./pointerDrag`; `computeOrchDropTarget`.
- Produces: `orchDragState` store, `ActiveOrchDrag`, `OrchDragCallbacks`; `beginCandidate`, `movePointer`, `refreshTarget`, `endPointer`, `cancelDrag`, `__resetForTesting` in `orchestrationDrag.ts`; `attachOrchestrationDrag(opts) → () => void` and `activeOrchDragRoot` in `orchestrationDragGlue.ts`.

**Data-attribute contract** (rendered in Task 7):

| attribute | on | value |
|---|---|---|
| `data-orch-rail` | rail column root | rail id |
| `data-orch-stages` | the scrollable stage list inside a rail | — |
| `data-orch-stage` | a stage band | stage id |
| `data-orch-stage-pos` | a stage band | its `position` |
| `data-orch-step` | a step chip wrapper | step id |
| `data-orch-drawer` | the unplaced drawer root | — |
| `data-orch-card` | a drawer row | the card path |

- [ ] **Step 1: Write the failing controller tests**

Append to `app/src/lib/orchestrationDrag.test.ts`:

```ts
import { get } from "svelte/store";
import { beforeEach, vi } from "vitest";
import {
  orchDragState,
  beginCandidate,
  movePointer,
  endPointer,
  cancelDrag,
  __resetForTesting,
} from "./orchestrationDrag";
import type { OrchDragCallbacks } from "./orchestrationDrag";

const RECT = { left: 0, top: 0, width: 100, height: 30 };

function cbs(overrides: Partial<OrchDragCallbacks> = {}): OrchDragCallbacks {
  return {
    measure: () => RAILS,
    measureDrawer: () => null,
    commit: vi.fn(),
    click: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => __resetForTesting());

describe("orchestration drag controller", () => {
  it("stays a candidate below the 5px threshold", () => {
    beginCandidate("t1", "s1", { x: 0, y: 0 }, RECT, cbs());
    movePointer({ x: 2, y: 2 });
    expect(get(orchDragState)).toBeNull();
  });

  it("activates past the threshold and carries a target", () => {
    beginCandidate("t1", "s1", { x: 100, y: 50 }, RECT, cbs());
    movePointer({ x: 100, y: 110 });
    expect(get(orchDragState)?.id).toBe("t1");
    expect(get(orchDragState)?.target).toEqual({ kind: "new-stage", railId: "r1", index: 1 });
  });

  it("a release without movement is a click, not a drop", () => {
    const c = cbs();
    beginCandidate("t1", "s1", { x: 0, y: 0 }, RECT, c);
    endPointer();
    expect(c.click).toHaveBeenCalledWith("t1");
    expect(c.commit).not.toHaveBeenCalled();
  });

  it("commits at the last computed target", () => {
    const c = cbs();
    beginCandidate("t1", "s1", { x: 100, y: 50 }, RECT, c);
    movePointer({ x: 300, y: 50 });
    endPointer();
    expect(c.commit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t1", target: { kind: "into-stage", stageId: "s3" } })
    );
  });

  it("does not commit a drop back into the stage it came from", () => {
    const c = cbs();
    beginCandidate("t1", "s1", { x: 100, y: 50 }, RECT, c);
    // Away first, so the drag really activates, then back onto s1's band.
    movePointer({ x: 300, y: 50 });
    expect(get(orchDragState)).not.toBeNull();
    movePointer({ x: 100, y: 50 });
    expect(get(orchDragState)?.target).toEqual({ kind: "into-stage", stageId: "s1" });
    endPointer();
    expect(c.commit).not.toHaveBeenCalled();
  });

  it("treats a tracked move with no buttons as the drop (WKWebView lost pointerup)", () => {
    const c = cbs();
    beginCandidate("t1", "s1", { x: 100, y: 50 }, RECT, c);
    movePointer({ x: 300, y: 50 });
    movePointer({ x: 300, y: 50 }, 0);
    expect(c.commit).toHaveBeenCalled();
    expect(get(orchDragState)).toBeNull();
  });

  it("cancel drops the drag without committing", () => {
    const c = cbs();
    beginCandidate("t1", "s1", { x: 100, y: 50 }, RECT, c);
    movePointer({ x: 300, y: 50 });
    cancelDrag();
    expect(get(orchDragState)).toBeNull();
    expect(c.commit).not.toHaveBeenCalled();
  });

  it("commits an unplace when the pointer ends in the drawer", () => {
    const c = cbs({ measureDrawer: () => ({ left: 500, top: 0, width: 100, height: 400 }) });
    beginCandidate("t1", "s1", { x: 100, y: 50 }, RECT, c);
    movePointer({ x: 540, y: 50 });
    endPointer();
    expect(c.commit).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: "unplace" } }));
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd app && npm test -- orchestrationDrag`
Expected: FAIL — `orchDragState` is not exported.

- [ ] **Step 3: Implement the controller**

Append the controller to `app/src/lib/orchestrationDrag.ts`, moving these two imports up to join the existing `import type { Point, Rect }` line at the top of the file rather than leaving them mid-file:

```ts
import { writable, get } from "svelte/store";
import { exceedsThreshold } from "./pointerDrag";

/// A step drag in flight. `sourceStageId` is what makes "dropped back
/// where it started" detectable, so a click-like drag commits nothing.
export interface ActiveOrchDrag {
  id: string;
  sourceStageId: string;
  target: OrchDropTarget | null;
  pointer: Point;
  grabOffset: Point;
  size: { width: number; height: number };
}

export interface OrchDragCallbacks {
  measure: () => MeasuredRail[];
  measureDrawer: () => Rect | null;
  commit: (drag: ActiveOrchDrag & { target: OrchDropTarget }) => void;
  click: (stepId: string) => void;
}

export const orchDragState = writable<ActiveOrchDrag | null>(null);

interface Candidate {
  id: string;
  sourceStageId: string;
  start: Point;
  grabOffset: Point;
  size: { width: number; height: number };
}

let candidate: Candidate | null = null;
let callbacks: OrchDragCallbacks | null = null;

export function beginCandidate(
  id: string,
  sourceStageId: string,
  start: Point,
  itemRect: Rect,
  cbs: OrchDragCallbacks
): void {
  candidate = {
    id,
    sourceStageId,
    start,
    grabOffset: { x: start.x - itemRect.left, y: start.y - itemRect.top },
    size: { width: itemRect.width, height: itemRect.height },
  };
  callbacks = cbs;
}

function computeTarget(pointer: Point): OrchDropTarget | null {
  if (!callbacks) return null;
  return computeOrchDropTarget(pointer, callbacks.measure(), callbacks.measureDrawer());
}

/// `buttons` is PointerEvent.buttons. A tracked move with no buttons
/// pressed means the platform never delivered the pointerup -- WKWebView
/// drops it when the pointerdown target left the DOM mid-gesture -- so
/// that move stands in for the release. Same recovery the board uses.
export function movePointer(p: Point, buttons?: number): void {
  if (buttons === 0 && (candidate || get(orchDragState))) {
    endPointer();
    return;
  }
  const active = get(orchDragState);
  if (active) {
    orchDragState.set({ ...active, pointer: p, target: computeTarget(p) });
    return;
  }
  if (!candidate || !exceedsThreshold(candidate.start, p)) return;
  orchDragState.set({
    id: candidate.id,
    sourceStageId: candidate.sourceStageId,
    target: computeTarget(p),
    pointer: p,
    grabOffset: candidate.grabOffset,
    size: candidate.size,
  });
}

/// Re-hit-test at the current pointer with fresh measurements, after an
/// auto-scroll frame moved content under a stationary pointer.
export function refreshTarget(): void {
  const active = get(orchDragState);
  if (!active) return;
  orchDragState.set({ ...active, target: computeTarget(active.pointer) });
}

export function endPointer(): void {
  const active = get(orchDragState);
  const cbs = callbacks;
  const wasCandidate = candidate;
  candidate = null;
  callbacks = null;
  orchDragState.set(null);
  if (!cbs) return;
  if (!active) {
    if (wasCandidate) cbs.click(wasCandidate.id);
    return;
  }
  if (!active.target) return;
  // Dropping back into the stage it came from changes nothing.
  if (active.target.kind === "into-stage" && active.target.stageId === active.sourceStageId) return;
  cbs.commit(active as ActiveOrchDrag & { target: OrchDropTarget });
}

export function cancelDrag(): void {
  candidate = null;
  callbacks = null;
  orchDragState.set(null);
}

/** @internal test-only reset for module-level state */
export function __resetForTesting(): void {
  candidate = null;
  callbacks = null;
  orchDragState.set(null);
}
```

- [ ] **Step 4: Implement the glue**

Create `app/src/lib/orchestrationDragGlue.ts`:

```ts
// The DOM side of the orchestration drag: one delegated pointerdown on
// the grid, rect measurement over data attributes, the auto-scroll rAF
// loop, and the window-level gesture listeners. Every decision lives in
// orchestrationDrag.ts -- this file only reads the DOM.
//
// Data-attribute contract (rendered by the orchestration components):
//   [data-orch-rail]       rail column root; value = rail id
//   [data-orch-stages]     the scrollable stage list inside a rail
//   [data-orch-stage]      a stage band; value = stage id
//   [data-orch-stage-pos]  a stage band; value = its position
//   [data-orch-step]       a step chip wrapper; value = step id
//   [data-orch-drawer]     the unplaced drawer root
//   [data-orch-card]       a drawer row; value = the card path

import { get, writable } from "svelte/store";
import {
  orchDragState,
  beginCandidate,
  movePointer,
  refreshTarget,
  endPointer,
  cancelDrag,
  type ActiveOrchDrag,
  type MeasuredRail,
  type MeasuredStage,
  type OrchDragCallbacks,
  type OrchDropTarget,
} from "./orchestrationDrag";
import { autoScrollVelocity, type Rect } from "./pointerDrag";

export const activeOrchDragRoot = writable<HTMLElement | null>(null);

export interface OrchDragOptions {
  /// The grid element, also the horizontal scroll container.
  root: HTMLElement;
  commit: (drag: ActiveOrchDrag & { target: OrchDropTarget }) => void;
  click: (stepId: string) => void;
}

function toRect(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/// The dragged step is excluded from measurement, and a stage left with
/// only the dragged step is excluded too -- it is about to disappear, so
/// letting it hold a slot would produce an index one too high.
function measureRails(root: HTMLElement, draggedId: string): MeasuredRail[] {
  const rails: MeasuredRail[] = [];
  for (const railEl of root.querySelectorAll("[data-orch-rail]")) {
    const stages: MeasuredStage[] = [];
    for (const stageEl of railEl.querySelectorAll("[data-orch-stage]")) {
      const steps = [...stageEl.querySelectorAll("[data-orch-step]")];
      const remaining = steps.filter((s) => s.getAttribute("data-orch-step") !== draggedId);
      if (steps.length > 0 && remaining.length === 0) continue;
      stages.push({
        id: stageEl.getAttribute("data-orch-stage") ?? "",
        position: Number(stageEl.getAttribute("data-orch-stage-pos") ?? "0"),
        rect: toRect(stageEl),
      });
    }
    rails.push({
      id: railEl.getAttribute("data-orch-rail") ?? "",
      rect: toRect(railEl),
      stages,
    });
  }
  return rails;
}

export function attachOrchestrationDrag(opts: OrchDragOptions): () => void {
  const { root } = opts;
  let activePointerId: number | null = null;

  function measureDrawer(): Rect | null {
    const el = document.querySelector("[data-orch-drawer]");
    return el ? toRect(el) : null;
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input, a, textarea, select")) return;
    const stepEl = target.closest("[data-orch-step]");
    if (!stepEl) return;
    const stageEl = stepEl.closest("[data-orch-stage]");

    const cbs: OrchDragCallbacks = {
      measure: () => measureRails(root, stepEl.getAttribute("data-orch-step") ?? ""),
      measureDrawer,
      commit: opts.commit,
      click: opts.click,
    };
    activeOrchDragRoot.set(root);
    beginCandidate(
      stepEl.getAttribute("data-orch-step") ?? "",
      stageEl?.getAttribute("data-orch-stage") ?? "",
      { x: e.clientX, y: e.clientY },
      toRect(stepEl),
      cbs
    );
    // Window-level, capture-phase: the dragged chip's wrapper leaves the
    // DOM at activation and WKWebView then drops the pointerup instead
    // of retargeting it. setPointerCapture stays a best-effort extra.
    activePointerId = e.pointerId;
    attachGestureListeners();
    try {
      root.setPointerCapture(e.pointerId);
    } catch {
      // Capture is an enhancement, never a requirement.
    }
  }

  function onGestureMove(e: PointerEvent): void {
    if (e.pointerId !== activePointerId) return;
    movePointer({ x: e.clientX, y: e.clientY }, e.buttons);
    if (e.buttons === 0) detachGestureListeners();
  }

  function onGestureUp(e: PointerEvent): void {
    if (e.pointerId !== activePointerId) return;
    endPointer();
    detachGestureListeners();
  }

  function onGestureCancel(e: PointerEvent): void {
    if (e.pointerId !== activePointerId) return;
    cancelDrag();
    detachGestureListeners();
  }

  function attachGestureListeners(): void {
    window.addEventListener("pointermove", onGestureMove, true);
    window.addEventListener("pointerup", onGestureUp, true);
    window.addEventListener("pointercancel", onGestureCancel, true);
  }

  function detachGestureListeners(): void {
    activePointerId = null;
    window.removeEventListener("pointermove", onGestureMove, true);
    window.removeEventListener("pointerup", onGestureUp, true);
    window.removeEventListener("pointercancel", onGestureCancel, true);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape" && get(orchDragState)) {
      cancelDrag();
      detachGestureListeners();
    }
  }

  let rafId: number | null = null;
  function frame(): void {
    rafId = null;
    const drag = get(orchDragState);
    if (!drag) return;
    let scrolled = false;

    const rootRect = root.getBoundingClientRect();
    const dx = autoScrollVelocity(drag.pointer.x, rootRect.left, rootRect.right);
    if (dx !== 0) {
      const before = root.scrollLeft;
      root.scrollLeft += dx;
      scrolled ||= root.scrollLeft !== before;
    }
    const dy = autoScrollVelocity(drag.pointer.y, rootRect.top, rootRect.bottom);
    if (dy !== 0) {
      const before = root.scrollTop;
      root.scrollTop += dy;
      scrolled ||= root.scrollTop !== before;
    }

    if (scrolled) refreshTarget();
    rafId = requestAnimationFrame(frame);
  }

  const unsubscribe = orchDragState.subscribe((drag) => {
    if (drag && rafId === null) {
      rafId = requestAnimationFrame(frame);
    } else if (!drag && rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  });

  root.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("keydown", onKeyDown);

  return () => {
    unsubscribe();
    if (rafId !== null) cancelAnimationFrame(rafId);
    root.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("keydown", onKeyDown);
    detachGestureListeners();
    cancelDrag();
  };
}
```

The grid scrolls in **both** axes here (unlike the board, where columns scroll independently), which is why this loop auto-scrolls vertically on `root` rather than on a per-column list.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cd app && npm test -- orchestrationDrag`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/orchestrationDrag.ts app/src/lib/orchestrationDrag.test.ts app/src/lib/orchestrationDragGlue.ts
git commit -m "feat(app): orchestration drag controller and DOM glue"
```

---

### Task 7: Wire drag into the components

**Files:**
- Modify: `app/src/lib/OrchestrationRail.svelte`
- Modify: `app/src/lib/OrchestrationStepChip.svelte`
- Modify: `app/src/lib/OrchestrationHubView.svelte`
- Create: `app/src/lib/OrchestrationDragPreview.svelte`

**Interfaces:**
- Consumes: `attachOrchestrationDrag`, `activeOrchDragRoot`, `orchDragState`; `moveStepIntoStageAction`, `moveStepToNewStageAction`, `removeStepAction`.
- Produces: a draggable grid with drop feedback.

- [ ] **Step 1: Emit the data attributes**

In `OrchestrationRail.svelte`:

- the root `<div class="rail">` gains `data-orch-rail={rail.id}`;
- the stage list wrapper gains `data-orch-stages`;
- each `<section class="stage">` gains `data-orch-stage={stage.id}` and `data-orch-stage-pos={stage.position}`;
- each chip is wrapped so the wrapper carries `data-orch-step={step.id}`.

- [ ] **Step 2: Show drop feedback**

Still in `OrchestrationRail.svelte`, import `orchDragState` and derive:

```ts
  const drag = $derived($orchDragState);
  // The dragged chip is hidden while it flies; a stage left holding only
  // it collapses, matching what the glue measures.
  const stagesShown = $derived(
    stages
      .map((s) => ({ ...s, steps: s.steps.filter((t) => t.id !== drag?.id) }))
      .filter((s) => s.steps.length > 0)
  );
  const newStageAt = $derived(
    drag?.target?.kind === "new-stage" && drag.target.railId === rail.id ? drag.target.index : null
  );
  const intoStage = $derived(drag?.target?.kind === "into-stage" ? drag.target.stageId : null);
```

Render `stagesShown` instead of `stages`, mark a stage `class:drop-into={intoStage === stage.id}`, and insert a placeholder band where `newStageAt` says:

```svelte
  {#each stagesShown as stage, i (stage.id)}
    {#if newStageAt === i}<div class="stage-placeholder"></div>{/if}
    <section class="stage" ...>…</section>
  {/each}
  {#if newStageAt === stagesShown.length}<div class="stage-placeholder"></div>{/if}
```

with:

```css
  .stage-placeholder {
    height: 34px;
    border: 1px dashed var(--border-focus);
    border-radius: 8px;
    background: var(--surface-accent);
  }
  .stage.drop-into {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
```

- [ ] **Step 3: The floating preview**

Create `app/src/lib/OrchestrationDragPreview.svelte` — a fixed-position ghost following the pointer, rendered only by the grid that owns the drag:

```svelte
<script lang="ts">
  import { orchDragState } from "./orchestrationDrag";
  import { activeOrchDragRoot } from "./orchestrationDragGlue";
  import type { CardEntry, Orchestration } from "./orchestration";

  interface Props {
    orch: Orchestration | null;
    cards: Map<string, CardEntry>;
    root: HTMLElement | null;
  }
  let { orch, cards, root }: Props = $props();

  const ownsDrag = $derived(root !== null && $activeOrchDragRoot === root);
  const title = $derived.by(() => {
    const id = $orchDragState?.id;
    if (!id || !orch) return "";
    for (const rail of orch.rails) {
      for (const stage of rail.stages) {
        for (const step of stage.steps) {
          if (step.id === id) {
            return cards.get(step.cardPath)?.plan.title ?? (step.cardPath.split("/").pop() ?? "");
          }
        }
      }
    }
    return "";
  });
</script>

{#if ownsDrag && $orchDragState}
  <div
    class="ghost"
    style="left: {$orchDragState.pointer.x - $orchDragState.grabOffset.x}px;
           top: {$orchDragState.pointer.y - $orchDragState.grabOffset.y}px;
           width: {$orchDragState.size.width}px;"
  >
    {title}
  </div>
{/if}

<style>
  .ghost {
    position: fixed;
    z-index: 1000;
    pointer-events: none;
    padding: 6px 8px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-overlay);
    color: var(--text);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0.9;
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.3);
  }
</style>
```

- [ ] **Step 4: Attach the engine in the hub view**

In `OrchestrationHubView.svelte`, bind the grid element and attach on mount:

```ts
  import { onMount } from "svelte";
  import { attachOrchestrationDrag } from "./orchestrationDragGlue";
  import OrchestrationDragPreview from "./OrchestrationDragPreview.svelte";
  import { moveStepIntoStageAction, moveStepToNewStageAction } from "./orchestrationState";

  let gridEl = $state<HTMLElement | null>(null);

  onMount(() => {
    if (!gridEl) return;
    return attachOrchestrationDrag({
      root: gridEl,
      commit: (drag) => {
        if (drag.target.kind === "unplace") {
          void removeStepAction(workspaceId, drag.id);
        } else if (drag.target.kind === "into-stage") {
          void moveStepIntoStageAction(workspaceId, drag.id, drag.target.stageId);
        } else {
          void moveStepToNewStageAction(workspaceId, drag.id, drag.target.railId, drag.target.index);
        }
      },
      // A press with no movement does nothing here: the chip's own
      // buttons (retry, remove) handle clicks, and the glue already
      // ignores pointerdowns that land on a button.
      click: () => {},
    });
  });
```

`bind:this={gridEl}` on `<div class="grid">`, and render `<OrchestrationDragPreview {orch} {cards} root={gridEl} />` at the end of the markup.

`onMount` returns the detach function, so the engine is torn down with the tab.

- [ ] **Step 5: Verify**

Run: `cd app && npm run check && npm test`
Then, in the app: drag a chip into the gap between two stages (it becomes its own stage), onto a stage's middle (it joins that stage and the conflicts box gains a same-worktree row), and to another rail. Press Escape mid-drag and confirm nothing moves.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/OrchestrationRail.svelte app/src/lib/OrchestrationStepChip.svelte \
        app/src/lib/OrchestrationHubView.svelte app/src/lib/OrchestrationDragPreview.svelte
git commit -m "feat(app): drag steps between stages and rails"
```

---

### Task 8: The unplaced drawer

**Files:**
- Create: `app/src/lib/OrchestrationDrawer.svelte`
- Modify: `app/src/lib/OrchestrationHubView.svelte`

**Interfaces:**
- Consumes: the `available` derived value SP1 already computes for the picker.
- Produces: a collapsible right-edge drawer, a drop target for `unplace`, and a source for adding steps.

- [ ] **Step 1: Build it**

Create `app/src/lib/OrchestrationDrawer.svelte`:

```svelte
<script lang="ts">
  import { ChevronRight, ChevronLeft, FileText, ListChecks } from "@lucide/svelte";
  import { orchDragState } from "./orchestrationDrag";
  import type { CardEntry } from "./orchestration";

  interface Props {
    available: CardEntry[];
    /// Clicking a row adds it to this rail as its own stage; null when
    /// there is no rail to add to yet.
    targetRailId: string | null;
    onAdd: (cardPath: string) => void;
  }
  let { available, targetRailId, onAdd }: Props = $props();

  let collapsed = $state(false);
  const dragging = $derived($orchDragState !== null);
</script>

<aside class="drawer" class:collapsed data-orch-drawer class:drop-lit={dragging}>
  <button type="button" class="toggle" onclick={() => (collapsed = !collapsed)}>
    {#if collapsed}<ChevronLeft size={14} />{:else}<ChevronRight size={14} />{/if}
    {#if !collapsed}<span>Unplaced ({available.length})</span>{/if}
  </button>

  {#if !collapsed}
    {#if dragging}
      <p class="hint">Drop here to take a step off its rail.</p>
    {/if}
    <ul>
      {#each available as entry (entry.plan.path)}
        <li data-orch-card={entry.plan.path}>
          <button type="button" disabled={!targetRailId} onclick={() => onAdd(entry.plan.path)}>
            {#if entry.plan.kind === "plan"}<ListChecks size={12} />{:else}<FileText size={12} />{/if}
            <span>{entry.plan.title}</span>
          </button>
        </li>
      {/each}
      {#if available.length === 0}
        <li class="empty">Every runnable card is on a rail.</li>
      {/if}
    </ul>
  {/if}
</aside>

<style>
  .drawer {
    flex: none;
    width: 220px;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border);
    background: var(--surface-sunken);
    overflow-y: auto;
  }
  .drawer.collapsed {
    width: 32px;
  }
  .drawer.drop-lit {
    outline: 2px dashed var(--border-focus);
    outline-offset: -2px;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px;
    background: none;
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
  }
  .hint {
    margin: 0;
    padding: 8px;
    color: var(--accent-text);
    font-size: 11px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 4px;
  }
  li button {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 5px 6px;
    background: none;
    border: none;
    border-radius: 4px;
    color: var(--text);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  li button:disabled {
    color: var(--text-subtle);
    cursor: default;
  }
  li button:hover:not(:disabled) {
    background: var(--surface-hover);
  }
  li button span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty {
    padding: 8px 6px;
    color: var(--text-subtle);
    font-size: 11px;
  }
</style>
```

- [ ] **Step 2: Put it beside the grid**

In `OrchestrationHubView.svelte`, wrap the grid and the drawer in a flex row so the grid scrolls and the drawer stays pinned:

```svelte
    <div class="body">
      <div class="grid" bind:this={gridEl}>…</div>
      <OrchestrationDrawer
        {available}
        targetRailId={rails[0]?.id ?? null}
        onAdd={(cardPath) => void addStepAsStageAction(workspaceId, rails[0].id, cardPath)}
      />
    </div>
```

```css
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .grid {
    flex: 1;
    min-width: 0;
  }
```

The `+ Add step` picker from SP1 stays — it targets a specific rail, which the drawer's click does not.

- [ ] **Step 3: Verify**

Run: `cd app && npm run check`
Then: drag a chip onto the drawer and confirm the step disappears from its rail, the card reappears in the drawer, and the card file itself is untouched (check the board — its status has not changed).

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/OrchestrationDrawer.svelte app/src/lib/OrchestrationHubView.svelte
git commit -m "feat(app): unplaced-cards drawer for the orchestration tab"
```

---

### Task 9: Rail binding

**Files:**
- Modify: `app/src/lib/GitForkDialog.svelte`
- Modify: `app/src/lib/layoutState.ts`
- Create: `app/src/lib/RailBindDialog.svelte`
- Modify: `app/src/lib/OrchestrationRail.svelte`
- Modify: `app/src/lib/OrchestrationHubView.svelte`

**Interfaces:**
- Consumes: `forkWorktree`, `switchWorktree` from `gitState`; `createPage` from `layoutState`; `bindRailAction`.
- Produces: `GitForkDialog` gains `onPicked?`, `allowSpawn?`, `switchAfter?`; `layoutState.createPage` returns the new page id; `RailBindDialog` with props `{ workspaceId, rail, onClose }`.

- [ ] **Step 1: Generalize the fork dialog**

In `app/src/lib/GitForkDialog.svelte`, widen `Props`:

```ts
  interface Props {
    workspaceId: string;
    /// The workspace's resolved agent command (same resolution as Home).
    agentCommand: string;
    onSpawnAgent: (path: string, command: string) => void;
    onClose: () => void;
    /// Called with the created worktree's path. Set by callers that want
    /// the worktree for something other than starting an agent in it --
    /// an orchestration rail binding, for instance.
    onPicked?: (path: string) => void;
    /// Offer "Start agent here". Off for rail binding: the rail's own
    /// Start is what launches agents there.
    allowSpawn?: boolean;
    /// Repoint the whole Git tab at the new worktree. Off for rail
    /// binding -- creating a rail's fork should not move the user's Git
    /// tab out from under them.
    switchAfter?: boolean;
  }
  let {
    workspaceId,
    agentCommand,
    onSpawnAgent,
    onClose,
    onPicked,
    allowSpawn = true,
    switchAfter = true,
  }: Props = $props();
```

Guard the checkbox with `{#if allowSpawn} … {/if}`, and change the tail of `submit()`:

```ts
    onClose();
    if (switchAfter) await switchWorktree(workspaceId, path);
    onPicked?.(path);
    if (allowSpawn && startAgent) onSpawnAgent(path, agentCommand);
```

Existing callers pass neither new prop and are unaffected.

- [ ] **Step 2: Let `createPage` report the page it made**

In `app/src/lib/layoutState.ts`, change `createPage`'s signature to `Promise<string | null>`: return `null` at the two existing early returns, and `return pageId;` at the end. Existing callers ignore the value, so nothing else changes.

- [ ] **Step 3: Build the binding dialog**

Create `app/src/lib/RailBindDialog.svelte`:

```svelte
<script lang="ts">
  import Modal from "./Modal.svelte";
  import GitForkDialog from "./GitForkDialog.svelte";
  import { gitStore } from "./gitState";
  import { layoutState, createPage, resolvedAgentFor } from "./layoutState";
  import { bindRailAction } from "./orchestrationState";
  import { presetSingle } from "./layout";
  import type { Rail } from "./orchestration";

  interface Props {
    workspaceId: string;
    rail: Rail;
    onClose: () => void;
  }
  let { workspaceId, rail, onClose }: Props = $props();

  let forking = $state(false);

  const worktrees = $derived($gitStore[workspaceId]?.refs?.worktrees ?? []);
  const pages = $derived($layoutState.workspaces.find((w) => w.id === workspaceId)?.pages ?? []);

  async function bindNewPage(): Promise<void> {
    const pageId = await createPage(workspaceId, (ids) => presetSingle(ids[0]), 1, rail.name);
    if (pageId) await bindRailAction(workspaceId, rail.id, { pageId });
  }
</script>

{#if forking}
  <GitForkDialog
    {workspaceId}
    agentCommand={resolvedAgentFor(workspaceId).command}
    onSpawnAgent={() => {}}
    allowSpawn={false}
    switchAfter={false}
    onPicked={(path) => {
      void bindRailAction(workspaceId, rail.id, { worktreePath: path });
      forking = false;
      onClose();
    }}
    onClose={() => (forking = false)}
  />
{:else}
  <Modal {onClose}>
    <div class="bind">
      <h3>Bind “{rail.name}”</h3>

      <section>
        <h4>Worktree</h4>
        <p class="note">Where this rail's steps run. Re-binding affects steps started from now on.</p>
        <ul>
          <li>
            <button
              type="button"
              class:on={rail.worktreePath === null}
              onclick={() => void bindRailAction(workspaceId, rail.id, { worktreePath: null })}
            >
              None — each card's own folder
            </button>
          </li>
          {#each worktrees as wt (wt.path)}
            <li>
              <button
                type="button"
                class:on={rail.worktreePath === wt.path}
                onclick={() => void bindRailAction(workspaceId, rail.id, { worktreePath: wt.path })}
              >
                <span class="path">{wt.path}</span>
                <span class="branch">{wt.branch ?? "detached"}{wt.isMain ? " · main checkout" : ""}</span>
              </button>
            </li>
          {/each}
        </ul>
        <button type="button" class="secondary" onclick={() => (forking = true)}>New worktree…</button>
      </section>

      <section>
        <h4>Page</h4>
        <p class="note">Where this rail's agent sessions land.</p>
        <ul>
          <li>
            <button
              type="button"
              class:on={rail.pageId === null}
              onclick={() => void bindRailAction(workspaceId, rail.id, { pageId: null })}
            >
              None — the Agents page
            </button>
          </li>
          {#each pages as page (page.id)}
            <li>
              <button
                type="button"
                class:on={rail.pageId === page.id}
                onclick={() => void bindRailAction(workspaceId, rail.id, { pageId: page.id })}
              >
                {page.name}
              </button>
            </li>
          {/each}
        </ul>
        <button type="button" class="secondary" onclick={() => void bindNewPage()}>
          New page “{rail.name}”
        </button>
      </section>

      <div class="actions">
        <button type="button" onclick={onClose}>Done</button>
      </div>
    </div>
  </Modal>
{/if}

<style>
  .bind {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 380px;
  }
  h3 {
    margin: 0;
    font-size: 14px;
  }
  h4 {
    margin: 0 0 2px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .note {
    margin: 0 0 6px;
    font-size: 11px;
    color: var(--text-subtle);
  }
  ul {
    list-style: none;
    margin: 0 0 6px;
    padding: 0;
    max-height: 30vh;
    overflow-y: auto;
  }
  li button {
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 100%;
    padding: 5px 7px;
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--text);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  li button:hover {
    background: var(--surface-hover);
  }
  li button.on {
    border-color: var(--border-focus);
    background: var(--surface-accent);
  }
  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .branch {
    color: var(--text-subtle);
    font-size: 10px;
  }
  .secondary {
    align-self: flex-start;
    padding: 4px 8px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
```

- [ ] **Step 4: Replace the SP1 text inputs**

In `OrchestrationRail.svelte`, delete the two `<label class="bind">` text inputs and their CSS, and replace them with a single row showing the current bindings and opening the dialog:

```svelte
    <button type="button" class="bindings" onclick={onBind}>
      <span class="wt">{rail.worktreePath ?? "no worktree"}</span>
      <span class="pg">{pageName ?? "Agents page"}</span>
    </button>
```

Change the `onBind` prop's type from `(patch) => void` to `() => void`, and add a `pageName: string | null` prop resolved by the hub view.

In `OrchestrationHubView.svelte`: pass `onBind={() => (binding = rail.id)}` and `pageName={ws?.pages.find((p) => p.id === rail.pageId)?.name ?? null}`, then replace Task 2's temporary `{#if binding}` stub with the real dialog:

```svelte
{#if binding && orch}
  {@const bindingRail = orch.rails.find((r) => r.id === binding)}
  {#if bindingRail}
    <RailBindDialog {workspaceId} rail={bindingRail} onClose={() => (binding = null)} />
  {/if}
{/if}
```

- [ ] **Step 5: Verify**

Run: `cd app && npm run check && npm test`
Then, in the app:

1. Open a rail's bindings; pick an existing worktree; confirm the header updates and the `rail-unbound` conflict disappears.
2. Use **New worktree…**; confirm the worktree is created, the rail binds to it, **and the Git tab stays where it was** (the `switchAfter={false}` behaviour).
3. Bind a new page named after the rail; Start the rail; confirm its session lands on that page, not the active one.
4. Point two rails at one worktree; confirm a `same-worktree` conflict with `scope: "rails"` appears and both rails' chips carry the badge.
5. Delete a worktree from the Git tab while a rail is bound to it; confirm `worktree-missing` appears with its inline **Bind worktree…** fix, and that Start stalls rather than spawning.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/GitForkDialog.svelte app/src/lib/layoutState.ts app/src/lib/RailBindDialog.svelte \
        app/src/lib/OrchestrationRail.svelte app/src/lib/OrchestrationHubView.svelte
git commit -m "feat(app): rail worktree and page binding"
```

- [ ] **Step 7: Close out the card**

Tick every item on `.gavin-root/plans/orchestration-conflicts-and-drag.md` and set its status:

```
gavin_set_plan_field(".gavin-root/plans/orchestration-conflicts-and-drag.md", "status", "Done")
```

```bash
git add .gavin-root/plans/orchestration-conflicts-and-drag.md
git commit -m "docs(plan): orchestration SP2 complete"
```

---

## What SP2 deliberately leaves undone

- **The agent surface.** `GitDirtyPaths`, `gavin_get_orchestration` / `gavin_set_orchestration`, the `OrchestrationChanged` push, the `gavin-orchestrate` skill and the **Reorganize with agent…** button are all SP3. `conflictNotes` is read and rendered here but nothing writes it yet, so the `declared` conflict kind stays empty in practice until SP3 lands.
- **Reordering rails.** Rails render in `position` order but there is no drag to reorder them; the spec never asked for it, and the grid's column order rarely carries meaning.
- **Keyboard drag.** The picker and the drawer cover click and keyboard users for *adding*; moving a step between stages is pointer-only. Worth revisiting if it bites.
