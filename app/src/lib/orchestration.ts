// The orchestration plan and its scheduler, as pure data and pure
// functions (orchestration spec O10). No Svelte, no Tauri, no I/O --
// orchestrationState.ts owns every side effect. TS mirrors of
// crates/protocol's orchestration shapes (camelCase on the wire).

import type { Board, Column } from "./kanban";
import type { GavinTree, PlanFileInfo } from "./gavin";
import type { WorktreeInfo } from "./git";
import { slugStatus } from "./planBoard";

export interface Step {
  id: string;
  position: number;
  /// The card file's absolute path -- a step is a REFERENCE to a card
  /// (spec O2); title, prompt and status all stay in the file. `""` for
  /// a TOOL step, which carries `toolId` instead (tools spec T1). Never
  /// both, never neither: the daemon refuses either shape.
  cardPath: string;
  /// The tool this step runs, or null for a card step.
  toolId?: string | null;
  /// Per-step parameter OVERRIDES only. A parameter the human never
  /// touched is absent and resolves to the tool's own default, so a
  /// later edit to that default still reaches this step.
  toolParams?: Record<string, string>;
}

/// A step is a card step or a tool step, and almost everything branches
/// on exactly this. One predicate so the rule has one spelling.
export function isToolStep(step: Step): boolean {
  return Boolean(step.toolId);
}

/// The overrides a step carries, tolerating the field being absent --
/// steps written by an agent that predates tools have no `toolParams`.
export function stepParams(step: Step): Record<string, string> {
  return step.toolParams ?? {};
}

/// Stages run one after another; a stage's steps run in parallel, in the
/// SAME checkout, since they share the rail's worktree.
export interface Stage {
  id: string;
  position: number;
  steps: Step[];
}

export interface Rail {
  id: string;
  name: string;
  position: number;
  /// cwd for this rail's steps. Null falls back to each card's own
  /// contextFolder (see effectiveWorktree) and raises a `rail-unbound`
  /// conflict in SP2.
  worktreePath: string | null;
  /// WHICH BRANCH that checkout sits on (spec O15). Orthogonal to
  /// worktreePath, which says WHICH checkout: a branch with no worktree
  /// means the ROOT checkout on that branch, which is the point -- a
  /// rail per branch, without a folder per rail. Null means "whatever is
  /// checked out", the behaviour that predates the field, so it is
  /// optional on the wire and absent on plans written before it.
  branch?: string | null;
  /// Workspace page its sessions land on. Null until the rail is armed:
  /// Start gives an unbound rail a page of its own, named after it (spec
  /// O16, pageToSpawnForRail). Still null if that creation failed, and
  /// then the launch falls back to the Agents-page posture
  /// handleAgentSessionSpawned already applies.
  pageId: string | null;
  stages: Stage[];
}

export interface ConflictNote {
  id: string;
  stepIds: string[];
  note: string;
}

/// The only thing this module needs to know about a tool: that it
/// exists, and what to call it in a stall reason or a conflict line. The
/// tool's kind, body and params are orchestrationTools.ts's business,
/// and keeping them out of here keeps the scheduler's inputs small.
export interface ToolSummary {
  id: string;
  name: string;
}

export type RailState = "idle" | "running" | "paused";
export type StepState = "pending" | "running" | "done" | "stalled";

export interface RailRun {
  railId: string;
  state: RailState;
  currentStageId: string | null;
}

export interface StepRun {
  stepId: string;
  state: StepState;
  sessionId: string | null;
  /// Human-readable stall cause; null otherwise.
  reason: string | null;
}

export interface Orchestration {
  rails: Rail[];
  conflictNotes: ConflictNote[];
  railRuns: RailRun[];
  stepRuns: StepRun[];
}

export function emptyOrchestration(): Orchestration {
  return { rails: [], conflictNotes: [], railRuns: [], stepRuns: [] };
}

/// A card resolved out of the gavin tree, with the context folder that
/// owns it -- the cwd fallback for an unbound rail.
export interface CardEntry {
  plan: PlanFileInfo;
  contextFolder: string;
}

/// The board's done column: the one with the highest `position`, NOT the
/// last array element (spec O6). Null for a board with no columns, in
/// which case nothing can ever complete and the rail header says so.
export function doneColumn(board: Board): Column | null {
  let best: Column | null = null;
  for (const c of board.columns) {
    if (!best || c.position > best.position) best = c;
  }
  return best;
}

export function cardIndex(tree: GavinTree | undefined): Map<string, CardEntry> {
  const index = new Map<string, CardEntry>();
  if (!tree || tree.rootMissing) return index;
  for (const ctx of tree.contexts) {
    for (const plan of ctx.plans) {
      index.set(plan.path, { plan, contextFolder: ctx.folderPath });
    }
  }
  return index;
}

