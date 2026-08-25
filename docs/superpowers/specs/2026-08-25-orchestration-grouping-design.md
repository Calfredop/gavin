# Orchestration Grouping — Design Spec

Dropping a step onto another step's stage currently makes that stage
**parallel**, which is the only multi-step shape a rail can hold. This adds
**groups**: a stage the human can name, run **sequentially or in parallel**,
drag around as one unit, and **save as a reusable template** — workspace-local
or global to the machine — so an arrangement like *merge + push* is placed
once and reused everywhere.

Extends `2026-08-21-orchestration-tab-design.md` and
`2026-08-21-orchestration-tools-design.md`; every decision there still holds
unless restated here.

**Out of scope:** nested groups (a group inside a group), conditional members
("only if the previous one failed"), applying a template from MCP, and
sharing templates between machines.

---

## Decisions

| # | Decision |
|---|---|
| G1 | A group **is a stage**. Nothing new nests. `Stage` gains `mode` and `name`; a stage holding ≥2 steps is a group, and its `mode` says how those steps run. |
| G2 | `mode` is `"sequence"` or `"parallel"`, and **defaults to `parallel`** on the wire and in SQLite. Every stage already stored keeps behaving exactly as it does today. |
| G3 | **Dropping a step onto a single-step stage forms a `sequence` group** — the change this spec exists for. Dropping onto a stage that is already a group **keeps that group's mode**. |
| G4 | In a `sequence` stage the scheduler runs **one member at a time**, in `position` order. A member that finishes lets the next launch **in the same tick**. |
| G5 | A `sequence` stage is **not** a `same-worktree` conflict. Its members share the rail's checkout *in turn*, which is what a rail is for. |
| G6 | A group is **dragged as a unit** between positions and rails, and its members are **reordered by dragging within it** — the top/bottom half of a member chip inserts before/after it. |
| G7 | A **group template** stores `mode` and an ordered list of **tool steps only**. A card step is an absolute path into one workspace, so it can never be a template member. |
| G8 | Templates live in **two scopes**, exactly as tools do: `workspace_id: Some(id)` is that workspace's, `None` is global to this machine. There are no built-in templates. |
| G9 | `mode` and `name` **widen an existing request**, so `min_version_for` cannot see them. The gate is `FEATURE_MIN_VERSION.groups`, and it owes a `featureBlockedReason` consumer on **every** surface that can form or change a group. |
| G10 | `gavin_set_orchestration` must **document and preserve** `mode` and `name`, or the first agent to rewrite an arrangement silently flattens every group back to parallel. |

---

## 1. Data model

### 1.1 Stage

```ts
export type StageMode = "sequence" | "parallel";

export interface Stage {
  id: string;
  position: number;
  /// How this stage's steps run. Absent on every stage written before
  /// groups existed, and absent means "parallel" -- see stageMode().
  mode?: StageMode;
  /// The group's name, shown in its header. Null/absent renders as the
  /// positional label ("stage 3") the rail already draws.
  name?: string | null;
  steps: Step[];
}
```

```rust
/// "sequence" | "parallel". A String rather than an enum for the same
/// reason ToolKind is: the daemon only stores and returns it, and
/// widening the vocabulary must not become a wire break.
pub type StageMode = String;

pub struct Stage {
    pub id: String,
    pub position: i64,
    #[serde(default = "default_stage_mode")]
    pub mode: StageMode,
    #[serde(default)]
    pub name: Option<String>,
    pub steps: Vec<Step>,
}
```

`default_stage_mode()` returns `"parallel"` (G2). Serde's own `String`
default is `""`, which would read as neither mode, so the custom default
is load-bearing rather than decorative.

The app never reads `stage.mode` directly. One tolerant reader owns the
absence, the way `stepParams` already owns a missing `toolParams`:

```ts
export function stageMode(stage: Stage): StageMode {
  return stage.mode === "sequence" ? "sequence" : "parallel";
}
export function isGroup(stage: Stage): boolean {
  return stage.steps.length > 1;
}
```

### 1.2 Why a stage and not a new level

A group needs to be: an ordered set of steps, movable as a unit within a
rail, with a run discipline of its own. A stage is already the first two.
Adding a fourth level (rail → stage → group → step) would fork every
walk in `orchestration.ts`, every conflict rule, every drag target and
both storage layers, to express something the third level already holds.

