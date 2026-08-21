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
  /// (spec O2); title, prompt and status all stay in the file.
  cardPath: string;
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
  /// Workspace page its sessions land on; null uses the Agents-page
  /// posture handleAgentSessionSpawned already applies.
  pageId: string | null;
  stages: Stage[];
}

export interface ConflictNote {
  id: string;
  stepIds: string[];
  note: string;
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
  | { kind: "complete"; railId: string };

/// Why a pending step cannot be launched right now, or null.
/// `knownWorktrees` is null when the worktree list has not loaded yet --
/// unknown must never look like "gone", or a cold start would stall
/// every bound rail.
function launchBlocker(
  rail: Rail,
  entry: CardEntry | undefined,
  knownWorktrees: Set<string> | null
): string | null {
  if (!entry) return "card file is missing";
  if (entry.plan.kind === "note") return "notes are not runnable";
  if (rail.worktreePath && knownWorktrees && !knownWorktrees.has(rail.worktreePath)) {
    return `worktree ${rail.worktreePath} is gone`;
  }
  return null;
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
  liveSessionIds: Set<string>
): Action[] {
  const actions: Action[] = [];
  const cards = cardIndex(tree);
  const done = doneColumn(board);
  const doneSlug = done ? slugStatus(done.name) : null;
  const knownWorktrees = worktrees ? new Set(worktrees.map((w) => w.path)) : null;
  const runByStep = new Map(orch.stepRuns.map((r) => [r.stepId, r]));

  for (const rail of orch.rails) {
    if (railStateOf(orch, rail.id) !== "running") continue;

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
        if (
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
          const reason = launchBlocker(rail, entry, knownWorktrees);
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

        // Rule 3 -- a running step whose session is gone (spec O6).
        if (state === "running") {
          const sessionId = runByStep.get(step.id)?.sessionId ?? null;
          if (sessionId && !liveSessionIds.has(sessionId)) {
            actions.push({
              kind: "stall",
              stepId: step.id,
              reason: `agent exited before the card reached ${done?.name ?? "the done column"}`,
            });
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
  patch: { worktreePath?: string | null; pageId?: string | null }
): Orchestration {
  return {
    ...orch,
    rails: orch.rails.map((r) => (r.id === railId ? { ...r, ...patch } : r)),
  };
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

export function addStep(
  orch: Orchestration,
  stageId: string,
  stepId: string,
  cardPath: string
): Orchestration {
  return {
    ...orch,
    rails: orch.rails.map((r) => ({
      ...r,
      stages: r.stages.map((s) =>
        s.id === stageId
          ? { ...s, steps: renumber([...s.steps, { id: stepId, position: s.steps.length, cardPath }]) }
          : s
      ),
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

/// `tree` supplies the root checkout for unbound rails; `worktrees` is
/// null while the refs snapshot is still loading, which must suppress
/// `worktree-missing` rather than read as "gone".
export function detectConflicts(
  orch: Orchestration,
  tree: GavinTree | undefined,
  worktrees: WorktreeInfo[] | null
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
        return `${list(c.stepIds)} run in parallel in one checkout (${c.worktreePath}) — run them one after another, or move one to a rail with its own worktree`;
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
