// The orchestration plan and its scheduler, as pure data and pure
// functions (orchestration spec O10). No Svelte, no Tauri, no I/O --
// orchestrationState.ts owns every side effect. TS mirrors of
// crates/protocol's orchestration shapes (camelCase on the wire).

import type { Board, Column } from "./kanban";
import type { GavinTree, PlanFileInfo } from "./gavin";
import type { WorktreeInfo } from "./git";
import type { SessionStatus } from "./notifications";
import { isArchivedCard, planKey, slugStatus } from "./planBoard";

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

/// How a stage's steps run (grouping spec G1). Absent means `parallel`,
/// because every stage written before groups existed ran that way -- read
/// it through stageMode(), never directly.
export type StageMode = "sequence" | "parallel";

/// Stages run one after another. A stage holding two or more steps is a
/// GROUP, and its `mode` says whether those steps run at once in the
/// rail's checkout or one at a time in position order.
export interface Stage {
  id: string;
  position: number;
  mode?: StageMode;
  /// The group's name, shown in its header. Null/absent renders as the
  /// positional label the rail already draws.
  name?: string | null;
  steps: Step[];
}

/// The mode a stage actually runs in, tolerating a field that is absent
/// (written before groups existed) or unrecognised (a hand edit, a newer
/// peer). Both degrade to the discipline every existing plan already ran
/// under -- the same shape stepParams uses for a missing toolParams.
export function stageMode(stage: Stage): StageMode {
  return stage.mode === "sequence" ? "sequence" : "parallel";
}

/// A stage the human sees as a GROUP: one with something to order. A
/// single-step stage runs identically in either mode, so it draws bare
/// and its mode is not worth showing.
export function isGroup(stage: Stage): boolean {
  return stage.steps.length > 1;
}