/// WHERE AN AGENT'S SHELL STARTS. Not the isolation question: SP2 adds
/// `conflictCheckout` for that, because a card's contextFolder is a
/// subdirectory of the root checkout rather than a checkout of its own
/// (spec O13). Keep the two apart.
export function effectiveWorktree(rail: Rail, entry: CardEntry | undefined): string | null {
  return rail.worktreePath ?? entry?.contextFolder ?? null;
}

export function stepStateOf(orch: Orchestration, stepId: string): StepState {
  return orch.stepRuns.find((r) => r.stepId === stepId)?.state ?? "pending";
}

export function railStateOf(orch: Orchestration, railId: string): RailState {
  return orch.railRuns.find((r) => r.railId === railId)?.state ?? "idle";
}

/// Where Start arms the rail: the first stage (by position) holding a
/// step that is not already `done`. Cards that are ALREADY in the done
/// column are not considered here -- nextActions marks and cascades past
/// them on the first tick, which keeps this trivial and keeps one place
/// deciding what "done" means.
export function firstUnfinishedStageId(rail: Rail, orch: Orchestration): string | null {
  const stages = [...rail.stages].sort((a, b) => a.position - b.position);
  for (const stage of stages) {
    if (!stage.steps.every((s) => stepStateOf(orch, s.id) === "done")) return stage.id;
  }
  return null;
}

/// What the reactive layer must DO. nextActions decides; executing is
/// orchestrationState.ts's job alone.
export type Action =
  | { kind: "launch"; stepId: string }
  | { kind: "markDone"; stepId: string }
  | { kind: "stall"; stepId: string; reason: string }
  | { kind: "advance"; railId: string; stageId: string }
  | { kind: "complete"; railId: string }
  /// Put `path` on `branch` before anything of this rail launches
  /// (spec O15). orchestrationState owns the git call and the refusal.
  | { kind: "switchBranch"; railId: string; path: string; branch: string };

/// Why a pending step cannot be launched right now, or null.
/// `knownWorktrees` is null when the worktree list has not loaded yet --
/// unknown must never look like "gone", or a cold start would stall
/// every bound rail.
///
/// `knownTools` is null on the same principle: the library is fetched
/// asynchronously, and an unloaded library must not read as "every tool
/// was deleted".
function launchBlocker(
  rail: Rail,
  step: Step,
  entry: CardEntry | undefined,
  knownWorktrees: Set<string> | null,
  knownTools: Set<string> | null
): string | null {
  if (isToolStep(step)) {
    if (knownTools && !knownTools.has(step.toolId as string)) {
      return "tool is no longer in the library";
    }
  } else {
    if (!entry) return "card file is missing";
    if (entry.plan.kind === "note") return "notes are not runnable";
  }
  if (rail.worktreePath && knownWorktrees && !knownWorktrees.has(rail.worktreePath)) {
    return `worktree ${rail.worktreePath} is gone`;
  }
  return null;
}

/// The branch a running rail's checkout must be put on before anything
/// of that rail launches, or null (spec O15). At most ONE per rail: the
/// checkout belongs to the rail, not to a step.
///
/// Four ways to answer null, and each is load-bearing:
/// - the rail binds no branch, so there is nothing to enforce;
/// - `worktrees` has not loaded, and unknown must never read as "on the
///   wrong branch" -- the same cold-start rule launchBlocker follows;
/// - the checkout is not a worktree of this repo, which is
///   `worktree-missing`'s story to tell, not a switch to attempt;
/// - a step of this rail is RUNNING, or none is pending. Switching under
///   a live agent would rewrite files beneath it, and switching for a
///   rail with nothing left to launch would move the human's checkout
///   for no one's benefit.
///
/// Deliberately `conflictCheckout`, not `effectiveWorktree`: a branch is
/// a property of a WORKING TREE, and an unbound rail's cards live in
/// subdirectories of the root checkout rather than in checkouts of their
/// own. The same distinction §5 draws for conflicts.
function branchSwitchFor(
  rail: Rail,
  orch: Orchestration,
  tree: GavinTree | undefined,
  worktrees: WorktreeInfo[] | null
): Action | null {
  if (!rail.branch || !worktrees) return null;
  const path = conflictCheckout(rail, tree);
  if (!path) return null;
  const checkout = worktrees.find((w) => w.path === path);
  if (!checkout || checkout.branch === rail.branch) return null;

  const steps = rail.stages.flatMap((s) => s.steps);
  if (steps.some((t) => stepStateOf(orch, t.id) === "running")) return null;
  if (!steps.some((t) => stepStateOf(orch, t.id) === "pending")) return null;

  return { kind: "switchBranch", railId: rail.id, path, branch: rail.branch };
}

