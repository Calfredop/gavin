# Orchestration Tab — Design Spec

A new workspace hub tab where the human lays out the workspace's work as
**rails** of **stages** of **steps**, arms a rail, and lets gavin advance it
— with conflicts between concurrently-running agents surfaced, not hidden.
Builds on the card model (`2026-08-20-kanban-card-model-design.md`), the Git
tab's worktrees (`2026-08-20-git-tab-sync-worktrees-design.md`), and the
orchestration home (`2026-08-19-agent-orchestration-home-design.md`).

**Goal:** turn the board's cards into a temporal plan the workspace can
execute. A rail is a vertical column of stages; a stage's steps run in
parallel, stages run one after another. Rails bind to a git checkout — a
worktree, a branch, or both — and to a workspace page. A rail runs only once the human arms it. An agent skill
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
| O11 | Plan is replaced **wholesale** (like `replace_board`); run state is keyed by step id and survives. Deleting a step whose session is still **live** is refused (§2.2). |
| O12 | Per-worktree **dirty file paths** are evidence for the agent only. The app's own conflict detection never needs them. |
| O13 | **Separate worktrees are never a conflict**, same rail or different rails — sharing a checkout is the whole criterion. There is no step-level worktree, so a parallel stage always shares its rail's checkout; the box flags it and offers **Make sequential**. |
| O15 | A rail binds to a **checkout and a branch, orthogonally**: `worktreePath` says *which* checkout, `branch` says which branch gavin puts it on before launching. A branch with no worktree is the root checkout on that branch — **branches are a first-class alternative to a folder each**. Gavin switches only when no step of that rail is running, refuses on a dirty checkout, and never switches back. |
| O14 | A **card step renders the kanban card itself** — one `BoardCard`, with every board feature it has anywhere else. A **tool step keeps the chip**: a tool is not a card. On a rail the card wears the one fact the board leaves implicit — **which column it sits in**. |
| O16 | **Starting a rail spawns its own page**, named after it, when the rail has none. An explicit binding is never overridden, and a page that still exists is reused — only an unbound or closed-page rail gets a fresh one. The page is made **without being switched to**: the human stays on the tab they pressed Start in. A failed creation is not a stall: the rail arms onto the Agents-page fallback. |
| O17 | The tab's agent surface is **two scoped buttons, not one**. **Generate with agent…** in the tab header is about the cards *nobody has placed* — it hands the agent the unplaced list and asks for rails to hold it. A **wand in each rail header** is about *that rail's arrangement* — reorder, split, merge, and nothing else. Both drive the same `gavin-orchestrate` skill and both still write the WHOLE plan: the scope is what the agent may change, not what it sends. |

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
  /// WHICH BRANCH that checkout sits on (O15). Orthogonal to
  /// worktreePath: a branch with no worktree means the ROOT checkout on
  /// that branch — a rail per branch, with no folder per rail. Absent →
  /// whatever is checked out, which is the pre-O15 behaviour.
  branch: string | null;
  /// Workspace page its sessions land on. Absent until the rail is
  /// armed: Start gives an unbound rail a page of its own, named after
  /// it (O16). Still absent if that creation failed, and then the
  /// Agents-page posture handleAgentSessionSpawned already applies.
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
  position INTEGER NOT NULL, worktree_path TEXT, branch TEXT, page_id TEXT);
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

