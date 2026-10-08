// What the phone's Rails surface says about each rail: its state, the
// one action that moves it, and its stages and steps as rows a thumb can
// edit. Pure -- the surface draws it, `state/rails.ts` acts on it.
//
// Every fact is read through the desktop's own joins, so a rail says the
// same thing on the phone as in the desk's Orchestration tab: its state
// is `railStateOf`, where it is is `runningStageId`, whether it has
// anything left is `firstUnfinishedStageId`, and a step's card is the
// tree's (`cardIndex`) under the board's projection of its column.
import type { Board } from "$lib/board/kanban";
import type { GavinTree } from "$lib/core/gavin";
import {
  availableCards,
  cardIndex,
  effectiveStatus,
  firstUnfinishedStageId,
  isGroup,
  isToolStep,
  planIndex,
  railIsFinished,
  railStateOf,
  railTriggerLabel,
  runningStageId,
  stageLabel,
  stageMode,
  stepStateOf,
  unfinishedCards,
  type Orchestration,
  type Rail,
  type RailState,
  type StageMode,
  type StepState,
} from "$lib/orchestration/orchestration";
import {
  organizeAction,
  organizeButtonLabel,
  reorganizeAction,
  type OrchestrationAgentAction,
} from "$lib/orchestration/orchestrationAgent";
import { BUILTIN_TOOLS, findTool } from "$lib/orchestration/orchestrationTools";
import type { Workspace } from "$lib/core/workspace";

/// The one press that moves a rail, as the desk's header offers it:
/// Pause while it runs, Resume once paused, Start while idle with work
/// left, and nothing for a rail with none.
export type RailPress = "start" | "resume" | "pause";

export interface StepRow {
  id: string;
  /// The card's title, or the tool's name.
  title: string;
  /// Where the card sits on the board, or null (a tool step, a missing card).
  column: string | null;
  state: StepState;
  /// Why a stalled step stalled.
  reason: string | null;
  /// The card, for opening it; null for a tool step.
  cardPath: string | null;
  /// The step's agent, while it runs.
  sessionId: string | null;
}

export interface StageRow {
  id: string;
  label: string;
  mode: StageMode;
  /// Two steps or more: a group, whose mode is worth saying.
  group: boolean;
  /// The stage the rail is running now.
  current: boolean;
  first: boolean;
  last: boolean;
  steps: StepRow[];
}

export interface RailRow {
  id: string;
  name: string;
  state: RailState;
  /// Idle with nothing left: every step is done.
  finished: boolean;
  /// The press that moves it, or null.
  press: RailPress | null;
  /// Its start condition, when it has one.
  trigger: string | null;
  stages: StageRow[];
  /// Steps across its stages.
  stepCount: number;
}

export interface RailsInput {
  orch: Orchestration;
  tree: GavinTree | undefined;
  board: Board | undefined;
}

function pressFor(orch: Orchestration, rail: Rail): RailPress | null {
  const state = railStateOf(orch, rail.id);
  if (state === "running") return "pause";
  if (state === "paused") return "resume";
  return firstUnfinishedStageId(rail, orch) ? "start" : null;
}

