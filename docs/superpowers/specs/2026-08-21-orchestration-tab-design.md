# Orchestration Tab — Design Spec

A new workspace hub tab where the human lays out the workspace's work as
**rails** of **stages** of **steps**, arms a rail, and lets gavin advance it
— with conflicts between concurrently-running agents surfaced, not hidden.
Builds on the card model (`2026-08-20-kanban-card-model-design.md`), the Git
tab's worktrees (`2026-08-20-git-tab-sync-worktrees-design.md`), and the
orchestration home (`2026-08-19-agent-orchestration-home-design.md`).

**Goal:** turn the board's cards into a temporal plan the workspace can
execute. A rail is a vertical column of stages; a stage's steps run in
parallel, stages run one after another. Rails bind to a git worktree and to
a workspace page. A rail runs only once the human arms it. An agent skill
can author or re-author the whole arrangement.

**Out of scope:** a general dependency DAG (`after: [stepId]`), cross-rail
barriers, scheduling by wall-clock time, auto-merging a rail's worktree back,
retry/backoff policies, cost budgets, and any form of gavin *blocking* a run
because of a detected conflict.

---

## Decisions

| # | Decision |
|---|---|
| O1 | A rail auto-advances, but only after the human presses **Start** on that rail. Nothing spawns unarmed. |
| O2 | A step is a **reference to an existing card** (`cardPath`). Title, prompt, status, checklist stay in the card file — one source of truth. |
| O3 | The plan lives in the daemon's **SQLite**, alongside the board, reached through new `gavin_*` MCP tools. |
| O4 | Conflicts: **gavin supplies evidence, the agent judges.** Gavin computes structural conflicts and shows them; it never blocks a run. |
| O5 | Rail bindings are **lazy** — a rail is a name until a worktree/page is bound, and binding offers to provision. Re-binding affects future steps only. |
| O6 | A step is **done when its card reaches the board's done column** — the one with the highest `position`. Session exit with the card not done means **stalled**. |
| O7 | The reorganize skill is a **separate skill file**, `.claude/skills/gavin-orchestrate/SKILL.md`, plus a button on the tab. |
| O8 | Rails are **vertical columns**; time runs top→bottom. Rails sit in one CSS grid so stage index aligns across rails. |
| O9 | Conflict rendering uses **two independent axes**: severity is the colour (`--surface-danger` / `--surface-warning`), group identity is a **number badge**. |
| O10 | The scheduler is a **pure function** over (plan, run state, board, tree, worktrees) returning actions; the reactive layer only executes them. |
| O11 | Plan is replaced **wholesale** (like `replace_board`); run state is keyed by step id and survives. Deleting a **running** step is refused. |
| O12 | Per-worktree **dirty file paths** are evidence for the agent only. The app's own conflict detection never needs them. |

---

## 1. Data model

Two halves, deliberately separated: the **plan** is authored (by the human in
the tab, or by the agent through MCP) and is the agent's business; the **run
state** is machine-local runtime bookkeeping the agent never writes.

### 1.1 Plan

```ts
interface Rail {
  id: string;
  name: string;
  position: number;
  /// cwd for this rail's steps. Absent → each step falls back to its
  /// card's own contextFolder, and the rail raises a `rail-unbound`
  /// conflict (§5).
  worktreePath: string | null;
  /// Workspace page its sessions land on. Absent → the Agents-page
  /// posture handleAgentSessionSpawned already applies.
  pageId: string | null;
  stages: Stage[];
}

interface Stage { id: string; position: number; steps: Step[] }

/// A stage's steps run in parallel — in the SAME checkout, since they
/// share the rail's worktree. One step per stage is a sequential beat.
interface Step { id: string; position: number; cardPath: string }

/// The agent's own judgement, written by gavin_set_orchestration and
/// rendered in the Conflicts box beside the computed ones (§5).
interface ConflictNote { id: string; stepIds: string[]; note: string }

interface OrchestrationPlan { rails: Rail[]; conflictNotes: ConflictNote[] }
```

`Stage` carries no rail id and `Step` no stage id on the wire — containment
is the nesting, exactly as `Board` nests columns.