1. **A step whose `StepRun.state` is `running` *and whose `sessionId` the
   daemon still hosts* is missing from the new plan.** Moving it between
   stages or rails is fine — the id survives, so its live session stays
   reachable. Deleting it would orphan a running agent. Message: `step <id>
   (<card path>) is running — pause or let it finish before removing it`.
   The path, not the title: the daemon stores `card_path` and never parses
   the card's frontmatter. **Liveness is checked against the daemon's own
   PTY table, not taken from the row**: only the app writes run state, so a
   row it left at `running` for a session that has since ended (or one with
   no `sessionId` at all) has nothing left to orphan, and refusing on it
   would wedge the plan shut — the rail carrying it could never be edited
   or deleted again. §4.4's reconciliation is what normally clears such a
   row; this guard is what stops one from being fatal when it does not.
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
  | { kind: "complete"; railId: string }
  /// Put `path` on `branch` before anything of this rail launches (O15).
  | { kind: "switchBranch"; railId: string; path: string; branch: string };

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
- **Resume** re-evaluates the current stage: it launches `pending` steps and
  **retries `stalled` ones** (rule 2), so a failed step is re-attempted when
  the run reaches it rather than blocking the rail until someone presses its
  own Retry. It re-arms at the first unfinished stage when the stage it was
  paused on no longer exists — swept out by an edit, a reorganize or a Clear
  done — since a `currentStageId` naming nothing would otherwise read as
  "nothing left to point at" and complete the rail.
- **Reset** clears every `StepRun` and `RailRun` for the rail. It never
  touches card statuses — the board is the human's record, not the
  scheduler's scratch space.

**Arming spawns the rail's page (O16).** Both Start and Resume, before
writing `running`, ask `pageToSpawnForRail(rail, pages)` for the page this
rail should have: `null` when `rail.pageId` names a page that still
exists, otherwise the rail's own name, deduped against the workspace's
page names (`backend`, `backend 2`, …) so two same-named rails never
produce two indistinguishable tabs. A name means `createPage(workspaceId,
presetSingle, 1, name, { cwd, activate: false })` followed by
`bindRail(railId, { pageId })` — so the very first launch of the very
first tick already lands there. The page's own blank shell opens in the
rail's checkout (`worktreePath ?? root`, spelled as §4.3 spells it), so
the page is the rail's in the way that matters and not just by name. It
is **not** switched to: the human pressed Start on the Orchestration tab
and stays there, exactly as §4.3's own placement leaves the screen alone.
The sidebar and the rail's page chip are where the new page announces
itself. A rail whose page was
closed while it sat paused gets a new one on Resume for the same reason.
Creation failing is **not** a stall: the rail arms anyway and its launches
take §4.3's Agents-page fallback. A page is where agents land, not a
precondition for running them.

### 4.2 Per-tick rules, in order

**Rail precondition — the branch (O15).** Before any step rule runs, a
`running` rail whose `branch` is set is checked against the branch its
checkout actually has (`WorktreeInfo.branch`, already in the refs
snapshot). If they differ, the rail yields a single `switchBranch` and is
scheduled no further this tick; the executor switches and the next tick
proceeds. Three guards make this safe:

- **Never under a live agent.** If any step of that rail is `running`, no
  switch is emitted at all. A human who switches the branch mid-run has
  their checkout left alone; yanking it would rewrite files under a
  working agent.
- **Unknown is not wrong.** `worktrees === null` — the refs snapshot has
  not loaded — emits nothing, the same cold-start principle that keeps
  `worktree-missing` quiet.
- **Already there is a no-op.** Matching branches emit nothing, so this
  costs one comparison per tick once a rail is settled.

A branch the repo no longer has needs no rule of its own: the switch is
always attempted, always fails, and stalls with git's own message. That
is why `nextActions` keeps its signature — only `detectConflicts` needs
the branch list, to warn *before* the human presses Start.

For each rail in `running`, over its `currentStageId`:

1. Each not-yet-`done` step whose card's status slug (`slugStatus`, as the
   board matches) equals that of the **done column** — the board column with the
   highest `position` — → `markDone`. This runs before launching, so a stage of
   already-finished cards completes without spawning anything, and re-arming
   a rail is idempotent; it covers a `stalled` step too, so a card finished by
   hand is done rather than something rule 2 then retries.

   The status compared is the one the **board shows the card in**, not always
   the card's own: a nested task (`parent:` set, no `status:`) is drawn inside
   its parent's card, so it inherits the parent's status
   (`orchestration.effectiveStatus`, resolved on the same `planKey` the board
   nests on). Reading `plan.status` directly made a rail re-run every finished
   nested task.