The cost of G1 is that **every** multi-step stage becomes a group,
including the ones already on disk. That is the answer, not the price:
they start in `parallel` mode and gain a header, a name, a drag handle
and a toggle, so the app has one vocabulary for one shape instead of two
similar-looking things that behave differently.

### 1.3 New single-step stages

`moveStepToNewStage`, `addCardAsStage` and `addToolAsStage` mint
single-step stages, and those are written `mode: "sequence"`. A
single-step stage runs identically either way, so this decides nothing
about today and everything about tomorrow: the moment a second step
joins it (G3) the group is already what the drop meant.

A stage read back with **no** mode is `parallel` (G2). The two rules
disagree only about single-step stages, where they cannot be told apart
by behaviour.

That is also why `moveStepIntoStage` sets `mode: "sequence"` **explicitly**
whenever the target stage holds exactly one step, whatever its stored
mode says (G3). A single-step stage's mode describes nothing observable,
so overwriting it discards no intent — and it makes the gesture mean the
same thing whether the target was written today or before groups
existed.

The reverse case needs no rule: a group left holding one step, because
its other members were dragged out, keeps its mode and simply draws bare
again. It becomes a group again, with the same discipline, the moment
something rejoins it.

### 1.4 Group template

```ts
export interface GroupTemplateStep {
  toolId: string;
  toolParams: Record<string, string>;
}

export interface GroupTemplate {
  id: string;            // UUID; there are no built-ins to prefix
  name: string;
  description: string;
  mode: StageMode;
  steps: GroupTemplateStep[];
  scope: "workspace" | "global";
}
```

`scope` is **derived, not stored**, exactly as `ToolScope` is: the daemon
stores `workspace_id` (`NULL` = global) and the app labels the row.

A template member is a `toolId` plus its overrides. It is deliberately
**not** a `Step`: step ids are run-state keys and must be minted fresh at
every placement, and `cardPath` has no meaning here (G7).

---

## 2. The scheduler

`nextActions` walks a stage's steps in `position` order and applies rules
1–3 to each. For a `sequence` stage it stops at the first member that is
not `done` once this tick's rules have run:

```ts
const ordered = [...stage.steps].sort((a, b) => a.position - b.position);
const sequential = stageMode(stage) === "sequence";
for (const step of ordered) {
  stepBody: {
    // rules 1-3, unchanged; every `continue` becomes `break stepBody`
  }
  if (sequential && simulated.get(step.id) !== "done") break;
}
```

One guard, not two. An earlier draft of this section also broke the loop
on the rail-level `stalled` flag; that was wrong twice over. It is not
gated on `sequential`, so it changed what a PARALLEL stage emits — a
stalled member would abort the loop instead of letting rule 2 move on to
its launchable siblings. And it is dead for the sequence case it was
meant to serve: every site that sets `stalled` first sets that same
step's simulated state to `"stalled"`, so the guard above already
breaks.

Three properties fall out of that shape rather than being coded:

- **One member in flight.** Rule 2 launches the first pending member and
  sets `simulated` to `running`, so the guard stops the loop.
- **Cascade within a tick.** A member marked `done` by rule 1 or rule 3
  leaves `simulated` at `done`, so the loop continues and the next
  member launches immediately — the same cascade rule 4 already gives
  stages.
- **A stall still pauses the rail.** A stalled member is not `done`, so
  the guard breaks the step loop, rule 5 breaks the stage walk below it,
  and the executor pauses the rail exactly as it does today.

Rule 4 is untouched: a stage advances when `steps.every(done)`,
whichever mode it ran in.

### 2.1 Dropping into a running group

`startIfStageRunning` ticks the workspace when a step lands on the stage
a rail is currently running, so a late arrival starts at once instead of
sitting `pending`. It needs no change. On a `sequence` group the tick
simply declines to launch the new member while an earlier one is still
running — the drop is correctly inert, and becomes live the moment the
member ahead of it finishes.

---

## 3. Conflicts

`detectConflicts` rule 1 reports every multi-step stage as a
`same-worktree` conflict of scope `stage`, because parallel steps share
the rail's checkout. It gains one condition: **`parallel` stages only**
(G5).

The conflict card's repair changes with it. "Make sequential" today calls
`splitStageIntoSequence`, which detonates the stage into N single-step
stages. It will instead call `setStageMode(stageId, "sequence")` — the
same guarantee, with the group left intact and still movable. The split
survives as the group menu's **Ungroup**, where destroying the group is
the point rather than a side effect.