/// What a finished TOOL step's session says about it (tools spec T5).
/// There is no card and therefore no done column to reach, so the exit
/// code is the whole verdict.
///
/// An UNKNOWN code is a stall, not a pass: it means the app was not
/// running when the session ended, so nobody witnessed the outcome, and
/// silently marking it done would advance the rail on an assumption.
function toolStepOutcome(
  exitCode: number | undefined,
  label: string
): { kind: "markDone" } | { kind: "stall"; reason: string } {
  if (exitCode === 0) return { kind: "markDone" };
  if (exitCode === undefined) {
    return { kind: "stall", reason: `${label}'s session ended while gavin was not watching` };
  }
  return { kind: "stall", reason: `${label} exited with code ${exitCode}` };
}

/// The scheduler (spec §4.2). Pure and total: same inputs, same list.
/// Rules run in order per stage -- mark done, launch or stall pending,
/// stall a running step whose session died -- and a fully-done stage
/// advances within the same tick, so a run of already-finished stages
/// collapses in one pass.
export function nextActions(
  orch: Orchestration,
  board: Board,
  tree: GavinTree | undefined,
  worktrees: WorktreeInfo[] | null,
  liveSessionIds: Set<string>,
  /// The tool library, for resolving a tool step's name and checking it
  /// still exists. Null while it is still loading -- which must not read
  /// as "every tool was deleted" (see launchBlocker).
  tools: ToolSummary[] | null = null,
  /// Exit code by session id, for finished tool steps (tools spec T5).
  /// A session absent here has no witnessed outcome.
  exitCodes: Map<string, number> = new Map()
): Action[] {
  const actions: Action[] = [];
  const cards = cardIndex(tree);
  const done = doneColumn(board);
  const doneSlug = done ? slugStatus(done.name) : null;
  const knownWorktrees = worktrees ? new Set(worktrees.map((w) => w.path)) : null;
  const knownTools = tools ? new Set(tools.map((t) => t.id)) : null;
  const toolName = new Map((tools ?? []).map((t) => [t.id, t.name]));
  const runByStep = new Map(orch.stepRuns.map((r) => [r.stepId, r]));

  for (const rail of orch.rails) {
    if (railStateOf(orch, rail.id) !== "running") continue;

    // Rail precondition -- the branch (spec O15). Before any step rule,
    // because the checkout is shared by every step of the rail. The rail
    // is scheduled no further this tick: the executor switches, and the
    // next tick finds the branches matching and proceeds.
    const branchSwitch = branchSwitchFor(rail, orch, tree, worktrees);
    if (branchSwitch) {
      actions.push(branchSwitch);
      continue;
    }

    // Step states simulated forward within this tick, so an advance can
    // cascade without re-entering the function.
    const simulated = new Map<string, StepState>();
    for (const stage of rail.stages) {
      for (const step of stage.steps) simulated.set(step.id, stepStateOf(orch, step.id));
    }

    let stageId = orch.railRuns.find((r) => r.railId === rail.id)?.currentStageId ?? null;
    let stalled = false;

    for (let guard = 0; guard <= rail.stages.length; guard++) {
      const stage = rail.stages.find((s) => s.id === stageId);
      if (!stage) {
        actions.push({ kind: "complete", railId: rail.id });
        break;
      }

      for (const step of [...stage.steps].sort((a, b) => a.position - b.position)) {
        const state = simulated.get(step.id);
        const entry = cards.get(step.cardPath);

        // Rule 1 -- the card reached the done column. Checked before
        // launching, so re-arming a rail is idempotent, and before the
        // dead-session check, so an agent that finished the card and
        // then quit counts as done, not stalled.
        //
        // Skipped entirely for a TOOL step: it has no card, so there is
        // no status to compare and rule 3 owns its completion.
        if (
          !isToolStep(step) &&
          (state === "pending" || state === "running") &&
          doneSlug &&
          entry &&
          slugStatus(entry.plan.status ?? "") === doneSlug
        ) {
          actions.push({ kind: "markDone", stepId: step.id });
          simulated.set(step.id, "done");
          continue;
        }

        // Rule 2 -- launch a pending step, or stall it with a reason.
        if (state === "pending") {
          const reason = launchBlocker(rail, step, entry, knownWorktrees, knownTools);
          if (reason) {
            actions.push({ kind: "stall", stepId: step.id, reason });
            simulated.set(step.id, "stalled");
            stalled = true;
          } else {
            actions.push({ kind: "launch", stepId: step.id });
            simulated.set(step.id, "running");
          }
          continue;
        }

        // Rule 3 -- a running step whose session is gone (spec O6). For
        // a CARD step that is always a stall: rule 1 already had its
        // chance to call it done. For a TOOL step the exit code is the
        // whole verdict (tools spec T5).
        if (state === "running") {
          const sessionId = runByStep.get(step.id)?.sessionId ?? null;
          if (sessionId && !liveSessionIds.has(sessionId)) {
            if (isToolStep(step)) {
              const label = toolName.get(step.toolId as string) ?? "the tool";
              const outcome = toolStepOutcome(exitCodes.get(sessionId), label);
              if (outcome.kind === "markDone") {
                actions.push({ kind: "markDone", stepId: step.id });
                simulated.set(step.id, "done");
                continue;
              }
              actions.push({ kind: "stall", stepId: step.id, reason: outcome.reason });
            } else {
              actions.push({
                kind: "stall",
                stepId: step.id,
                reason: `agent exited before the card reached ${done?.name ?? "the done column"}`,
              });
            }
            simulated.set(step.id, "stalled");
            stalled = true;
          }
        }
      }

      // Rule 5 -- any stall this tick pauses the rail; the executor
      // writes that, and we stop scheduling here.
      if (stalled) break;

      // Rule 4 -- a fully-done stage advances. An empty stage is
      // vacuously done, so it is stepped over rather than hanging.
      if (!stage.steps.every((s) => simulated.get(s.id) === "done")) break;
      const next = rail.stages
        .filter((s) => s.position > stage.position)
        .sort((a, b) => a.position - b.position)[0];
      if (!next) {
        actions.push({ kind: "complete", railId: rail.id });
        break;
      }
      actions.push({ kind: "advance", railId: rail.id, stageId: next.id });
      stageId = next.id;
    }
  }

  return actions;
}