export function railRows({ orch, tree }: RailsInput): RailRow[] {
  const cards = cardIndex(tree);
  const plans = planIndex(cards);
  return [...orch.rails]
    .sort((a, b) => a.position - b.position)
    .map((rail) => {
      const current = runningStageId(orch, rail.id);
      const stages = [...rail.stages].sort((a, b) => a.position - b.position);
      return {
        id: rail.id,
        name: rail.name,
        state: railStateOf(orch, rail.id),
        finished: railIsFinished(orch, rail) && stages.some((s) => s.steps.length > 0),
        press: pressFor(orch, rail),
        trigger: rail.trigger ? railTriggerLabel(rail.trigger) : null,
        stepCount: stages.reduce((n, s) => n + s.steps.length, 0),
        stages: stages.map((stage, index) => ({
          id: stage.id,
          label: stageLabel(stage, index),
          mode: stageMode(stage),
          group: isGroup(stage),
          current: stage.id === current,
          first: index === 0,
          last: index === stages.length - 1,
          steps: [...stage.steps]
            .sort((a, b) => a.position - b.position)
            .map((step) => {
              const run = orch.stepRuns.find((r) => r.stepId === step.id);
              const entry = isToolStep(step) ? undefined : cards.get(step.cardPath);
              const tool = isToolStep(step) ? findTool(BUILTIN_TOOLS, step.toolId as string) : undefined;
              return {
                id: step.id,
                title: isToolStep(step)
                  ? (tool?.name ?? step.toolId ?? "tool")
                  : (entry?.plan.title ?? fileNameOf(step.cardPath)),
                column: entry ? effectiveStatus(entry, plans) : null,
                state: stepStateOf(orch, step.id),
                reason: run?.reason ?? null,
                cardPath: isToolStep(step) ? null : step.cardPath,
                sessionId: run?.state === "running" ? run.sessionId : null,
              };
            }),
        })),
      };
    });
}

function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export interface CardChoice {
  path: string;
  title: string;
  column: string | null;
}

/// The cards a rail can take on from the phone: what the desk's "+ Add
/// step" picker offers -- not placed on any rail, not a note, not nested
/// in a plan, not archived, not already done.
export function cardsToPlace({ orch, tree, board }: RailsInput): CardChoice[] {
  const cards = cardIndex(tree);
  const plans = planIndex(cards);
  const placed = new Set(orch.rails.flatMap((r) => r.stages.flatMap((s) => s.steps.map((t) => t.cardPath))));
  return unfinishedCards(availableCards(cards, placed), plans, board ?? null)
    .map((entry) => ({ path: entry.plan.path, title: entry.plan.title, column: effectiveStatus(entry, plans) }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/// What a rail's state reads as, beside its badge.
export function railStateText(row: RailRow): string {
  if (row.finished) return "finished";
  if (row.state === "running") {
    const stage = row.stages.find((s) => s.current);
    return stage ? `running · ${stage.label}` : "running";
  }
  return row.state;
}

/// The words on a rail's press.
export const PRESS_LABEL: Record<RailPress, string> = { start: "Start", resume: "Resume", pause: "Pause" };

/// The rail the surface opens on, once its rails first arrive: the one
/// running, else one paused on the human, else the first.
export function openingRail(rows: RailRow[]): string | null {
  return (rows.find((r) => r.state === "running") ?? rows.find((r) => r.state === "paused") ?? rows[0])?.id ?? null;
}

export interface AgentSlotInput {
  workspace: Workspace;
  /// featureBlockedReason for orchestration writes, or null.
  daemonBlocked: string | null;
  /// The cards Organize would be handed (`cardsToPlace`).
  unplacedCount: number;
}

/// The Organize press over the rails, and a rail editor's Reorganize, by
/// the desk's own rules: one run per workspace, and while it goes every
/// press shows it instead of starting a second.
export interface AgentPresses {
  organize: OrchestrationAgentAction;
  organizeLabel: string;
  reorganize: (railId: string) => OrchestrationAgentAction;
  /// A run is holding the slot.
  running: boolean;
}

export function agentPresses({ workspace, daemonBlocked, unplacedCount }: AgentSlotInput): AgentPresses {
  const run = workspace.orchestrationAgent ?? null;
  // The launch reads `rootPath || null`, so an empty one is no root.
  const hasRoot = Boolean(workspace.rootPath);
  return {
    organize: organizeAction({ run, unplacedCount, hasRoot, daemonBlocked }),
    organizeLabel: organizeButtonLabel(run),
    reorganize: (railId) => reorganizeAction({ run, railId, hasRoot, daemonBlocked }),
    running: run !== null,
  };
}