export interface Rail {
  id: string;
  name: string;
  position: number;
  /// cwd for this rail's steps. Null falls back to each card's own
  /// contextFolder (see effectiveWorktree) and raises a `rail-unbound`
  /// conflict in SP2.
  worktreePath: string | null;
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

/// The little this module needs to know about a tool: that it exists,
/// what to call it in a stall reason or a conflict line, and how it
/// finishes. The body and the params stay orchestrationTools.ts's
/// business, which keeps the scheduler's inputs small.
///
/// `kind` is here because it changes the COMPLETION RULE, not because
/// the scheduler runs anything: an agent tool's session never exits (see
/// agentTurnEnded), so T5's exit code can never be its verdict.
export interface ToolSummary {
  id: string;
  name: string;
  kind: "agent" | "command" | "script";
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

/// The PLAN cards of a card index, keyed the way a nested task's
/// `parent:` resolves: (contextFolder, fileName). Only plans, because
/// only a plan card can be a parent -- exactly the index
/// `mergePlanCards` builds for the board.
export function planIndex(cards: Map<string, CardEntry>): Map<string, CardEntry> {
  const index = new Map<string, CardEntry>();
  for (const entry of cards.values()) {
    if (entry.plan.kind === "plan") index.set(planKey(entry.contextFolder, entry.plan.fileName), entry);
  }
  return index;
}

/// THE STATUS THE BOARD SHOWS THIS CARD IN, which is not always the
/// card's own. A task with a `parent:` and no `status:` of its own is
/// NESTED: it is drawn inside its parent's card, so the column the human
/// sees it in is the parent's, and on disk it travels into `plans/done/`
/// with the parent rather than by any status of its own.
///
/// The scheduler used to read `plan.status` directly, so every nested
/// task under a Done plan looked unfinished: pressing Start re-ran
/// finished work, and the launch then wrote `In Progress` onto the card,
/// which un-nested it and moved it back out of `done/`.
///
/// One hop, deliberately: a card that nests is a task, and a parent is
/// always a plan, so no chain can form. The same conditions
/// `mergePlanCards` nests on, resolved on the same `planKey` -- one
/// spelling of the link, not two that can drift.
export function effectiveStatus(entry: CardEntry, plans: Map<string, CardEntry>): string | null {
  const { plan, contextFolder } = entry;
  const own = plan.status ?? null;
  if (own !== null || plan.kind !== "task" || !plan.parent || plan.parent === plan.fileName) {
    return own;
  }
  return plans.get(planKey(contextFolder, plan.parent))?.plan.status ?? null;
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

/// The stage a RUNNING rail is on right now, or null. Distinct from
/// `firstUnfinishedStageId`, which asks where a rail WOULD start: this
/// asks where it already is, and only a rail actually advancing has an
/// answer.
export function runningStageId(orch: Orchestration, railId: string): string | null {
  if (railStateOf(orch, railId) !== "running") return null;
  return orch.railRuns.find((r) => r.railId === railId)?.currentStageId ?? null;
}

/// True when this stage is the one its rail is currently running. A step
/// that lands here is not queued behind anything -- the beat it belongs
/// to is already in flight, so it is late rather than next, and the
/// caller starts it at once rather than leaving it to whatever ticks
/// next. Nothing here spawns on an unarmed rail (O1): a rail that is
/// idle or paused has no running stage and this is false for every
/// stage it owns.
export function isStageRunning(orch: Orchestration, stageId: string): boolean {
  const rail = orch.rails.find((r) => r.stages.some((s) => s.id === stageId));
  return rail ? runningStageId(orch, rail.id) === stageId : false;
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

/// Whether a step is a finished AGENT tool step -- the one completion
/// signal that is not an exit code.
///
/// An interactive agent never exits. It finishes its turn and sits at
/// its prompt forever, which is the whole reason buildHeadlessCommand
/// exists for the runs that must end (cardRun.ts). So T5's "done when
/// its session exits 0" can never fire for an `agent` tool, and a rail
/// carrying one sat `running` for good: the step could not complete, and
/// the daemon refuses every plan write that drops a `running` step, so
/// the rail was wedged shut until the human deleted the session and the
/// step by hand.
///
/// The signal instead is the daemon's own status for that session, which
/// is exactly the one behind the "<label> finished" notification:
///
/// - `idle` -- the turn ended. Done.
/// - `working` -- still going.
/// - `waiting_for_input` -- the agent is ASKING the human something.
///   Not finished: pty.rs pins TERM_PROGRAM so an agent that wants
///   attention says so rather than merely going quiet, and the daemon
///   refuses to let a quiet period downgrade this to idle. Advancing the
///   rail past a question would answer it by walking away.
/// - no status at all -- not finished either. The daemon registers every
///   new session `idle`, so an absent status is "nothing reported yet",
///   and believing it would mark a step done the instant it launched.
///
/// Only `agent` tools. A `command` tool's verdict is its exit code and
/// nothing else (T5): a quiet `npm run dev` is a server that started,
/// not a step that finished. And never a CARD step, whose completion is
/// its card reaching the done column (rule 1) -- an agent that stopped
/// talking without finishing the card left the work undone, which is
/// what rule 1 is there to catch.
function agentTurnEnded(
  step: Step,
  sessionId: string | null,
  toolKinds: Map<string, ToolSummary["kind"]>,
  sessionStatuses: Map<string, SessionStatus>
): boolean {
  if (!sessionId || !isToolStep(step)) return false;
  // An unknown tool cannot be known to be an agent -- a deleted one, or
  // a library still loading. The step keeps running until its session
  // ends rather than completing on a guess.
  if (toolKinds.get(step.toolId as string) !== "agent") return false;
  return sessionStatuses.get(sessionId) === "idle";
}

/// The verdict on a step whose session is over. One spelling, because
/// two paths need it: rule 3 inside a running rail, and the
/// reconciliation pass over a rail that is not running.
///
/// A card that reached the done column outranks the exit -- an agent
/// that finished the card and then quit counts as done, not stalled.
function deadSessionAction(
  step: Step,
  cardStatus: string | null,
  doneSlug: string | null,
  doneName: string,
  toolLabel: string,
  exitCode: number | undefined
): Action {
  if (isToolStep(step)) {
    const outcome = toolStepOutcome(exitCode, toolLabel);
    return outcome.kind === "markDone"
      ? { kind: "markDone", stepId: step.id }
      : { kind: "stall", stepId: step.id, reason: outcome.reason };
  }
  if (doneSlug && cardStatus !== null && slugStatus(cardStatus) === doneSlug) {
    return { kind: "markDone", stepId: step.id };
  }
  return {
    kind: "stall",
    stepId: step.id,
    reason: `agent exited before the card reached ${doneName}`,
  };
}

/// What a RUNNING step is waiting on, when it is waiting on a HUMAN
/// rather than on itself.
///
/// `running` alone says nothing about why. Every other surface in the
/// app already reads a session's status -- the tab dot (Pane.svelte),
/// the sidebar badge, the board card, the OS notification -- and the
/// rail was the one place in gavin that showed a live agent with
/// nothing to say about it. A card step whose agent answered and sat
/// back down at its prompt without setting the card's status looked
/// exactly like one grinding away.
///
/// - `asking` -- the agent has a question on screen. The rail is right
///   to wait; nobody has told the human it is their turn.
/// - `turn-ended` -- the agent stopped talking and the card never
///   reached the done column. The work is not finished and nothing is
///   going to finish it.
export type StepAttention = "asking" | "turn-ended";

/// `asking` outranks `turn-ended` when a rail rolls its steps up: one is
/// a question with a human on the other end of it, the other is work
/// that quietly stopped.
const ATTENTION_RANK: Record<StepAttention, number> = { asking: 2, "turn-ended": 1 };

/// Every running step that wants a human, by step id. Derived, never
/// stored: this is a live read of the same inputs the scheduler takes,
/// so a mark clears itself the instant the agent's status moves, and
/// nothing about it is ever written to a plan file.
///
/// Deliberately NOT an Action. Stalling would pause the rail and persist
/// a verdict on a signal that is only two quiet seconds for an agent
/// emitting no OSC 133 (HEURISTIC_QUIET_PERIOD in the daemon); this
/// says the same thing and costs nothing if it is wrong.
///
/// `tools` is null while the library is still loading, on the same
/// principle as launchBlocker's: an unloaded library must not read as
/// "every tool was deleted", and without a kind an idle tool step cannot
/// be told from an agent's about-to-complete turn.
export function stepAttentions(
  orch: Orchestration,
  board: Board,
  tree: GavinTree | undefined,
  tools: ToolSummary[] | null,
  sessionStatuses: Map<string, SessionStatus>
): Map<string, StepAttention> {
  const marks = new Map<string, StepAttention>();
  // Before the tree walk. This runs on every layoutState emission -- a
  // status change, a cwd report, a git poll -- for every workspace at
  // once, and a workspace with no rails has nothing to say however many
  // cards it holds.
  if (orch.rails.length === 0) return marks;
  const cards = cardIndex(tree);
  const plans = planIndex(cards);
  const done = doneColumn(board);
  const doneSlug = done ? slugStatus(done.name) : null;
  const toolKind = new Map((tools ?? []).map((t) => [t.id, t.kind]));
  const runByStep = new Map(orch.stepRuns.map((r) => [r.stepId, r]));

  for (const rail of orch.rails) {
    // Every rail, not only a running one. The mark describes the STEP:
    // a paused rail holding a step stuck `running` is precisely the
    // wedge worth seeing, since the daemon refuses every plan write
    // that drops a running step and that is what makes the rail
    // uneditable and undeletable.
    for (const stage of rail.stages) {
      for (const step of stage.steps) {
        if (stepStateOf(orch, step.id) !== "running") continue;
        const sessionId = runByStep.get(step.id)?.sessionId ?? null;
        if (!sessionId) continue;
        const status = sessionStatuses.get(sessionId);
        // No status at all is "nothing reported yet", not "finished":
        // the daemon registers every new session idle, so believing an
        // absent status would mark a step the instant it launched.
        if (status === "waiting_for_input") {
          marks.set(step.id, "asking");
          continue;
        }
        if (status !== "idle") continue;
        // An idle TOOL step is never this. An `agent` tool's step is
        // marked done by agentTurnEnded on this very tick -- from the
        // running-rail rule and from the reconciliation pass both -- so
        // a mark would only flicker; a `command` tool's verdict is its
        // exit code and nothing else (T5), because a quiet `npm run dev`
        // is a server that started rather than an agent that stopped.
        if (isToolStep(step)) continue;
        // The card IS finished -- saying its turn ended short of Done
        // would be false, and rule 1 marks the step done this same tick.
        // Read through effectiveStatus, so a nested task under a Done
        // plan counts as done rather than as abandoned work.
        const entry = cards.get(step.cardPath);
        const cardStatus = entry ? effectiveStatus(entry, plans) : null;
        if (doneSlug && cardStatus !== null && slugStatus(cardStatus) === doneSlug) continue;
        marks.set(step.id, "turn-ended");
      }
    }
  }
  return marks;
}

/// One spelling of what a mark MEANS, so the chip's tooltip, the rail
/// header, the sidebar recap and the OS notification cannot drift into
/// describing the same state three different ways.
export function attentionTip(attention: StepAttention, doneName: string): string {
  return attention === "asking"
    ? "the agent is asking you something"
    : `the agent's turn ended but the card is not in ${doneName}`;
}

/// The most urgent mark among a rail's steps, or null. What the rail
/// header, the sidebar recap and the hub tab all roll up.
export function railAttention(
  rail: Rail,
  marks: Map<string, StepAttention>
): StepAttention | null {
  let best: StepAttention | null = null;
  for (const stage of rail.stages) {
    for (const step of stage.steps) {
      const mark = marks.get(step.id);
      if (mark && (!best || ATTENTION_RANK[mark] > ATTENTION_RANK[best])) best = mark;
    }
  }
  return best;
}

/// The rail ids with any marked step. The sidebar recap counts each rail
/// once, so it needs the set rather than the tally.
export function railsWantingAttention(
  orch: Orchestration,
  marks: Map<string, StepAttention>
): Set<string> {
  const ids = new Set<string>();
  for (const rail of orch.rails) {
    if (railAttention(rail, marks)) ids.add(rail.id);
  }
  return ids;
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
  exitCodes: Map<string, number> = new Map(),
  /// The daemon's live status per session, for an AGENT tool step --
  /// whose session never exits, so no exit code above will ever describe
  /// it (see agentTurnEnded).
  sessionStatuses: Map<string, SessionStatus> = new Map()
): Action[] {
  const actions: Action[] = [];
  const cards = cardIndex(tree);
  const plans = planIndex(cards);
  /// What the BOARD says about this step's card -- a nested task reads
  /// its parent's status (see effectiveStatus). Null for a step whose
  /// card the tree has no entry for, which is never done.
  const statusOf = (entry: CardEntry | undefined): string | null =>
    entry ? effectiveStatus(entry, plans) : null;
  const done = doneColumn(board);
  const doneSlug = done ? slugStatus(done.name) : null;
  const knownWorktrees = worktrees ? new Set(worktrees.map((w) => w.path)) : null;
  const knownTools = tools ? new Set(tools.map((t) => t.id)) : null;
  const toolName = new Map((tools ?? []).map((t) => [t.id, t.name]));
  const toolKind = new Map((tools ?? []).map((t) => [t.id, t.kind]));
  const runByStep = new Map(orch.stepRuns.map((r) => [r.stepId, r]));

  for (const rail of orch.rails) {
    if (railStateOf(orch, rail.id) !== "running") {
      // Reconciliation is about what the SESSIONS say, not about whether
      // the rail is advancing (spec §4.4). A step left `running` on an
      // idle or paused rail -- the app quit mid-run, or a stall paused
      // the rail around it -- gets no tick that would ever correct it,
      // and the daemon refuses every plan write that drops a `running`
      // step: the stale row wedges the rail shut, uneditable and
      // undeletable. So write the truth about dead sessions here. Only
      // that: nothing is launched and no stage advances, because the
      // rail is not running.
      for (const stage of rail.stages) {
        for (const step of stage.steps) {
          if (stepStateOf(orch, step.id) !== "running") continue;
          const sessionId = runByStep.get(step.id)?.sessionId ?? null;
          if (sessionId && liveSessionIds.has(sessionId)) {
            // A LIVE session is normally nothing to write about here --
            // except an agent tool's, which is live precisely because it
            // finished (agentTurnEnded). That is the same stale
            // `running` row this pass exists for, and leaving it would
            // keep the rail uneditable and undeletable.
            if (agentTurnEnded(step, sessionId, toolKind, sessionStatuses)) {
              actions.push({ kind: "markDone", stepId: step.id });
            }
            continue;
          }
          actions.push(
            deadSessionAction(
              step,
              statusOf(cards.get(step.cardPath)),
              doneSlug,
              done?.name ?? "the done column",
              toolName.get(step.toolId as string) ?? "the tool",
              sessionId ? exitCodes.get(sessionId) : undefined
            )
          );
        }
      }
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

      // A `sequence` stage runs ONE member at a time, in position order
      // (grouping spec G4). The guard at the bottom of this loop is the
      // whole of that rule: every existing rule is untouched, and a
      // member that completes on this pass lets the next one launch in
      // the same tick -- the cascade rule 4 already gives stages. Every
      // rule inside `stepBody` below must end with `break stepBody`, never
      // a bare `continue` -- `continue` would skip the guard entirely and
      // let a sequence stage launch more than one member per tick. Nothing
      // here is mechanical about that; there is no linter in this repo.
      const sequential = stageMode(stage) === "sequence";
      for (const step of [...stage.steps].sort((a, b) => a.position - b.position)) {
        stepBody: {
        const state = simulated.get(step.id);
        const entry = cards.get(step.cardPath);

        // Rule 1 -- the card reached the done column. Checked before
        // launching, so re-arming a rail is idempotent, and before the
        // dead-session check, so an agent that finished the card and
        // then quit counts as done, not stalled.
        //
        // Skipped entirely for a TOOL step: it has no card, so there is
        // no status to compare and rule 3 owns its completion.
        //
        // The status is the one the BOARD shows the card in, so a nested
        // task under a Done plan is skipped here rather than re-run.
        //
        // `!== "done"` covers a STALLED step too: a card someone finished
        // by hand while its step sat failed is done, not something rule 2
        // should then retry.
        const cardStatus = statusOf(entry);
        if (
          !isToolStep(step) &&
          state !== "done" &&
          doneSlug &&
          cardStatus !== null &&
          slugStatus(cardStatus) === doneSlug
        ) {
          actions.push({ kind: "markDone", stepId: step.id });
          simulated.set(step.id, "done");
          break stepBody;
        }

        // Rule 2 -- launch a pending step, or stall it with a reason.
        //
        // A STALLED step is retried here, when the run REACHES it: a
        // failed step used to be invisible to every rule, so a rail armed
        // on its stage produced no actions at all and sat there looking
        // busy, with the per-step Retry button the only way past it.
        // Nothing is replayed -- the blocker is re-derived, so the step
        // either goes this time or stalls again on its own merits, and a
        // fresh stall re-pauses the rail (rule 5). That is what keeps
        // this one attempt per press of Play rather than a spin.
        if (state === "pending" || state === "stalled") {
          const reason = launchBlocker(rail, step, entry, knownWorktrees, knownTools);
          if (reason) {
            actions.push({ kind: "stall", stepId: step.id, reason });
            simulated.set(step.id, "stalled");
            stalled = true;
          } else {
            actions.push({ kind: "launch", stepId: step.id });
            simulated.set(step.id, "running");
          }
          break stepBody;
        }

        // Rule 3 -- a running step whose session is gone (spec O6). For
        // a CARD step that is always a stall: rule 1 already had its
        // chance to call it done. For a TOOL step the exit code is the
        // whole verdict (tools spec T5).
        if (state === "running") {
          const sessionId = runByStep.get(step.id)?.sessionId ?? null;
          // Rule 3b -- an agent tool step whose session is still LIVE but
          // whose turn is over. Checked first: its session will never
          // die, so the dead-session branch below can never speak for it.
          if (agentTurnEnded(step, sessionId, toolKind, sessionStatuses)) {
            actions.push({ kind: "markDone", stepId: step.id });
            simulated.set(step.id, "done");
            break stepBody;
          }
          if (sessionId && !liveSessionIds.has(sessionId)) {
            const action = deadSessionAction(
              step,
              cardStatus,
              doneSlug,
              done?.name ?? "the done column",
              toolName.get(step.toolId as string) ?? "the tool",
              exitCodes.get(sessionId)
            );
            actions.push(action);
            if (action.kind === "markDone") {
              simulated.set(step.id, "done");
              break stepBody;
            }
            simulated.set(step.id, "stalled");
            stalled = true;
          }
        }
        }
        // A `sequence` stage stops here unless THIS step read "done" on
        // this pass -- covering a launch (now "running"), a stall (every
        // site that sets `stalled = true` for this step also leaves it at
        // "stalled" first), and a step rule 1-3 had no reason to touch at
        // all. Rule 5 below still reads `stalled` to pause the rail; that
        // is a separate concern from stopping THIS stage's walk early.
        if (sequential && simulated.get(step.id) !== "done") break;
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

/// A freshly minted stage: `mode: "sequence"`, `name: null`. A stage
/// nobody has grouped yet has nothing to call itself, and single-step or
/// empty runs identically in either mode -- which is what makes the NEXT
/// drop onto it mean what it says (G3). One factory, so the sites that
/// mint a stage (`addStage`, `insertAsStage`, `splitStageIntoSequence`)
/// can't drift on this shape piecemeal as fields are added to `Stage`.
function newStage(id: string, position: number, steps: Step[]): Stage {
  return { id, position, mode: "sequence", name: null, steps };
}

export function addStage(orch: Orchestration, railId: string, stageId: string): Orchestration {
  return {
    ...orch,
    rails: orch.rails.map((r) =>
      r.id === railId
        ? { ...r, stages: renumber([...r.stages, newStage(stageId, r.stages.length, [])]) }
        : r
    ),
  };
}

/// The stage with this id, wherever it sits -- the stage-level twin of
/// findStep, for every surface that gets a stage id from the DOM.
export function findStage(orch: Orchestration, stageId: string): Stage | null {
  for (const rail of orch.rails) {
    for (const stage of rail.stages) {
      if (stage.id === stageId) return stage;
    }
  }
  return null;
}

function mapStage(
  orch: Orchestration,
  stageId: string,
  f: (stage: Stage) => Stage
): Orchestration {
  return {
    ...orch,
    rails: orch.rails.map((r) => ({
      ...r,
      stages: r.stages.map((s) => (s.id === stageId ? f(s) : s)),
    })),
  };
}

/// Flip a group between running its steps at once and one at a time.
/// Safe mid-run in both directions: a sequence group has at most one
/// running member, and flipping to parallel only lets the rest start on
/// the next tick.
export function setStageMode(orch: Orchestration, stageId: string, mode: StageMode): Orchestration {
  return mapStage(orch, stageId, (s) => ({ ...s, mode }));
}

/// Name a group, or clear the name back to the positional label. A name
/// that is only whitespace is a cleared name, not a blank header.
export function renameStage(orch: Orchestration, stageId: string, name: string | null): Orchestration {
  const trimmed = name?.trim() ?? "";
  return mapStage(orch, stageId, (s) => ({ ...s, name: trimmed === "" ? null : trimmed }));
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

/// Would this drop FORM a group -- is the target a stage holding exactly
/// one step, and is that step not the one arriving?
///
/// The second half is load-bearing and easy to miss: a member being
/// REORDERED within its own stage is detached first, which leaves that
/// stage momentarily holding one step. Read after the detach, a reorder
/// inside a parallel group is indistinguishable from a drop that forms
/// one, and would silently flip the group to sequence. So this is always
/// evaluated against the orchestration BEFORE anything is detached.
function formsGroup(orch: Orchestration, stageId: string, arrivingStepId: string | null): boolean {
  const stage = findStage(orch, stageId);
  return Boolean(stage) && stage!.steps.length === 1 && stage!.steps[0].id !== arrivingStepId;
}

/// Insert into a stage at `index`, clamped. `forming` makes it a
/// `sequence` group (grouping spec G3): that stage's stored mode
/// described nothing observable while it held one step, so overwriting it
/// discards no intent, and the gesture means the same thing whether the
/// target was written today or before groups existed. A stage that is
/// already a group keeps the mode the human chose for it.
function insertStep(
  orch: Orchestration,
  stageId: string,
  index: number,
  forming: boolean,
  make: (position: number) => Step
): Orchestration {
  return mapStage(orch, stageId, (s) => {
    const steps = [...s.steps].sort((a, b) => a.position - b.position);
    steps.splice(Math.max(0, Math.min(index, steps.length)), 0, make(0));
    return { ...s, mode: forming ? "sequence" : stageMode(s), steps: renumber(steps) };
  });
}

export function addStep(
  orch: Orchestration,
  stageId: string,
  stepId: string,
  cardPath: string,
  index: number
): Orchestration {
  // A brand-new step is never already in the target, so `null` is the
  // honest "nothing is arriving from inside this stage".
  return insertStep(orch, stageId, index, formsGroup(orch, stageId, null), (position) =>
    cardStep(stepId, position, cardPath)
  );
}

/// Join an existing stage with a tool -- the same grouping drop addStep
/// is for a card.
export function addToolStep(
  orch: Orchestration,
  stageId: string,
  stepId: string,
  toolId: string,
  index: number
): Orchestration {
  return insertStep(orch, stageId, index, formsGroup(orch, stageId, null), (position) =>
    toolStep(stepId, position, toolId)
  );
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
  return removeSteps(orch, [stepId]);
}

/// Remove a whole SET of steps in one write -- what "Clear done" needs,
/// and what removeStep is the one-element case of. One pass, so a stage
/// emptied by the last of its steps is dropped exactly as it is when a
/// single step leaves it empty.
export function removeSteps(orch: Orchestration, stepIds: string[]): Orchestration {
  if (stepIds.length === 0) return orch;
  const drop = new Set(stepIds);
  const rails = orch.rails.map((r) => ({
    ...r,
    stages: renumber(
      r.stages
        .map((s) => ({ ...s, steps: renumber(s.steps.filter((t) => !drop.has(t.id))) }))
        .filter((s) => s.steps.length > 0)
    ),
  }));
  return sweepOrphans({ ...orch, rails });
}

/// Remove a stage and every step it held -- what dropping a group on the
/// drawer means. sweepOrphans, because those step ids are gone for good.
export function removeStage(orch: Orchestration, stageId: string): Orchestration {
  const rails = orch.rails.map((r) => ({
    ...r,
    stages: renumber(r.stages.filter((s) => s.id !== stageId)),
  }));
  return sweepOrphans({ ...orch, rails });
}

/// A step is a card OR a tool, never neither (spec T1) -- and the daemon
/// refuses to store one that is neither. A pre-v11 daemon had no
/// `tool_id` column, so every tool step handed to it came back as
/// exactly that: an untitled chip, and a plan the current daemon will
/// reject wholesale until it is gone, which would wedge every later
/// save. Dropped on the way in from the wire, so neither the eye nor the
/// next save ever meets one.
export function dropImpossibleSteps(orch: Orchestration): Orchestration {
  const rails = orch.rails.map((r) => ({
    ...r,
    stages: renumber(
      r.stages
        .map((s) => ({
          ...s,
          steps: renumber(s.steps.filter((t) => isToolStep(t) || t.cardPath !== "")),
        }))
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

/// Drop onto an existing stage: the step joins it at `index`, forming a
/// `sequence` group if that stage held one step (G3). No sweepOrphans --
/// the step id survives a move, so its run state and notes must too.
///
/// CONTRACT: `index` counts the target's members with the dragged step
/// already removed if it came from this same stage, which is what the
/// drag glue measures.
export function moveStepIntoStage(
  orch: Orchestration,
  stepId: string,
  stageId: string,
  index: number
): Orchestration {
  const found = locateStep(orch, stepId);
  if (!found) return orch;
  // Decided BEFORE the detach -- see formsGroup.
  const forming = formsGroup(orch, stageId, stepId);
  const detached = detachStep(orch, stepId);
  if (!detached.rails.some((r) => r.stages.some((s) => s.id === stageId))) return orch;
  return insertStep(detached, stageId, index, forming, (position) => ({ ...found.step, position }));
}
// Note the removed `found.stageId === stageId` early return: reordering
// *within* a stage is now a real move, and refusing it would make
// within-group ordering impossible. detachStep drops a stage it empties,
// so a same-stage move of the only step still finds nothing to insert
// into and returns unchanged via the guard above.

/// Insert a stage into a rail's list at `index`, clamped so "past the
/// end" appends rather than failing, and renumbered. The one place that
/// splices a stage list, so moveStageToIndex and insertAsStage -- one
/// relocating an existing stage, one minting a fresh one -- can't drift
/// on the clamp between them.
function insertStageAt(stages: Stage[], index: number, stage: Stage): Stage[] {
  const next = [...stages];
  next.splice(Math.max(0, Math.min(index, next.length)), 0, stage);
  return renumber(next);
}

/// Drop into the gap between stages: the step becomes its own stage
/// there and runs SEQUENTIALLY. `index` is clamped, so "past the end"
/// appends rather than failing.
///
/// CONTRACT: `index` counts stage positions in the target rail with the
/// dragged step's own stage already removed if that removal emptied it --
/// which is what the drag glue measures, since the dragged chip is
/// excluded from measurement.
///
/// Detach, then hand off to insertAsStage: the only difference from a
/// brand-new card is that the step already exists, so its shape is
/// carried over instead of built fresh.
export function moveStepToNewStage(
  orch: Orchestration,
  stepId: string,
  railId: string,
  index: number
): Orchestration {
  const found = locateStep(orch, stepId);
  if (!found || !orch.rails.some((r) => r.id === railId)) return orch;
  return insertAsStage(detachStep(orch, stepId), railId, index, { ...found.step, position: 0 });
}

/// Move a whole stage -- every step it holds, with their ids and so their
/// run state -- to `index` in `railId`. The unit move a group needs, and
/// the stage-level twin of moveStepToNewStage.
///
/// CONTRACT: `index` counts stage positions in the target rail with the
/// dragged stage already removed, which is what the drag glue measures.
export function moveStageToIndex(
  orch: Orchestration,
  stageId: string,
  railId: string,
  index: number
): Orchestration {
  const stage = findStage(orch, stageId);
  if (!stage || !orch.rails.some((r) => r.id === railId)) return orch;
  const detached = orch.rails.map((r) => ({
    ...r,
    stages: renumber(r.stages.filter((s) => s.id !== stageId)),
  }));
  return {
    ...orch,
    rails: detached.map((r) => (r.id === railId ? { ...r, stages: insertStageAt(r.stages, index, stage) } : r)),
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

/// Place a fully-formed stage -- a template's group, steps and all -- at
/// `index` in `railId`. The multi-step twin of insertAsStage: that one
/// mints a fresh single-step stage, this one is handed a whole stage
/// (name, mode and members already set by the caller) and only renumbers
/// it. Goes through insertStageAt like every other stage-list splice, so
/// the clamp-past-the-end behaviour can't drift from moveStageToIndex's.
export function insertStageWithSteps(
  orch: Orchestration,
  railId: string,
  index: number,
  stage: Stage
): Orchestration {
  if (!orch.rails.some((r) => r.id === railId)) return orch;
  return {
    ...orch,
    rails: orch.rails.map((r) =>
      r.id === railId
        ? { ...r, stages: insertStageAt(r.stages, index, { ...stage, steps: renumber(stage.steps) }) }
        : r
    ),
  };
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
    rails: orch.rails.map((r) =>
      r.id === railId
        ? { ...r, stages: insertStageAt(r.stages, index, newStage(crypto.randomUUID(), 0, [step])) }
        : r
    ),
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

/// The rail a card is on, as a board card wears it: the rail's NAME and
/// where in its run order the card falls -- everything a glyph and its
/// tooltip need, without the surface walking the rails itself.
///
/// Null when the card is on no rail, and null for an orchestration that
/// is not loaded yet: a board renders long before the Orchestration tab
/// is ever opened, and an unloaded plan has to read as "no rail".
export interface CardRailBadge {
  railId: string;
  railName: string;
  /// 1-based, paired with `stageCount`, exactly as `CardPlacement` gives
  /// them -- "stage 2 of 4".
  stageNumber: number;
  stageCount: number;
}

export function cardRailBadge(
  orch: Orchestration | null | undefined,
  cardPath: string
): CardRailBadge | null {
  if (!orch) return null;
  const placement = findCardPlacement(orch, cardPath);
  if (!placement) return null;
  const rail = orch.rails.find((r) => r.id === placement.railId);
  if (!rail) return null;
  return {
    railId: rail.id,
    railName: rail.name,
    stageNumber: placement.stageNumber,
    stageCount: placement.stageCount,
  };
}

/// Put a card on a rail from OUTSIDE the tab -- the board's composer, a
/// card's context menu, its detail modal. The card lands as the rail's
/// own trailing stage, the sequential default the drawer's click already
/// uses; joining or grouping with an existing stage stays the deliberate
/// act of dropping onto one (grouping spec G3).
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

/// Every distinct card a rail carries, in run order (stage by position,
/// then step by position). Tool steps have no card and drop out; a card
/// written onto two steps counts ONCE, because what a caller does with
/// this list it does to the card FILE.
export function railCardPaths(rail: Rail): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const stage of [...rail.stages].sort((a, b) => a.position - b.position)) {
    for (const step of [...stage.steps].sort((a, b) => a.position - b.position)) {
      if (isToolStep(step) || !step.cardPath || seen.has(step.cardPath)) continue;
      seen.add(step.cardPath);
      paths.push(step.cardPath);
    }
  }
  return paths;
}

/// The cards a "move all to <column>" would actually WRITE: the rail's
/// cards, minus the ones already in that column (a no-op write still
/// churns the file and re-pushes the tree) and minus the ones the tree
/// has no card for -- a card deleted out from under the plan has no file
/// to write, and its chip already says so.
///
/// Empty means the action has nothing to do, which is how the surfaces
/// decide to disable it.
export function railCardsToMove(
  rail: Rail,
  cards: Map<string, CardEntry>,
  columnName: string
): string[] {
  const target = slugStatus(columnName);
  return railCardPaths(rail).filter((path) => {
    const entry = cards.get(path);
    if (!entry) return false;
    // A card with NO status is never "already there": the board shows it
    // in the first column, but the file does not say so, and this is the
    // write that makes it say so. Same rule as a card's own menu.
    if (entry.plan.status === null) return true;
    return slugStatus(entry.plan.status) !== target;
  });
}

/// The steps a "Clear done" would take OFF the rail, in run order.
///
/// Two facts make a step done, the same two rule 1 of the scheduler
/// joins (§4.2): the scheduler marked it `done`, or -- for a card step
/// on a rail that was never run, and so has no run state at all -- its
/// card already sits in the board's done column. A TOOL step has no card
/// and can only be finished by its run state.
///
/// A `running` step is never listed, whatever its card says: the daemon
/// refuses a plan write that drops one (replace_plan guard 3), and one
/// refusal would lose the whole clear rather than that single step.
///
/// Empty means the action has nothing to do, which is how the surfaces
/// decide to disable it.
export function railDoneStepIds(
  rail: Rail,
  orch: Orchestration,
  cards: Map<string, CardEntry>,
  doneColumnName: string | null
): string[] {
  const target = doneColumnName ? slugStatus(doneColumnName) : null;
  const plans = planIndex(cards);
  const ids: string[] = [];
  for (const stage of [...rail.stages].sort((a, b) => a.position - b.position)) {
    for (const step of [...stage.steps].sort((a, b) => a.position - b.position)) {
      const state = stepStateOf(orch, step.id);
      if (state === "running") continue;
      if (state === "done") {
        ids.push(step.id);
        continue;
      }
      if (isToolStep(step) || !target) continue;
      const entry = cards.get(step.cardPath);
      // The status the BOARD shows the card in, so a nested task clears
      // with its Done parent exactly as the scheduler skips it.
      const status = entry ? effectiveStatus(entry, plans) : null;
      if (status !== null && slugStatus(status) === target) ids.push(step.id);
    }
  }
  return ids;
}

/// Split one stage of N steps into N consecutive single-step stages, in
/// step order -- the "Make sequential" repair for a same-worktree
/// conflict of scope "stage".
///
/// The FIRST slice keeps the original stage id on purpose: a running
/// rail's `currentStageId` may point at this stage, and minting a fresh
/// id for every slice would strand it mid-run. Step ids are untouched
/// throughout, so run state and conflict notes ride along.
///
/// newStage also clears the name on every slice -- a name describes a
/// GROUP, and ungrouping says there is no longer one to name.
export function splitStageIntoSequence(orch: Orchestration, stageId: string): Orchestration {
  return {
    ...orch,
    rails: orch.rails.map((r) => {
      if (!r.stages.some((s) => s.id === stageId)) return r;
      const stages = r.stages.flatMap((s) => {
        if (s.id !== stageId || s.steps.length < 2) return [s];
        return [...s.steps]
          .sort((a, b) => a.position - b.position)
          .map((step, i) => newStage(i === 0 ? s.id : crypto.randomUUID(), 0, [{ ...step, position: 0 }]));
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

/// The cards a rail can take on: every runnable card not already on one.
/// Feeds both the unplaced drawer and a stage's "+ Add step" picker, so
/// the two can never disagree about what is on offer.
///
/// Two kinds never appear. A NOTE is not runnable (launchBlocker says so
/// too, one tick too late to be useful here). An ARCHIVED card is not on
/// the board at all -- mergePlanCards pulls it out before any column sees
/// it -- and offering filed-away work back as a candidate would undo the
/// human's filing decision in the one place they came to see what is
/// left to do.
export function availableCards(
  cards: Map<string, CardEntry>,
  placed: Set<string>
): CardEntry[] {
  return [...cards.values()].filter(
    (e) => e.plan.kind !== "note" && !isArchivedCard(e.plan.path) && !placed.has(e.plan.path)
  );
}

/// How many unplaced cards the tab REPORTS -- the drawer's header, and
/// the search summary in the bar.
///
/// The done group is listed but never counted: its cards are still
/// placeable (a rail may want one for its shape), yet nothing about them
/// is waiting, and the scheduler marks such a step done and cascades past
/// it without ever launching. A headline "Unplaced (40)" that is mostly
/// finished work answers a question nobody asked.
export function unplacedCount(groups: UnplacedGroup[]): number {
  return groups.reduce((n, g) => (g.isDone ? n : n + g.cards.length), 0);
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

  // 1. A PARALLEL stage IS a same-worktree conflict by construction: its
  // steps share the rail's checkout at the same time. That is intended,
  // and saying so out loud beats pretending it is safe (spec §5). A
  // SEQUENCE group is exempt (grouping spec G5) -- its members share that
  // checkout in turn, which is what a rail is for.
  const parallelStages = new Set(
    orch.rails.flatMap((r) => r.stages.filter((s) => stageMode(s) === "parallel").map((s) => s.id))
  );
  const byStage = new Map<string, PlacedStep[]>();
  for (const s of steps) {
    if (!s.checkout || !parallelStages.has(s.stageId)) continue;
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