// ---- Plan mutators ---------------------------------------------------------
// Pure and total, like kanban.ts's: every one returns a fresh
// Orchestration. orchestrationState.mutatePlan persists the result
// wholesale, so none of these needs to know about I/O.

function renumber<T extends { position: number }>(items: T[]): T[] {
  return items.map((item, i) => ({ ...item, position: i }));
}

/// Drops run state and conflict notes that name ids no longer in the
/// plan -- the client-side mirror of replace_plan's orphan sweep, so the
/// optimistic view matches what SQLite will hold.
function sweepOrphans(orch: Orchestration): Orchestration {
  const railIds = new Set(orch.rails.map((r) => r.id));
  const stepIds = new Set(
    orch.rails.flatMap((r) => r.stages.flatMap((s) => s.steps.map((t) => t.id)))
  );
  return {
    ...orch,
    railRuns: orch.railRuns.filter((r) => railIds.has(r.railId)),
    stepRuns: orch.stepRuns.filter((r) => stepIds.has(r.stepId)),
    conflictNotes: orch.conflictNotes.filter((n) => n.stepIds.every((id) => stepIds.has(id))),
  };
}

export function addRail(orch: Orchestration, railId: string, name: string): Orchestration {
  const rail: Rail = {
    id: railId,
    name,
    position: orch.rails.length,
    worktreePath: null,
    branch: null,
    pageId: null,
    stages: [],
  };
  return { ...orch, rails: renumber([...orch.rails, rail]) };
}

export function renameRail(orch: Orchestration, railId: string, name: string): Orchestration {
  return { ...orch, rails: orch.rails.map((r) => (r.id === railId ? { ...r, name } : r)) };
}

/// Re-binding affects steps launched from now on; sessions already
/// running keep the cwd they were spawned with (spec §7).
export function bindRail(
  orch: Orchestration,
  railId: string,
  patch: { worktreePath?: string | null; branch?: string | null; pageId?: string | null }
): Orchestration {
  return {
    ...orch,
    rails: orch.rails.map((r) => (r.id === railId ? { ...r, ...patch } : r)),
  };
}

/// The page a rail should get when the human arms it (spec O16): null
/// when its sessions already have a home of their own -- a bound page
/// that still exists -- otherwise the NAME to create one under. A rail
/// whose page was closed gets a fresh one, the same degradation §2.2
/// already grants a stale `pageId`, rather than quietly falling back to
/// the shared Agents page.
///
/// Deduped against the pages the workspace already has, so two rails
/// with the same name -- or a rail sharing a name with a page the human
/// made -- never produce two tabs no one can tell apart. Only the pages'
/// ids and names matter here; the layout tree is the app's business.
export function pageToSpawnForRail(
  rail: Rail,
  pages: { id: string; name: string }[]
): string | null {
  if (pages.some((p) => p.id === rail.pageId)) return null;
  const base = rail.name.trim() || "Rail";
  const taken = new Set(pages.map((p) => p.name));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
  return name;
}

/// Never removes a worktree or a page -- those outlive the plan that
/// referenced them (spec §7).
export function deleteRail(orch: Orchestration, railId: string): Orchestration {
  return sweepOrphans({ ...orch, rails: renumber(orch.rails.filter((r) => r.id !== railId)) });
}

export function addStage(orch: Orchestration, railId: string, stageId: string): Orchestration {
  return {
    ...orch,
    rails: orch.rails.map((r) =>
      r.id === railId
        ? { ...r, stages: renumber([...r.stages, { id: stageId, position: r.stages.length, steps: [] }]) }
        : r
    ),
  };
}

/// A step for a card (`cardPath`) or for a tool (`toolId`). Exactly one
/// of the two, always -- the daemon refuses anything else, so the two
/// factories below are the only shapes the app ever builds.
function cardStep(stepId: string, position: number, cardPath: string): Step {
  return { id: stepId, position, cardPath, toolId: null, toolParams: {} };
}