2. Each `pending` or `stalled` step → `launch`, unless a precondition fails,
   in which case `stall` with the reason:
   - card path not in the gavin tree → `card file is missing`
   - rail has a `worktreePath` not present in `worktrees` → `worktree
     <path> is gone`
   - the card is a `note` → `notes are not runnable`

   Retrying a `stalled` step re-derives the blocker rather than replaying the
   old command, so it either goes this time or stalls again on its own merits
   — and a fresh stall re-pauses the rail (rule 5), which keeps this to one
   attempt per press of Play rather than a spin.
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
   By the first launch `rail.pageId` normally names a page of the rail's
   own — arming created it (§4.1) — so the fallback is for the rail whose
   page creation failed, not the ordinary case.
5. `linkCardSessionAction(...)` — the same `card_sessions` binding the
   board's Run button uses, so **Run** on the board jumps to the rail's
   session instead of double-spawning.
6. `setPlanFrontmatterField(cardPath, "status", "In Progress")` +
   `patchPlanField`, gated by `runStatusNeeded` exactly as today.
7. `setStepRun(stepId, "running", sessionId, null)`.

Any failure in 1–3 is a `stall` with the error text, not a thrown exception.

### 4.4 Executing `switchBranch`

Three steps, and the first one is a refusal gate:

1. `gitStatus(path)`. **Any staged or unstaged change refuses the
   switch** — deliberately stricter than git, which would happily carry
   non-conflicting edits across. Uncommitted work migrating into a rail's
   branch behind the human's back is worse than a stalled rail, and
   stashing is not gavin's to do: the stash stack is shared with every
   other checkout of the repo.
2. `gitCheckout(path, branch, null)`. Git's own refusals arrive here —
   most usefully "already checked out at <other worktree>", which is the
   one failure a bound branch hits routinely.
3. `refresh(workspaceId)` so the refs snapshot carries the new branch and
   the next tick sees the rail as settled. `git worktree list` reports
   every checkout's branch from any cwd in the repo, so refreshing from
   the Git tab's own cwd is enough.

Then the tick runs **again**. A switch is the one action that changes
what the scheduler *reads* rather than only what it has already decided,
so the rail becomes launchable a pass later; `executeActions` returns
that fact and `tick` re-enters once its own re-entrancy guard is
released. The follow-up is asked for **only when the refreshed snapshot
actually names the new branch** — a refresh that failed leaves the old
one in place, and re-ticking on that would re-emit the same switch
forever, since checking out a branch you are already on succeeds every
time.

A refusal at 1 or a failure at 2 `stall`s every `pending` step of the
rail's current stage with the reason, which pauses the rail through rule
5 — the same path a failed launch takes. **A completed rail is never
switched back.** What the agent did stays checked out, in view, ready to
diff and merge; restoring the previous branch would hide the work at the
exact moment it became interesting, and could itself fail on the dirty
tree the rail just created.

### 4.5 Restart reconciliation

Sessions are daemon-hosted and survive the app, so on mount the tab
reconciles rather than assumes: every `running` step whose `sessionId` is
absent from `liveSessionIds` becomes `stalled`. Rule 3 covers this — the
mount tick is just the first tick.

**Every rail, not only the running ones.** Reconciliation is about what the
sessions say, not about whether the rail is advancing, so a tick also sweeps
rails that are `idle` or `paused`: each of their `running` steps whose
session is gone takes the same verdict as rule 3 (a card already in the done
column counts as `done`, everything else `stalled`). Nothing is launched and
no stage advances there — the rail is not running, and a stall on it does
not re-label it `paused` (rule 5 stops a rail that is *advancing*). Without
this sweep such a step has no tick that would ever correct it, and §2.2's
guard then refuses every plan write that drops it: the rail becomes
impossible to edit or delete.