`splitStageIntoSequence` keeps its contract of preserving the first
slice's stage id, which is what stops a running rail's `currentStageId`
being stranded mid-run. It clears `name` on every slice: a name
describes a group, and ungrouping is the act of saying there is no
longer one.

---

## 4. Interaction

### 4.1 The group header

A stage with ≥2 steps draws a header:

```
⠿  Merge and push            [ sequence | parallel ]   ⋯
```

- **⠿** — the drag handle for the whole group (§4.2).
- **name** — click to rename; empty falls back to the positional label
  the rail already draws (`stage 3`).
- **toggle** — `setStageMode`. Flipping to `parallel` while two members
  are running is impossible by construction: a `sequence` group has at
  most one running member, and flipping *to* parallel only lets the rest
  start on the next tick.
- **⋯** — **Save as template…**, **Ungroup**.

A `sequence` group draws its members stacked with the connector the rail
already uses between stages, so the ordering is visible without reading
the header. A `parallel` group keeps today's band.

### 4.2 Drag

`OrchDropTarget` and `OrchDragKind` grow to cover the two new gestures:

```ts
export type OrchDragKind = "step" | "card" | "tool" | "stage" | "template";

export type OrchDropTarget =
  | { kind: "new-stage"; railId: string; index: number }
  | { kind: "into-stage"; stageId: string; index: number }   // index is new
  | { kind: "unplace" };
```

- **`into-stage.index`** — the insertion point among the target stage's
  members, measured the same way `new-stage.index` is measured among
  stages: the pointer is past a member's midpoint or it is not. It obeys
  the same contract as `new-stage.index` — counted with the dragged step
  already removed, which is exactly what the glue measures, since the
  dragged chip is excluded from measurement.
- **`"stage"`** — dragging a group's handle moves the whole stage.
  `new-stage` targets mean "to this position in this rail";
  `into-stage` is refused, since nested groups are out of scope;
  `unplace` removes the group and every member — behind a confirm, since
  it is N steps at once rather than the one every other `unplace`
  removes.
- **`"template"`** — dragging a template row from the drawer.
  `new-stage` places it as a new group; `into-stage` merges its members
  into the target group at `index`, which is how *merge + push* is
  appended to a group that already exists.

### 4.2.1 Which band, and when

A **single-step stage** keeps today's three bands: the outer thirds mean
before/after, the middle band means "group with this", and within it the
member's own midpoint picks slot 0 or 1.

A **group** drops the bands and reads its whole rect by member. The three
bands cannot serve a group: its members tile it, so the outer thirds
would swallow the first and last slots and neither would have a gesture
at all. Before and after a group stay reachable through the connector
gaps between stages, and through the group's own header strip and
padding — inside the stage rect, over no member, and therefore read as a
gap.

The measured member list is the one with the dragged chip already
removed, which is what makes "is this a group" ask the right question: a
two-member group with one member in flight measures as a single-step
stage and correctly falls back to the bands, because that is what it is
about to be.

### 4.3 The drawer

A **Groups** section sits above **Tools** in `OrchestrationDrawer`, with
the same shape: scope-ordered (`workspace` then `global`, each
alphabetical), each row draggable, a **Manage** affordance opening the
library dialog. Rows are visible but inert when the daemon is too old
(§6), with the reason on hover and no drag handle — the same degradation
tools already use.

### 4.4 Saving and managing templates

**Save as template…** opens a small form: name, description, scope
(this workspace / all workspaces). The members are the group's tool
steps with their resolved overrides. Card steps are **excluded**, and
the form says so plainly when it excluded any — a template that silently
lost half a group would be worse than one that refused to save.

A group of card steps only has nothing to save; the menu item is
disabled with that as its reason.

Management (rename, re-scope, delete, reorder members) rides in
`ToolLibraryDialog` as a second tab rather than a new dialog. Re-scoping
is a re-save with the other `workspace_id`, exactly as it is for a tool
(T4).

---

## 5. Storage and the wire

### 5.1 Stage columns

`orch_stages` predates this and is already live on disk, so
`CREATE TABLE IF NOT EXISTS` would silently keep the old shape. The two
columns are added idempotently, the way `orch_steps.tool_id` was:

```rust
add_column_if_missing(&conn, "orch_stages", "mode", "TEXT")?;
add_column_if_missing(&conn, "orch_stages", "name", "TEXT")?;
```

A `NULL` mode reads as `"parallel"` (G2). A value that is neither known
mode reads as `"parallel"` too — an unknown discipline must degrade to
the one every existing plan already ran under, never to a silent
serialisation failure that drops the whole read.