### 1.2 Run state

```ts
type RailState = "idle" | "running" | "paused";
type StepState = "pending" | "running" | "done" | "stalled";

interface RailRun { railId: string; state: RailState; currentStageId: string | null }
interface StepRun {
  stepId: string;
  state: StepState;
  sessionId: string | null;
  /// Human-readable stall cause; null otherwise.
  reason: string | null;
}

interface Orchestration {
  rails: Rail[];
  conflictNotes: ConflictNote[];
  railRuns: RailRun[];
  stepRuns: StepRun[];
}
```

A rail or step with no row is `idle` / `pending` — absence is the default,
so a freshly authored plan needs no run-state writes.

### 1.3 SQLite (`crates/daemon/src/orchestration.rs`)

A new module beside `kanban.rs`, same `open()`-creates-tables shape, same
`rusqlite` store held by `SessionManager`.

```sql
CREATE TABLE IF NOT EXISTS orch_rails (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
  position INTEGER NOT NULL, worktree_path TEXT, page_id TEXT);
CREATE TABLE IF NOT EXISTS orch_stages (
  id TEXT PRIMARY KEY, rail_id TEXT NOT NULL, position INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS orch_steps (
  id TEXT PRIMARY KEY, stage_id TEXT NOT NULL, position INTEGER NOT NULL,
  card_path TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orch_conflict_notes (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, note TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orch_conflict_note_steps (
  note_id TEXT NOT NULL, step_id TEXT NOT NULL, PRIMARY KEY (note_id, step_id));
CREATE TABLE IF NOT EXISTS orch_rail_runs (
  rail_id TEXT PRIMARY KEY, state TEXT NOT NULL, current_stage_id TEXT);
CREATE TABLE IF NOT EXISTS orch_step_runs (
  step_id TEXT PRIMARY KEY, state TEXT NOT NULL, session_id TEXT, reason TEXT);
```

`replace_plan(workspace_id, rails, notes)` runs in one transaction: delete
this workspace's plan rows, insert the new ones, then **delete run-state
rows whose step/rail id no longer exists**. Run state for surviving ids is
untouched — that is what lets the agent reorganize around live work (O11).

---

## 2. Daemon and protocol

### 2.1 Requests

| Request | Response | Notes |
|---|---|---|
| `GetOrchestration { workspace_id }` | `Orchestration { … }` | Empty plan for an unknown workspace, never an error. |
| `SetOrchestration { workspace_id, rails, conflict_notes }` | `Ok` | Wholesale replace; guards below. |
| `SetRailRun { rail_id, state, current_stage_id }` | `Ok` | Targeted, like `LinkCardSession`. |
| `SetStepRun { step_id, state, session_id, reason }` | `Ok` | Targeted. |
| `GetOrchestrationByRoot { root_path }` | `Orchestration { … }` | Root → watcher → workspace, per `board_by_root`; errors with "workspace not open in gavin". |
| `SetOrchestrationByRoot { root_path, rails, conflict_notes }` | `Ok` | Same resolution. |
| `GitDirtyPaths { cwd, limit }` | `DirtyPaths { paths, truncated }` | `status --porcelain -z`, paths only, capped (§8.1). |

### 2.2 Guards on `SetOrchestration`

Rejected wholesale with a message naming the offender, leaving the stored
plan untouched:

1. **A step whose `StepRun.state` is `running` is missing from the new
   plan.** Moving it between stages or rails is fine — the id survives, so
   its live session stays reachable. Deleting it would orphan a running
   agent. Message: `step <id> (<card path>) is running — pause or let it
   finish before removing it`. The path, not the title: the daemon stores
   `card_path` and never parses the card's frontmatter.
2. Duplicate `id` anywhere in rails/stages/steps.
3. A `ConflictNote.stepIds` entry that names no step in the same payload.
4. A `Rail.pageId` is *not* validated — pages are app-side config; a stale
   id degrades to the Agents-page fallback (§4.3).

### 2.3 Push