**When the DAEMON died too.** §4.5 as written covers the app dying while
the daemon lived — sessions survive, so absence from `liveSessionIds` is
the whole signal. A daemon that was killed (a power cut, an OS restart,
or the Restart daemon button the app itself tells people to press after a
protocol bump) leaves a strictly harder case: the daemon puts every
session back under its ORIGINAL id, so the step's session IS in
`liveSessionIds`, and rule 3 can never speak for it.

What comes back is not the run. `SessionManager::recover` stamps every
registry row with the daemon lifetime that created it, and a row it
inherited is one no process is hosting any more; if that row carried a
command — which for every agent gavin launches is the entire prompt — the
command is NOT re-run. The session returns as a bare shell in the same
cwd, marked `interrupted`, and that fact reaches the app as
`SessionSummary.interrupted` and the `SessionInterrupted` push
(`layoutState.interruptedSessionIds`).

So `nextActions` takes that set as its last argument and gains **rule
3c**: a `running` step whose session was interrupted takes a `stall` with
its own reason — *interrupted — the daemon restarted, so this step's
agent is gone* — unless its card already reached the done column, which
outranks it exactly as it does for a dead session. Rule 5 turns the stall
into a paused rail, which is the point: the decision goes to the human
rather than gavin silently re-running work in a checkout that already
carries the first attempt's edits. Whoever does want exactly that presses
Resume, which retries a stalled step (rule 2) — one attempt, asked for.

3c is checked **before** 3b. An interrupted agent-tool step's session
reports `idle`, because a shell sitting at a prompt is idle, and
`agentTurnEnded` would read that as a finished turn and mark the step
done.

**And the tab has to go when the session did not come back.** A record
`recover` could not respawn is marked `Exited`, and `Attach` then sends
neither a status nor an exit event for it — so the id sits in the layout
tree, `liveSessionIds` still contains it, and no rule above can ever
correct the step. `reconcileLayoutSessions` (`layoutState.ts`) closes
that: it reads the daemon's own session list and clears every layout tab
with no session behind it, at frontend startup and after a daemon
restart. Rust does the same sweep once per app process
(`session::resolve_workspaces`); this is the same reconciliation on the
two occasions that one misses.

---

## 5. Conflicts

```ts
type Conflict =
  | { kind: "same-worktree";  scope: "stage" | "rails"; stageId: string | null; severity: "live" | "potential"; stepIds: string[]; worktreePath: string }
  | { kind: "duplicate-card"; severity: "potential"; stepIds: string[]; cardPath: string }
  | { kind: "nested-with-parent"; severity: "potential"; stepIds: string[]; cardPath: string; parentPath: string }  // amended 2026-09-02
  | { kind: "worktree-missing"; severity: "potential"; railId: string; worktreePath: string }
  | { kind: "branch-missing"; severity: "potential"; railId: string; branch: string }
  | { kind: "rail-unbound";   severity: "potential"; railId: string }
  | { kind: "declared";       severity: "potential"; id: string; stepIds: string[]; note: string };
```

`detectConflicts(orch, tree, worktrees, branches)` is pure and needs **no
git file state** (O12) — dirty paths exist only as evidence for the agent
(§8.1). `branches` is the repo's local branch names, `null` while the refs
snapshot loads: unknown must not read as "every branch was deleted".

**`same-worktree`** — the structural rule, and the only one that needed
thought. **Sharing a checkout is the whole criterion: two steps on separate
worktrees are never a conflict, whether they sit on the same rail or on
different ones.** Worktree isolation is the answer, and where it holds the
tab stays quiet.