function toolStep(stepId: string, position: number, toolId: string): Step {
  return { id: stepId, position, cardPath: "", toolId, toolParams: {} };
}

function insertStep(orch: Orchestration, stageId: string, make: (position: number) => Step): Orchestration {
  return {
    ...orch,
    rails: orch.rails.map((r) => ({
      ...r,
      stages: r.stages.map((s) =>
        s.id === stageId ? { ...s, steps: renumber([...s.steps, make(s.steps.length)]) } : s
      ),
    })),
  };
}

export function addStep(
  orch: Orchestration,
  stageId: string,
  stepId: string,
  cardPath: string
): Orchestration {
  return insertStep(orch, stageId, (position) => cardStep(stepId, position, cardPath));
}

/// Join an existing stage with a tool -- the PARALLEL drop, same as
/// addStep is for a card.
export function addToolStep(
  orch: Orchestration,
  stageId: string,
  stepId: string,
  toolId: string
): Orchestration {
  return insertStep(orch, stageId, (position) => toolStep(stepId, position, toolId));
}

/// Replace a tool step's parameter overrides wholesale. The caller has
/// already pruned values equal to the tool's defaults (spec §5.4), so
/// what arrives here is exactly what gets stored.
export function setStepParams(
  orch: Orchestration,
  stepId: string,
  params: Record<string, string>
): Orchestration {
  return {
    ...orch,
    rails: orch.rails.map((r) => ({
      ...r,
      stages: r.stages.map((s) => ({
        ...s,
        steps: s.steps.map((t) => (t.id === stepId ? { ...t, toolParams: { ...params } } : t)),
      })),
    })),
  };
}

/// A stage left with no steps is removed: an empty stage is invisible in
/// the grid and would otherwise be a silent gap the scheduler steps over.
export function removeStep(orch: Orchestration, stepId: string): Orchestration {
  const rails = orch.rails.map((r) => ({
    ...r,
    stages: renumber(
      r.stages
        .map((s) => ({ ...s, steps: renumber(s.steps.filter((t) => t.id !== stepId)) }))
        .filter((s) => s.steps.length > 0)
    ),
  }));
  return sweepOrphans({ ...orch, rails });
}

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
///
/// CONTRACT: `index` counts stage positions in the target rail with the
/// dragged step's own stage already removed if that removal emptied it --
/// which is what the drag glue measures, since the dragged chip is
/// excluded from measurement.
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

/// Place an UNPLACED card into a rail as its own stage at `index` --
/// what dropping a drawer card into a gap between stages means. Unlike
/// moveStepToNewStage there is no step to detach first: the step is new.
export function addCardAsStage(
  orch: Orchestration,
  railId: string,
  index: number,
  stepId: string,
  cardPath: string
): Orchestration {
  return insertAsStage(orch, railId, index, cardStep(stepId, 0, cardPath));
}

/// Place a TOOL into a rail as its own stage at `index` -- the same
/// sequential drop addCardAsStage is for a card.
export function addToolAsStage(
  orch: Orchestration,
  railId: string,
  index: number,
  stepId: string,
  toolId: string
): Orchestration {
  return insertAsStage(orch, railId, index, toolStep(stepId, 0, toolId));
}

function insertAsStage(
  orch: Orchestration,
  railId: string,
  index: number,
  step: Step
): Orchestration {
  if (!orch.rails.some((r) => r.id === railId)) return orch;
  return {
    ...orch,
    rails: orch.rails.map((r) => {
      if (r.id !== railId) return r;
      const stages = [...r.stages];
      const at = Math.max(0, Math.min(index, stages.length));
      stages.splice(at, 0, { id: crypto.randomUUID(), position: at, steps: [step] });
      return { ...r, stages: renumber(stages) };
    }),
  };
}

/// The step with this id, wherever it sits. Every surface that gets a
/// step id from the DOM (a click, a drag, a params popover) has to walk
/// the rails to find what it points at; this is that walk, once.
export function findStep(orch: Orchestration, stepId: string): Step | null {
  for (const rail of orch.rails) {
    for (const stage of rail.stages) {
      for (const step of stage.steps) {
        if (step.id === stepId) return step;
      }
    }
  }
  return null;
}

/// Where a card sits on the rails right now, for the board surfaces that
/// offer "send to rail" -- they need to say where it already is before
/// they can offer to move it.
export interface CardPlacement {
  railId: string;
  stageId: string;
  stepId: string;
  /// 1-based, and paired with `stageCount` so a surface can say "stage 2
  /// of 4" without walking the rail itself.
  stageNumber: number;
  stageCount: number;
}