`SetOrchestration` (from either entry point) pushes
`OrchestrationChanged { workspace_id, orchestration }` on watching
connections, so an agent's rewrite lands in the open tab without a poll —
the same mechanism `GavinTreeChanged` uses. Run-state writes do **not**
push: they always originate in the app that is already holding the state.

---

## 3. App plumbing

### 3.1 Tauri commands (`app/src-tauri/src/lib.rs`)

`get_orchestration(workspace_id)`, `set_orchestration(workspace_id, rails,
conflict_notes)`, `set_rail_run(...)`, `set_step_run(...)` — thin daemon
forwards, matching `get_board`/`set_board`. Mirrored in `backend.ts`.

### 3.2 `orchestration.ts` — pure core

No Svelte, no Tauri, no I/O. Holds the wire types, `detectConflicts` (§5),
and `nextActions` (§4). Unit-tested like `kanban.ts` and `planBoard.ts`.

### 3.3 `orchestrationState.ts` — reactive layer

`writable<Record<string, Orchestration>>` keyed by workspace, fetched on tab
mount and on `orchestration-changed`. Plan mutations go through an
optimistic `mutateAndPersist` + wholesale `set_orchestration`, copied from
`kanbanState.ts` (including its rollback-unless-superseded rule and its
`pendingSaves` guard against a push clobbering an in-flight save). Run-state
mutations use the targeted commands.

It subscribes to what already flows through the app — `gavinTrees` (card
statuses), `handleSessionExited`, `handleSessionStatusChanged` — and after
every relevant change calls `nextActions`, then executes the returned
actions. Executing is the only place that touches sessions.

---

## 4. The scheduler

```ts
type Action =
  | { kind: "launch";   stepId: string }
  | { kind: "markDone"; stepId: string }
  | { kind: "stall";    stepId: string; reason: string }
  | { kind: "advance";  railId: string; stageId: string }
  | { kind: "complete"; railId: string };

function nextActions(
  orch: Orchestration,
  board: Board,
  tree: GavinTree | undefined,
  worktrees: WorktreeInfo[],
  liveSessionIds: Set<string>,
): Action[];
```

Pure and total: same inputs, same list. The tests feed a plan and a tree and
assert the actions — no app, no PTY, no daemon.

### 4.1 Rail lifecycle

```
idle ──Start──▶ running ──all stages complete──▶ idle (rendered "complete")
        ▲          │
        │          ├──Pause──▶ paused ──Resume──▶ running
        └──Reset───┴──a step stalls──▶ paused
```

- **Start** is offered only for a rail with at least one stage. It sets
  `state: running` and `currentStageId` to the first stage holding a
  non-`done` step.
- **Pause** stops advancing. Running sessions are never killed — pausing is
  about gavin's behaviour, not the agents'.
- **Resume** re-evaluates the current stage: it launches `pending` steps but
  will not advance past a `stalled` one.
- **Reset** clears every `StepRun` and `RailRun` for the rail. It never
  touches card statuses — the board is the human's record, not the
  scheduler's scratch space.

### 4.2 Per-tick rules, in order

For each rail in `running`, over its `currentStageId`:

1. Each step whose card's status slug (`slugStatus`, as the board
   matches) equals that of the **done column** — the board column with the
   highest `position` — → `markDone`. This runs before launching, so a stage of
   already-finished cards completes without spawning anything, and re-arming
   a rail is idempotent.
2. Each `pending` step → `launch`, unless a precondition fails, in which
   case `stall` with the reason:
   - card path not in the gavin tree → `card file is missing`
   - rail has a `worktreePath` not present in `worktrees` → `worktree
     <path> is gone`
   - the card is a `note` → `notes are not runnable`
3. Each `running` step whose `sessionId` is not in `liveSessionIds` and
   whose card is not done → `stall` with `agent exited before the card
   reached <done column>` (O6).
4. Every step in the stage `done` → `advance` to the next stage by
   `position`, or `complete` when there is none. An empty stage counts as
   complete. Advancing re-runs rules 1–4 on the new stage in the same tick,
   bounded by the rail's stage count, so a run of already-done stages
   collapses in one pass.
5. Any `stall` in this tick also sets the rail to `paused`.