The checkout a step runs in is `rail.worktreePath ?? <the workspace root>` —
deliberately *not* the cwd fallback `nextActions` uses. A step launched from
an unbound rail starts in its card's `contextFolder`, but that folder is a
subdirectory of the root checkout, not a checkout of its own; treating it as
one would report isolation that does not exist. Two functions, two
questions: `effectiveWorktree` answers "where does this agent start", and
`conflictCheckout` answers "which working tree does it edit".

Two not-`done` steps conflict when they share that checkout **and** could
overlap in time:

- **Same rail: only steps in the same stage** (`scope: "stage"`). Different
  stages of one rail are strictly sequential and can never overlap.
- **Different rails: any pair** (`scope: "rails"`), because rails advance
  independently and gavin makes no ordering promise between them.

Severity is `live` when at least two of the group are actually running,
`potential` otherwise — a single running step cannot collide with anything
by itself.

A parallel stage within one rail is therefore *always* a `scope: "stage"`
conflict: its steps share the rail's checkout by construction, and there is
no step-level worktree to escape into (D-O13). That is intended, not a gap.
The tab says so out loud and offers the repair — **Make sequential**, which
splits the stage into consecutive single-step stages. Running two agents in
one working tree is a real hazard; the honest options are "put them on
different rails with different worktrees" or "run them one after another",
and the box names the second one.

**`nested-with-parent`** (amended 2026-09-02) is `duplicate-card`'s story
told about two *different* cards that are one piece of work: a nested task
and the plan it nests inside, both on rails, neither `done`. The plan's agent
works its children — its card step draws them (§6.2) — so the child's own
step re-runs work the rail is already scheduled to do. Only ever reached
deliberately, since neither the drawer nor the picker offers a nested child
(§6.2), which is why it says so rather than refusing: breaking a child out
onto a rail of its own can be right, and giving it a `status:` is how the
human makes that permanent.

**`branch-missing`** is `worktree-missing`'s twin for O15: the rail names a
branch the repo no longer has. Rail-level, so it badges the header rather
than any chip — the cause is the binding, not a step.

**Two rails, one checkout, different branches** needs no kind of its own.
Sharing a checkout is already the whole criterion (O13), so those rails are
already a `same-worktree` conflict at `scope: "rails"`; differing branches
only make it worse, and the box says which two branches are being fought
over rather than opening a second row about the same pair.

**`rail-unbound`** fires only for a rail that has steps; an empty rail being
unbound is just a rail you have not finished setting up. A `branch` does not
clear it: `rail-unbound` is about *cwd* — where the agent's shell starts —
and a branch says nothing about that. The two bindings answer different
questions and are reported separately.

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
a clock.

**Vertical scrolling is per rail**, the kanban's rule: the grid takes the
horizontal axis and pins its row track to its own height, so every rail is
exactly one viewport tall and scrolls its own stages. The first draft gave
the grid one shared vertical scroll — fine for rails a handful of stages
long, and wrong the moment one rail outgrew the rest, because reading its
tail dragged every other rail's steps off the top and left the sticky
headers as the only thing saying which column you were in. Rails advance
independently; so should their scrollbars.

A **single-step stage** draws bare — the card plus a connector to the next
stage. A **multi-step stage** draws a labelled band spanning the rail width
with its steps side by side, wrapping to a stack once a card-sized step no
longer fits beside its neighbour; the band, not the row, is what marks them
concurrent.

### 6.2 Chips and headers

**Rail header** (fixed by layout, outside the rail's scroller — the board's
column-header shape): name, worktree
chip, page chip, run state, and Start/Pause/Resume. Its overflow menu:
Rename, Bind worktree…, Bind page…, Reset, Delete rail. A rail-level
conflict (`worktree-missing`, `rail-unbound`) badges the header, not a chip.