/// The FIRST step referencing this card, or null. An agent can write the
/// same card onto two steps -- `duplicate-card` flags that separately, and
/// this deliberately does not repeat the complaint: the board surfaces
/// only need somewhere to send the human.
export function findCardPlacement(orch: Orchestration, cardPath: string): CardPlacement | null {
  for (const rail of orch.rails) {
    const stages = [...rail.stages].sort((a, b) => a.position - b.position);
    for (const [i, stage] of stages.entries()) {
      for (const step of stage.steps) {
        if (isToolStep(step) || step.cardPath !== cardPath) continue;
        return {
          railId: rail.id,
          stageId: stage.id,
          stepId: step.id,
          stageNumber: i + 1,
          stageCount: stages.length,
        };
      }
    }
  }
  return null;
}

/// Put a card on a rail from OUTSIDE the tab -- the board's composer, a
/// card's context menu, its detail modal. The card lands as the rail's
/// own trailing stage, the sequential default the drawer's click already
/// uses; parallel stays the deliberate act of dropping onto a stage.
///
/// A card already on ANOTHER rail MOVES, keeping its step id and so its
/// run state -- sending a card somewhere is never a reason to forget that
/// it already ran. A card already on THIS rail is left exactly alone
/// rather than duplicated, and an unknown rail is a no-op.
export function sendCardToRail(
  orch: Orchestration,
  railId: string,
  cardPath: string,
  stepId: string
): Orchestration {
  const rail = orch.rails.find((r) => r.id === railId);
  if (!rail) return orch;
  const placement = findCardPlacement(orch, cardPath);
  if (placement?.railId === railId) return orch;
  if (placement) return moveStepToNewStage(orch, placement.stepId, railId, rail.stages.length);
  return addCardAsStage(orch, railId, rail.stages.length, stepId, cardPath);
}

/// Split one stage of N steps into N consecutive single-step stages, in
/// step order -- the "Make sequential" repair for a same-worktree
/// conflict of scope "stage".
///
/// The FIRST slice keeps the original stage id on purpose: a running
/// rail's `currentStageId` may point at this stage, and minting a fresh
/// id for every slice would strand it mid-run. Step ids are untouched
/// throughout, so run state and conflict notes ride along.
export function splitStageIntoSequence(orch: Orchestration, stageId: string): Orchestration {
  return {
    ...orch,
    rails: orch.rails.map((r) => {
      if (!r.stages.some((s) => s.id === stageId)) return r;
      const stages = r.stages.flatMap((s) => {
        if (s.id !== stageId || s.steps.length < 2) return [s];
        return [...s.steps]
          .sort((a, b) => a.position - b.position)
          .map((step, i) => ({
            id: i === 0 ? s.id : crypto.randomUUID(),
            position: 0, // renumber() fixes these up below
            steps: [{ ...step, position: 0 }],
          }));
      });
      return { ...r, stages: renumber(stages) };
    }),
  };
}

/// One status bucket of unplaced cards, for the drawer.
export interface UnplacedGroup {
  /// Display label -- the board column's own spelling, or the card's raw
  /// status for a status the board has no column for.
  status: string;
  slug: string;
  cards: CardEntry[];
  /// The board's done column. The drawer starts these collapsed: work
  /// that is finished but never placed on a rail is the least
  /// interesting thing in the list.
  isDone: boolean;
}

/// Groups unplaced cards the way the board groups placed ones, so the
/// drawer reads in the same order as the Kanban tab: known columns by
/// `position`, then one group per unrecognized status. Mirrors
/// mergePlanCards' rules deliberately -- a card with no status lands in
/// the first column, and two spellings of one status share a group.
export function groupUnplacedByStatus(cards: CardEntry[], board: Board): UnplacedGroup[] {
  const columns = [...board.columns].sort((a, b) => a.position - b.position);
  const done = doneColumn(board);

  const known = new Map<string, UnplacedGroup>();
  for (const c of columns) {
    const slug = slugStatus(c.name);
    if (!slug || known.has(slug)) continue;
    known.set(slug, { status: c.name, slug, cards: [], isDone: c.id === done?.id });
  }

  const NO_STATUS = "(no status)";
  const extra = new Map<string, UnplacedGroup>();
  for (const entry of cards) {
    const slug = entry.plan.status ? slugStatus(entry.plan.status) : "";
    if (!slug) {
      // No status: the first column, exactly as the board does it.
      const first = columns.length > 0 ? known.get(slugStatus(columns[0].name)) : undefined;
      if (first) {
        first.cards.push(entry);
      } else {
        const group = extra.get("") ?? { status: NO_STATUS, slug: "", cards: [], isDone: false };
        group.cards.push(entry);
        extra.set("", group);
      }
      continue;
    }
    const target = known.get(slug);
    if (target) {
      target.cards.push(entry);
      continue;
    }
    // Keyed by slug so "Blocked" and "blocked" share a group; labelled
    // with the first raw spelling seen.
    const group = extra.get(slug) ?? {
      status: entry.plan.status ?? slug,
      slug,
      cards: [],
      isDone: false,
    };
    group.cards.push(entry);
    extra.set(slug, group);
  }

  return [...known.values(), ...extra.values()].filter((g) => g.cards.length > 0);
}

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
      /// The stage to split, for the box's "Make sequential" repair.
      /// Null for scope "rails", which no single stage can fix.
      stageId: string | null;
      severity: ConflictSeverity;
      stepIds: string[];
      worktreePath: string;
    }
  | { kind: "duplicate-card"; severity: "potential"; stepIds: string[]; cardPath: string }
  | { kind: "worktree-missing"; severity: "potential"; railId: string; worktreePath: string }
  /// worktree-missing's twin for spec O15: the rail names a branch this
  /// repo no longer has, so its every switch would fail.
  | { kind: "branch-missing"; severity: "potential"; railId: string; branch: string }
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
  "branch-missing",
  "rail-unbound",
  "declared",
];