**A board with no columns** yields no done column; rule 1 then never fires
and the rail cannot advance. The rail header says so explicitly rather than
appearing hung. (The daemon seeds three columns on first access, so this is
a degenerate case, not a normal one.)

### 4.3 Executing `launch`

Deliberately the *existing* card-run path, so the board and the tab can
never disagree about what is running:

1. `readFileForViewer(cardPath)` → `composeTaskPrompt` for a task,
   `composePlanPrompt` for a plan (`cardRun.ts`).
2. `buildRunCommand(resolvedAgentFor(workspaceId).command, prompt)`.
3. `createSession(cwd, command)` where `cwd = rail.worktreePath ??
   card.contextFolder`.
4. Place it: `switchToPage`-style insert into `rail.pageId` when that page
   still exists, otherwise `handleAgentSessionSpawned`'s Agents-page posture.
5. `linkCardSessionAction(...)` — the same `card_sessions` binding the
   board's Run button uses, so **Run** on the board jumps to the rail's
   session instead of double-spawning.
6. `setPlanFrontmatterField(cardPath, "status", "In Progress")` +
   `patchPlanField`, gated by `runStatusNeeded` exactly as today.
7. `setStepRun(stepId, "running", sessionId, null)`.

Any failure in 1–3 is a `stall` with the error text, not a thrown exception.

### 4.4 Restart reconciliation

Sessions are daemon-hosted and survive the app, so on mount the tab
reconciles rather than assumes: every `running` step whose `sessionId` is
absent from `liveSessionIds` becomes `stalled`. Rule 3 covers this — the
mount tick is just the first tick.

---

## 5. Conflicts

```ts
type Conflict =
  | { kind: "same-worktree";  severity: "live" | "potential"; stepIds: string[]; worktreePath: string }
  | { kind: "duplicate-card"; severity: "potential"; stepIds: string[]; cardPath: string }
  | { kind: "worktree-missing"; severity: "potential"; railId: string; worktreePath: string }
  | { kind: "rail-unbound";   severity: "potential"; railId: string }
  | { kind: "declared";       severity: "potential"; id: string; stepIds: string[]; note: string };
```

`detectConflicts(orch, tree, worktrees)` is pure and needs **no git file
state** (O12) — dirty paths exist only as evidence for the agent (§8.1).

**`same-worktree`** — the structural rule, and the only one that needed
thought. Two not-`done` steps conflict when they share an *effective*
worktree path (`rail.worktreePath ?? card.contextFolder`) **and** they could
overlap in time:

- Same rail: only steps in the **same stage**. Different stages of one rail
  are strictly sequential and can never overlap, so they are not a conflict.
- Different rails: **any** pair, because rails advance independently and
  gavin makes no ordering promise between them.

Severity is `live` when both steps are currently `running`, `potential`
otherwise. Note that a parallel stage is *by construction* a same-worktree
conflict — that is correct and intended: the human or agent deliberately put
two agents in one checkout, and the tab says so out loud rather than
pretending it is safe.

**`rail-unbound`** fires only for a rail that has steps; an empty rail being
unbound is just a rail you have not finished setting up.

Conflicts are sorted `live` first, then by the kind order above, then by
first step id, and numbered `1..n`. That number is the badge (§6.3).

---

## 6. The tab

`OrchestrationHubView.svelte`, registered in `HUB_VIEWS` after `kanban` with
`requiresRoot: true` and lucide's `Waypoints` icon.