**Card step** (O14): *the* kanban card — the same `BoardCard` over the board's
own projection, so it opens on click, right-clicks to the board's card menu,
runs from its own pills, and carries its session dot, labels, priority,
checklist and nested children exactly as it does on the board. The two
rail-only facts are drawn **around** it rather than into it: a run-state ring
on its wrapper (`pending` none, `running` accent, `done` success + dimmed,
`stalled` danger) and, as the card's last row, a **rail strip** — the state in
words, the conflict badges, **Retry** while stalled, and **Remove from rail**.
A card the board has no projection for (deleted out from under the plan, or
the board still loading) falls back to the slim chip, which can say so.

The card also wears its **column** as a filled badge beside its context badge:
off the board, the column is no longer the strip the card is standing in. Only
surfaces off the board pass it — on the board it would be noise on every card.

**Tool step**: keeps the chip (tools spec §5.2). A tool is not a card, and the
dashed chip is what says so.

**Retry** returns a `stalled` step to `pending` and clears its reason; the next
tick launches it under the rules of §4.2, so a retry re-reads the card and
re-checks the worktree rather than replaying the old command. It stays the way
to re-attempt ONE step out of turn — running the rail retries the failed steps
it reaches anyway (rule 2).

**Unplaced drawer**: a collapsible right-edge panel listing every task/plan
card not on any rail, draggable into the grid — the affordance that makes
this "based on what's in the plans/kanban" concrete. A **+ Add step** picker
on each stage covers the same ground for click and keyboard users.

**Amended 2026-09-02:** a **nested** child (`parent:` set, no `status:`) is
not listed by either, nor by `gavin_get_orchestration`'s `unplacedCards`. It
has no card of its own on the board — it is drawn inside its plan's card, and
so inside that plan's card step here (§6.2) — so the **plan is the unit of
placement** and a rail carrying it carries the children. The plan's row wears
a `+N` for the children it carries, so they read as folded in rather than
gone. A child with a `status:` of its own is free-standing and unaffected.

Placing one deliberately is still possible from the child's own card menu;
`nested-with-parent` (§5) is what says the plan is on a rail too.

### 6.3 Conflicts box

Pinned under the header, collapsible, and **absent entirely** when there are
none. Header counts (`⚠ 3 conflicts`). Each row: number badge, severity dot,
one-line description naming the participating steps and the shared resource,
and for `declared` the agent's note verbatim with an "agent note" tag. Rows
carry their repair inline, so the box fixes rather than lectures:
`Bind worktree…` for the two rail-binding kinds, and **`Make sequential`**
for a `scope: "stage"` conflict, which rewrites that stage into consecutive
single-step stages in order, preserving step ids so run state survives.

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

A step in more than one conflict shows every badge and takes the highest
severity's colour — as a tint framing the card, which keeps the card's own
kind colours intact (O9: two axes, never two fills).

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

**A drop onto the stage a rail is *currently running* starts at once.** That
stage is a beat already in flight, so a step joining it is late rather than
next, and leaving it `pending` until some unrelated change ticked the
workspace made the drop look inert — the only way past it was Pause/Resume.
The drop itself ticks (`isStageRunning` → `tick`), so the launch stays the
scheduler's, with the same blockers, the same stall reasons, and rule 1 still
skipping a card already in the done column. It covers a card, a tool, and a
step dragged up from a later stage — the same three sources the band accepts.
Every other target stays queued: a new stage is a later beat, and O1 holds, so
an idle or paused rail spawns nothing however live the stage looked when it
last ran.

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

**Branch.** A second section in the same dialog, and the reason a rail
needs no folder of its own: "whatever is checked out" (the default), every
local branch with where it is currently checked out, and **New branch…** —
name plus start point, validated by the existing `validateBranchName` and
created with `createBranch(..., checkoutAfter: false)`. Creating the branch
does not move the human's checkout; the rail's own Start does that, once,
when it is armed.