/// The three RAIL-LEVEL kinds: their cause is the binding, not a step,
/// so they carry no step ids and badge the rail header instead of a chip.
function isRailLevel(
  c: Conflict
): c is Extract<Conflict, { kind: "worktree-missing" | "branch-missing" | "rail-unbound" }> {
  return c.kind === "worktree-missing" || c.kind === "branch-missing" || c.kind === "rail-unbound";
}

export function conflictStepIds(c: Conflict): string[] {
  return isRailLevel(c) ? [] : c.stepIds;
}

export function conflictRailId(c: Conflict): string | null {
  return isRailLevel(c) ? c.railId : null;
}

/// WHICH WORKING TREE a rail's steps edit -- the isolation question,
/// and the only thing that makes two steps conflict (spec O13).
///
/// Deliberately NOT effectiveWorktree, which answers where an agent's
/// shell starts. An unbound rail launches each step in its card's
/// contextFolder, but that folder is a SUBDIRECTORY of the root
/// checkout, not a checkout of its own -- keying conflicts on it would
/// report isolation that does not exist, and two unbound rails editing
/// the same repo would look safe.
export function conflictCheckout(rail: Rail, tree: GavinTree | undefined): string | null {
  return rail.worktreePath ?? (tree && !tree.rootMissing ? tree.rootPath : null);
}

interface PlacedStep {
  stepId: string;
  railId: string;
  stageId: string;
  cardPath: string;
  /// Null for a card step. A tool step is EXCLUDED from duplicate-card
  /// (two "Push" steps in one rail are the normal case) but takes part
  /// in same-worktree exactly like a card step -- a bash tool writing to
  /// the checkout is precisely the hazard that rule exists for.
  toolId: string | null;
  checkout: string | null;
  state: StepState;
}