### 6.1 Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ Orchestration              [Reorganize with agent…]    [+ Rail] │
├─────────────────────────────────────────────────────────────────┤
│ ⚠ 3 conflicts                                             [▾]   │
│  ①● same worktree · gavin-auth   "Add login form" ‖ "Refactor…" │
│  ②○ declared · "both rewrite GitDiff.svelte"         agent note │
│  ③○ no worktree bound · rail "docs"         [Bind worktree…]    │
├────────────────────┬────────────────────┬───────────────────────┤
│ backend        ‖ ⏸ │ ui             ▶   │ docs              ▶   │
│ ⑂ gavin-backend    │ ⑂ gavin-ui         │ ⑂ none  ③             │
│ ▸ Backend page     │ ▸ UI page          │ ▸ —                   │
├────────────────────┼────────────────────┼───────────────────────┤
│ ┌────────────────┐ │ ┌────────────────┐ │ ┌───────────────────┐ │
│ │ ✓ Wire the API │ │ │ Token sweep    │ │ │ Rewrite README    │ │
│ └────────────────┘ │ └────────────────┘ │ └───────────────────┘ │
│         │          │         │          │          │            │
│ ┏━ stage 2 ━━━━━━┓ │ ┌────────────────┐ │ ┌───────────────────┐ │
│ ┃ ┌─────┐ ┌─────┐┃ │ │ Icon migration │ │ │ Screenshots       │ │
│ ┃ │● ①  │ │  ②  │┃ │ └────────────────┘ │ └───────────────────┘ │
│ ┃ └─────┘ └─────┘┃ │                    │                       │
│ ┗━━━━━━━━━━━━━━━━┛ │                    │                       │
│         │          │                    │                       │
│ ┌────────────────┐ │                    │                       │
│ │ Ship it        │ │                    │                       │
│ └────────────────┘ │                    │                       │
└────────────────────┴────────────────────┴───────────────────────┘
```

One CSS grid, rails as columns (min 280px, horizontal scroll past the
viewport) and **stage index as rows** (O8), so rows auto-size to the tallest
stage at that index and a horizontal band reads as "roughly concurrent" —
the same read the conflicts box reasons about. Rails advance independently,
so the alignment is nominal, not a timeline; the header says "stage 2", not
a clock. One shared vertical scroll, which is fine for rails a handful of
stages long.

A **single-step stage** draws bare — the card plus a connector to the next
stage. A **multi-step stage** draws a labelled band spanning the rail width
with its steps side by side; three or more wrap into a grid inside the band
and the chips drop to title-only.

### 6.2 Chips and headers

**Rail header** (sticky, the board's column-header shape): name, worktree
chip, page chip, run state, and Start/Pause/Resume. Its overflow menu:
Rename, Bind worktree…, Bind page…, Reset, Delete rail. A rail-level
conflict (`worktree-missing`, `rail-unbound`) badges the header, not a chip.

**Step chip**: reuses `BoardCard`'s visual language — kind icon, title,
checklist `n/m`, status dot — plus a run-state ring: `pending` none,
`running` accent, `done` success + check, `stalled` danger + the reason on
hover. Its menu: Open card, Jump to session, Retry, Remove from rail. **Retry**
returns a `stalled` step to `pending` and clears its reason; the next tick
launches it under the rules of §4.2, so a retry re-reads the card and
re-checks the worktree rather than replaying the old command.

**Unplaced drawer**: a collapsible right-edge panel listing every task/plan
card not on any rail, draggable into the grid — the affordance that makes
this "based on what's in the plans/kanban" concrete. A **+ Add step** picker
on each stage covers the same ground for click and keyboard users.

### 6.3 Conflicts box

Pinned under the header, collapsible, and **absent entirely** when there are
none. Header counts (`⚠ 3 conflicts`). Each row: number badge, severity dot,
one-line description naming the participating steps and the shared resource,
and for `declared` the agent's note verbatim with an "agent note" tag. Rows
whose cause is a binding carry the fix inline — `Bind worktree…` — so the
box repairs rather than lectures.

Hovering a row highlights its chips and dims the rest; hovering a chip
highlights its rows. Clicking a row scrolls its first chip into view.

### 6.4 Colouring

Two axes, kept independent (O9):

- **Severity is the colour**, straight from `ui/theme.css`: `live` uses
  `--surface-danger` / `--border-danger` / `--danger-text`, `potential` uses
  `--surface-warning` / `--border-warning` / `--warning-text`. Both are
  already light/dark-aware, so nothing new enters the palette.
- **Group identity is the number badge**, shared between the box row and
  every participating chip. Numbers pair things unambiguously without a
  second hue axis and survive colourblindness. The `--lane-*` palette stays
  reserved for the git graph.

A chip in more than one conflict shows every badge and takes the highest
severity's colour.

### 6.5 Drag

Reuses the board's pointer-drag engine (`pointerDrag.ts`, `kanbanDrag.ts`
hit-testing, `KanbanDragPreview`). Drop targets and their meaning:

| Drop target | Result |
|---|---|
| The gap between two stages, or below the last | New stage there — **sequential** |
| Onto an existing stage's band | Joins that stage — **parallel** |
| Onto another rail | Moves rail *and* changes the step's effective worktree |
| Onto the unplaced drawer | Removed from the rail (card untouched) |

This is the whole "sequential, parallel, or a mix" interaction: the
difference between the two is which gap you drop into.

---

## 7. Rail bindings

Lazy, with provisioning offered (O5).

**Worktree.** `Bind worktree…` opens the existing `GitForkDialog`,
generalized: an `onPicked(path)` callback and an `allowSpawn` prop (default
`true`) so the "start an agent" checkbox is suppressed in this use. It
already offers new-branch and existing-branch modes and defaults the folder
to `defaultWorktreePath(root, branch)` — `<repo>-<branch>` — which is
exactly the rail-fork shape. Picking an existing worktree from
`refs.worktrees` is the other mode.

**Page.** `Bind page…` lists the workspace's pages and offers "New page
named after the rail", created through the existing page actions.

**Re-binding** rewrites the binding only. Sessions already running keep the
cwd they were spawned with; their chips show the worktree they actually ran
in, so history stays honest. Nothing is moved on disk and no session is
restarted.

**Deleting a rail** never removes a worktree or a page — those outlive the
plan that referenced them.

---

## 8. MCP tools

Two tools, added to `tool_definitions()` in `crates/gavin-mcp`. The read one
is deliberately rich; that is what keeps the skill short.

### 8.1 `gavin_get_orchestration`

No arguments. Composed by the MCP server from three daemon calls —
`GetOrchestrationByRoot`, `GetBoardByRoot`, `ScanGavinRoot` — plus one
`GitDirtyPaths` per distinct rail worktree:

```json
{
  "rails": [{
    "id": "r1", "name": "backend", "worktreePath": "/x/gavin-backend",
    "branch": "backend", "pageId": "p2",
    "dirtyPaths": ["app/src/lib/git.ts", "…"], "dirtyTruncated": false,
    "stages": [{ "id": "s1", "steps": [
      { "id": "t1", "cardPath": "…/wire-api.md", "title": "Wire the API",
        "kind": "task", "status": "Done", "run": "done" }]}]
  }],
  "conflictNotes": [{ "id": "n1", "stepIds": ["t3","t4"], "note": "…" }],
  "doneColumn": "Done",
  "columns": ["Todo", "In Progress", "Done"],
  "unplacedCards": [{ "path": "…", "title": "…", "kind": "plan", "status": "Todo" }]
}
```

`dirtyPaths` is capped at 200 per worktree with `dirtyTruncated` telling the
truth about it.

The payload carries **facts, not gavin's computed conflict list**. That list
is `detectConflicts` (§5), which is TypeScript in the app, while this server
is a separate Rust binary — returning it here would mean a second
implementation of one rule, free to drift from the one the human sees. The
facts the rule needs are all present (each rail's worktree, the stage
grouping, what is running, the dirty files), and the skill states the rule
itself in one sentence (§9.1, items 4–5). The human gets the rendered
analysis; the agent gets the evidence and the rule.

### 8.2 `gavin_set_orchestration`

One argument, `rails`, plus optional `conflict_notes` — the same shapes as
§1.1. Replaces the plan wholesale. Returns the guard errors of §2.2 as tool
errors, so a refused write tells the agent exactly which running step it
tried to delete.

---

## 9. The skill and the button

### 9.1 Skill file

`app/src-tauri/src/gavin_orchestrate_skill.md`, `include_str!`-embedded and
written to `.claude/skills/gavin-orchestrate/SKILL.md` by the same setup
pass. `McpLayout` currently names one `skill_file`; it becomes a list of
`(dir, file, contents)` and `write_skill` loops. Gavin-managed and
overwritten wholesale on every setup run, like the existing one.

Its substance:

1. **When**: the human asks to plan, order, parallelize, or reorganize the
   workspace's work; or asks why something is blocked.
2. **Read first** — `gavin_get_orchestration` returns the current rails, the
   live run state, gavin's computed conflicts, each rail's worktree with its
   dirty files, and every card not yet placed. Never author from memory.
3. **No rails yet?** Create one per natural workstream and propose a
   worktree name for each; the human provisions them in the tab.
4. **The parallelism rule, stated plainly**: a stage's steps run *at the same
   time in the same checkout*. Co-stage only work that genuinely does not
   touch the same files. Weigh the card bodies and the rail's `dirtyPaths`.
   **When unsure, serialize** — a wrong serial order costs time; a wrong
   parallel one costs a merge conflict in a live checkout.
5. **Account for the other rails**: two rails sharing a worktree have no
   ordering guarantee between them, so treat every pair across them as
   concurrent.
6. **Record the reasoning** — every judgement becomes a `conflict_note`
   naming its step ids, so the human reads *why* in the Conflicts box
   instead of trusting the arrangement blindly.
7. **Preserve step ids** you are keeping, and never remove a step whose
   `run` is `running`.
8. Write with `gavin_set_orchestration`, then say what changed and why.

### 9.2 The button

`Reorganize with agent…` composes a request carrying the current rails and
the current conflicts and bracketed-pastes it into the running workspace
agent through the existing `sendToMainAgent` path, then switches to Home to
watch. It never *starts* an agent — with none running it is disabled with
"Start the workspace agent on Home first", holding the same line the card-run
flow already holds.

---

## 10. Testing

Everything load-bearing is pure, so nearly all of it is vitest:

| Module | Covers |
|---|---|
| `orchestration.test.ts` | `nextActions`: arm, launch, markDone, advance through an all-done stage in one tick, stall on missing card / missing worktree / exited session, no-done-column, empty stage, bounded advance |
| `orchestration.test.ts` | `detectConflicts`: same-stage pair, cross-rail pair sharing a worktree, different stages of one rail *not* conflicting, duplicate card, missing worktree, unbound rail with and without steps, numbering order |
| `orchestrationState.test.ts` | optimistic mutate + rollback, push-vs-in-flight-save guard (mirrors `kanbanState.test.ts`) |
| `orchestration.rs` (daemon) | `replace_plan` drops orphaned run state and keeps surviving ids; the running-step deletion guard; per-workspace isolation; survives reopen |
| `gavin-mcp` | both tools' argument mapping and root resolution, per the existing `MockTransport` tests |

Per this project's convention the Svelte components carry no unit tests;
their logic lives in the two `.ts` modules above. Manual smoke: create two
rails, bind worktrees, arm both, watch a parallel stage raise a live
conflict, stall one by quitting its agent, Retry, Resume, then ask the agent
to reorganize and confirm the tab updates from the push.

---

## 11. Build order

Three sub-projects, each independently shippable and each leaving the tab in
a usable state — the shape this repo's larger features have already used.

**SP1 — Rails that run.** Protocol types, `orchestration.rs` store with its
guards, Tauri commands and `backend.ts`, the `orchestration.ts` pure core
with its tests, `orchestrationState.ts`, and a first
`OrchestrationHubView.svelte`: the grid, rail headers, step chips, empty
states, Start/Pause/Resume/Reset, and the add-step picker. No conflicts
surface, no drag, bindings editable as plain text fields. At the end of SP1 a
human can build a rail and watch it advance.

**SP2 — Conflicts and direct manipulation.** `detectConflicts`, the
conflicts box, the two-axis colouring and hover linking, the drag engine
wiring with its four drop targets, the unplaced drawer, and the real binding
flows (the `GitForkDialog` generalization and page binding).

**SP3 — The agent surface.** `GitDirtyPaths`, both MCP tools, the
`OrchestrationChanged` push wired into the tab, the multi-skill
`write_skill`, the skill file itself, and the `Reorganize with agent…`
button.

SP1 is the only one that must come first; SP2 and SP3 are genuinely
independent of each other — SP3's payload is facts the store already holds
(§8.1), so it does not wait on `detectConflicts`.