### 5.2 Template table

```sql
CREATE TABLE IF NOT EXISTS orch_group_templates (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,            -- NULL = global to this machine
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    mode TEXT NOT NULL,
    steps TEXT NOT NULL,          -- JSON: [{ toolId, toolParams }]
    position INTEGER NOT NULL
);
```

Members are one JSON column rather than a child table, because a
template is only ever read and written whole — the same call the tool
library's `params` column makes.

### 5.3 Requests

```rust
/// This workspace's templates PLUS every global one, per GetTools.
/// Never an error for an unknown workspace -- an empty list.
GetGroupTemplates { workspace_id: String },
/// Upsert by id. `workspace_id: None` stores it global to this machine;
/// re-saving with the other value is how a template changes scope.
SaveGroupTemplate { template: GroupTemplate },
DeleteGroupTemplate { id: String },
```

`PROTOCOL_VERSION` → **15**, and all three variants take a
`min_version_for` arm of `15`. The plan itself is still replaced
wholesale (T8); templates are a separate targeted store, because a
template outlives every arrangement that uses it.

---

## 6. Compatibility

`mode` and `name` widen `SetOrchestration`, an existing request. The
compat gate is per request **type**, so `min_version_for` is structurally
blind to them: a v14 daemon parses the request perfectly, ignores both
fields, and hands the stage back `parallel` on the next read. A
sequential group would appear to work and then quietly flatten — the
exact failure `CLAUDE.md` warns about.

So the gate is in the app:

```ts
export const FEATURE_MIN_VERSION = {
  // ...
  // Groups. A v14 daemon has no `mode` or `name` column on orch_stages:
  // it accepts a sequential group and returns it parallel, so the group
  // silently runs its members all at once in one checkout. Nothing on
  // the wire gate catches a widened request, so every surface that can
  // form or change a group is disabled with the reason instead.
  groups: 15,
} as const;
```

The entry alone is a dead gate. `featureBlockedReason(compat, "groups")`
gets a consumer on **every** surface that can produce the payload:

1. The `into-stage` drop — a card, tool, step or template landing on a
   stage that would become a group. Refused, with the reason.
2. The group header's mode toggle and rename.
3. The group menu (**Save as template…**, **Ungroup**).
4. The drawer's Groups section (rows inert, per §4.3).
5. The conflict card's "Make sequential" repair, which now writes
   `mode`.

Surfaces that place a step as its own stage stay live throughout: a
single-step stage is what a v14 daemon already stores.

### 6.1 MCP

`gavin_get_orchestration` returns each stage's `mode` and `name`, and
`gavin_set_orchestration`'s schema documents both — including the
warning that omitting `mode` reverts a group to parallel, since the
request replaces the arrangement wholesale (G10). An agent preserving
step ids must preserve stage modes for the same reason and by the same
discipline.

The template library is **not** exposed to MCP in this round: an agent
can read and write arrangements, but cannot apply a template. Noted as a
follow-up rather than dropped silently.

---

## 7. Testing

Pure modules carry it, as they do everywhere else in this app.

| Surface | Where |
|---|---|
| `stageMode` tolerance, `setStageMode`, `renameStage`, `moveStageToIndex`, indexed `moveStepIntoStage`, group formation (G3) | `orchestration.test.ts` |
| Sequential scheduling: one member at a time, same-tick cascade, stall still pauses, rule 4 unchanged | `orchestration.test.ts` |
| Rule 1 exempts `sequence` stages; repair writes a mode | `orchestration.test.ts` |
| Template round-trip, scope derivation, card steps excluded on save | `orchestrationGroups.test.ts` (new) |
| Indexed `into-stage` hit-testing, `"stage"` and `"template"` drag kinds | `orchestrationDrag.test.ts` |
| Action wiring and optimistic writes | `orchestrationState.test.ts` |
| Column migration, `NULL` mode reads `parallel`, template CRUD and scope query | `crates/daemon/src/orchestration.rs` tests |
| `min_version_for` arm for the three new variants | `crates/protocol/src/lib.rs` tests |

The rendered group header, the drag gestures and the template dialog are
**not** coverable by these suites — this is a WKWebView app and pointer
capture is unreliable there. They become items in
`app/src/lib/smokeChecklist.ts`, statically pre-flighted (each item's
exact strings grepped against the committed source) rather than claimed
as verified.