function placedSteps(orch: Orchestration, tree: GavinTree | undefined): PlacedStep[] {
  const out: PlacedStep[] = [];
  for (const rail of orch.rails) {
    const checkout = conflictCheckout(rail, tree);
    for (const stage of rail.stages) {
      for (const step of stage.steps) {
        out.push({
          stepId: step.id,
          railId: rail.id,
          stageId: stage.id,
          cardPath: step.cardPath,
          toolId: step.toolId ?? null,
          checkout,
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

/// `tree` supplies the root checkout for unbound rails; `worktrees` and
/// `branches` are null while the refs snapshot is still loading, which
/// must suppress `worktree-missing` and `branch-missing` rather than read
/// as "gone".
export function detectConflicts(
  orch: Orchestration,
  tree: GavinTree | undefined,
  worktrees: WorktreeInfo[] | null,
  branches: string[] | null = null
): Conflict[] {
  const steps = placedSteps(orch, tree).filter((s) => s.state !== "done");
  const conflicts: Conflict[] = [];

  // 1. A parallel stage IS a same-worktree conflict by construction: its
  // steps share the rail's checkout. That is intended, and saying so out
  // loud beats pretending it is safe (spec §5).
  const byStage = new Map<string, PlacedStep[]>();
  for (const s of steps) {
    if (!s.checkout) continue;
    const group = byStage.get(s.stageId) ?? [];
    group.push(s);
    byStage.set(s.stageId, group);
  }
  for (const [stageId, group] of byStage) {
    if (group.length < 2) continue;
    conflicts.push({
      kind: "same-worktree",
      scope: "stage",
      stageId,
      severity: severityOf(group),
      stepIds: group.map((s) => s.stepId),
      worktreePath: group[0].checkout as string,
    });
  }

  // 2. Across rails there is NO ordering guarantee, so every not-done
  // step in a shared checkout is a potential collision with every other.
  // Reported once per checkout rather than as a pair explosion. Rails on
  // DIFFERENT checkouts never land in the same group, which is the whole
  // of spec O13: isolation buys silence.
  const byCheckout = new Map<string, PlacedStep[]>();
  for (const s of steps) {
    if (!s.checkout) continue;
    const group = byCheckout.get(s.checkout) ?? [];
    group.push(s);
    byCheckout.set(s.checkout, group);
  }
  for (const [worktreePath, group] of byCheckout) {
    if (new Set(group.map((s) => s.railId)).size < 2) continue;
    conflicts.push({
      kind: "same-worktree",
      scope: "rails",
      stageId: null,
      severity: severityOf(group),
      stepIds: group.map((s) => s.stepId),
      worktreePath,
    });
  }

  // 3. One card on two steps would be run twice. TOOL steps are exempt
  // (tools spec T6): a rail that commits, tests and commits again is
  // doing exactly what it should.
  const byCard = new Map<string, PlacedStep[]>();
  for (const s of steps) {
    if (s.toolId) continue;
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
  const knownBranches = branches ? new Set(branches) : null;
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
    // Independent of the worktree binding, and deliberately not an
    // `else`: a rail can name a live worktree and a dead branch. A
    // branch says nothing about cwd, so it never clears `rail-unbound`.
    if (rail.branch && knownBranches && !knownBranches.has(rail.branch)) {
      conflicts.push({
        kind: "branch-missing",
        severity: "potential",
        railId: rail.id,
        branch: rail.branch,
      });
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

/// Everything that concerns ONE rail: its rail-level conflicts plus every
/// step-level one naming a step it holds. Deliberately wider than
/// numbersForRail, which answers the header BADGE and so stays rail-level
/// -- a step's badge sits on the step. This answers "what does an agent
/// reorganizing this rail need to know", and a same-worktree pair with
/// another rail is exactly that.
export function conflictsForRail(numbered: NumberedConflict[], rail: Rail): NumberedConflict[] {
  const stepIds = new Set(rail.stages.flatMap((s) => s.steps.map((t) => t.id)));
  return numbered.filter(
    (x) =>
      conflictRailId(x.conflict) === rail.id ||
      conflictStepIds(x.conflict).some((id) => stepIds.has(id))
  );
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
  orch: Orchestration,
  /// Tool names, for naming a tool step. Absent falls back to the tool
  /// id -- a conflict about a deleted tool must still be describable,
  /// exactly as one about a missing card falls back to its file name.
  tools: ToolSummary[] = []
): string {
  const toolName = new Map(tools.map((t) => [t.id, t.name]));
  const titleOfStep = (stepId: string): string => {
    for (const rail of orch.rails) {
      for (const stage of rail.stages) {
        for (const step of stage.steps) {
          if (step.id !== stepId) continue;
          if (step.toolId) return toolName.get(step.toolId) ?? step.toolId;
          return cards.get(step.cardPath)?.plan.title ?? (step.cardPath.split("/").pop() ?? step.cardPath);
        }
      }
    }
    return stepId;
  };
  const nameOfRail = (railId: string): string =>
    orch.rails.find((r) => r.id === railId)?.name ?? railId;
  const list = (ids: string[]): string => ids.map((id) => `“${titleOfStep(id)}”`).join(", ");
  const railsFor = (stepIds: string[]): Rail[] =>
    orch.rails.filter((rail) =>
      rail.stages.some((stage) => stage.steps.some((step) => stepIds.includes(step.id)))
    );

  switch (c.kind) {
    case "same-worktree": {
      if (c.scope === "stage") {
        return `${list(c.stepIds)} run in parallel in one checkout (${c.worktreePath}) — run them one after another, or move one to a rail with its own worktree`;
      }
      const rails = railsFor(c.stepIds);
      // Deduped by NAME: two rails sharing one is confusing enough
      // without the line saying it twice.
      const names = [...new Set(rails.map((r) => r.name))].map((n) => `“${n}”`).join(" and ");
      // Two rails in one checkout are already a conflict (spec O13);
      // wanting DIFFERENT branches there is the same conflict, worse, so
      // it sharpens this line rather than opening a second row about the
      // same pair. One checkout can only be on one branch.
      const wanted = [...new Set(rails.map((r) => r.branch).filter((b): b is string => Boolean(b)))];
      if (wanted.length >= 2) {
        return `rails ${names} share ${c.worktreePath} but want different branches there (${wanted.join(" vs ")}) — a checkout can only be on one: ${list(c.stepIds)}`;
      }
      return `rails ${names} share ${c.worktreePath}: ${list(c.stepIds)}`;
    }
    case "duplicate-card":
      return `the same card is on two steps: ${list(c.stepIds)}`;
    case "worktree-missing":
      return `rail “${nameOfRail(c.railId)}” points at ${c.worktreePath}, which is not a worktree of this repo`;
    case "branch-missing":
      return `rail “${nameOfRail(c.railId)}” is bound to branch ${c.branch}, which this repo does not have`;
    case "rail-unbound":
      return `rail “${nameOfRail(c.railId)}” has steps but no worktree — they will run in each card's own folder`;
    case "declared":
      return c.note;
  }
}