**Page.** `Bind page…` lists the workspace's pages and offers "New page
named after the rail", created through the existing page actions. Leaving
it unbound is not "the Agents page" but "a page of its own, made at
Start" (O16, §4.1) — which is what the option and the rail's page chip
say.

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
    "branch": "feature/api", "pageId": "p2",
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
truth about it. `branch` is the rail's *binding* — a stored field, free to
return. The branch the checkout is **actually on right now** is still
deliberately absent: reading it would cost another daemon request type, and
the agent reasons about the arrangement, not about the working tree's
current head.

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
3. **No rails yet?** Create one per natural workstream and propose an
   isolation for each — a worktree where the work is long-lived or needs
   its own files on disk, a plain branch where it is not; the human
   provisions them in the tab.
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

### 9.2 The two buttons

Both compose their request in `orchestrationPrompts.ts` — pure text, so the
wording is testable without a terminal to paste into — and bracketed-paste it
into the running workspace agent through the existing `pasteToMainAgent`
path, then switch to Home to watch. Neither ever *starts* an agent: with none
running both are disabled with "Start the workspace agent on Home first",
holding the same line the card-run flow already holds.

**`Generate with agent…`** (tab header) carries the **unplaced cards** —
title, status and path each — plus the rails the tab currently shows and
gavin's current conflicts. With every runnable card already on a rail it has
nothing to ask for, and is disabled saying so.

**The wand in a rail header** carries **that rail alone**: its binding
(worktree and branch), its stages with each step named as the tab names it
and marked with any live run state, and only the conflicts that concern it —
its rail-level ones plus every step-level one naming a step it holds
(`conflictsForRail`). It asks for a rearrangement of the steps already there,
and for every other rail to come back untouched.

---

## 10. Testing

Everything load-bearing is pure, so nearly all of it is vitest:

| Module | Covers |
|---|---|
| `orchestration.test.ts` | `nextActions`: arm, launch, markDone, advance through an all-done stage in one tick, stall on missing card / missing worktree / exited session, no-done-column, empty stage, bounded advance |
| `orchestration.test.ts` | `detectConflicts`: same-stage pair, cross-rail pair sharing a worktree, different stages of one rail *not* conflicting, duplicate card, missing worktree, missing branch (and quiet while refs load), unbound rail with and without steps, numbering order |
| `orchestration.test.ts` | `nextActions` branch precondition: `switchBranch` emitted for a mismatched checkout, suppressed while a step of that rail runs, suppressed on an unloaded refs snapshot, and silent once the branches match |
| `orchestrationPrompts.test.ts` | both agent requests: Generate lists every unplaced card with status and path, says so when nothing is unplaced, summarises the rails with their bindings, asks for rails when there are none; a rail's own prompt names only that rail, lays its stages out in order, names card and tool steps as the tab does (falling back to the raw id for a deleted one), marks live run state, and carries only the conflicts it was handed |
| `orchestrationState.test.ts` | optimistic mutate + rollback, push-vs-in-flight-save guard (mirrors `kanbanState.test.ts`); executing `switchBranch`: clean checkout switches and refreshes, dirty checkout refuses without calling git, a git failure stalls the stage's pending steps; the follow-up tick is asked for on a caught-up snapshot and refused on a stale one |
| `orchestration.rs` (daemon) | `replace_plan` drops orphaned run state and keeps surviving ids; the running-step deletion guard; per-workspace isolation; survives reopen |
| `gavin-mcp` | both tools' argument mapping and root resolution, per the existing `MockTransport` tests |

Per this project's convention the Svelte components carry no unit tests;
their logic lives in the two `.ts` modules above. Manual smoke: create two
rails, bind worktrees, arm both, watch a parallel stage raise a live
conflict, stall one by quitting its agent, Retry, Resume, then press Generate
with agent… and confirm the agent is handed the unplaced cards and the tab
updates from the push, and the wand on one rail and confirm it rearranges
that rail and leaves the others alone (O17). For O15: bind a
third rail to a branch with no worktree, arm it on a clean root checkout and
watch it switch; dirty the checkout and confirm the next rail stalls saying
so rather than switching.

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
