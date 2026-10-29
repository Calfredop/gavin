// What the desk shows about an Orchestrated plan (v80, ADR 0012): the
// Children control on its card, each Nested task's run state in its row
// inside the plan's card, and the "n/m nested" chip on its rail step.
// Pure, so the three .svelte surfaces stay thin templates over it; the
// scheduler's own rules are orchestration.ts's.

import type { ChecklistLink, ChildrenMode } from "$lib/core/gavin";
import {
  childTicked,
  isToolStep,
  orchestratedChildren,
  placedCardPaths,
  type CardEntry,
  type NestedRun,
  type Orchestration,
  type Step,
  type StepState,
} from "$lib/orchestration/orchestration";

/// The Children control's three answers. `off` is no line at all -- a
/// plan run as one session, which is what every plan was before v80.
export type ChildrenChoice = "off" | ChildrenMode;

export const CHILDREN_CHOICES: ReadonlyArray<{ value: ChildrenChoice; label: string }> = [
  { value: "off", label: "Off — one session" },
  { value: "sequence", label: "Sequence — one at a time" },
  { value: "parallel", label: "Parallel — all at once" },
];

export function childrenChoiceOf(children: ChildrenMode | null | undefined): ChildrenChoice {
  return children ?? "off";
}

/// The `children:` value the choice writes. Off REMOVES the line rather
/// than writing a word for it, so an ordinary plan stays byte-for-byte
/// the card it was.
export function childrenFieldValue(choice: ChildrenChoice): string {
  return choice === "off" ? "" : choice;
}

/// Whether a card offers the control: a plan with nested tasks -- and one
/// that already carries the line, so a plan whose children were all moved
/// away can still have it taken off.
export function childrenControlShown(card: {
  kind: string;
  children?: ChildrenMode | null;
  nestedChildren: readonly unknown[];
}): boolean {
  return card.kind === "plan" && (card.nestedChildren.length > 0 || card.children != null);
}

/// The sentence under the control: what pressing Run will now do.
export function childrenHint(choice: ChildrenChoice): string {
  switch (choice) {
    case "off":
      return "Run starts one agent on the plan, which works its nested tasks itself.";
    case "sequence":
      return "Run puts the plan on a rail of its own: each nested task runs as its own session, one after another, then the plan's session integrates them.";
    case "parallel":
      return "Run puts the plan on a rail of its own: every nested task runs as its own session at once, in one checkout, then the plan's session integrates them.";
  }
}

/// The plan card's mark when it orchestrates its children.
export function childrenMarkTip(children: ChildrenMode): string {
  return children === "sequence"
    ? "Orchestrated plan — its nested tasks run as their own sessions, one at a time, before the plan's"
    : "Orchestrated plan — its nested tasks run as their own sessions, all at once, before the plan's";
}

/// Every Nested task run under any step whose card is this plan. One plan
/// is normally one step; when it is on several, each runs its children
/// on its own, and the rows of all of them describe the same cards.
export function nestedRunsOfPlan(orch: Orchestration | undefined, planPath: string): NestedRun[] {
  const runs = orch?.nestedRuns ?? [];
  if (!orch || runs.length === 0) return [];
  const stepIds = new Set(
    orch.rails
      .flatMap((r) => r.stages.flatMap((s) => s.steps))
      .filter((t) => !isToolStep(t) && t.cardPath === planPath)
      .map((t) => t.id)
  );
  return runs.filter((r) => stepIds.has(r.stepId));
}

/// Most telling first, when one child has rows under more than one step:
/// a run happening now, then one that broke.
const ROW_RANK: Record<NestedRun["state"], number> = { running: 3, stalled: 2, skipped: 1, done: 0 };

/// What one Nested task's row inside its plan's card says about its run,
/// or null when the plan does not orchestrate its children -- such a
/// child is worked by the plan's own session, and a mark would claim a
/// run of its own that never happens.
///
/// `done` is the TICK (ADR 0012), whatever the run rows say: a child the
/// human ticked by hand is finished, and one whose run ended `done` but
/// whose line was unticked since is waiting to run again.
export function nestedChildState(
  plan: { children?: ChildrenMode | null; checklistLinks?: ChecklistLink[] },
  child: { id: string; fileName: string },
  runs: readonly NestedRun[]
): StepState | null {
  if (!plan.children) return null;
  if (childTicked(plan, child)) return "done";
  const row = runs
    .filter((r) => r.childPath === child.id)
    .sort((a, b) => ROW_RANK[b.state] - ROW_RANK[a.state])[0];
  if (!row || row.state === "done") return "pending";
  return row.state;
}

export interface NestedProgress {
  done: number;
  total: number;
}

/// How many of the Nested tasks a rail step runs are ticked, or null for
/// a step that runs none -- not an Orchestrated plan, or one whose every
/// child is placed as a step of its own.
export function nestedProgress(
  step: Step,
  orch: Orchestration,
  cards: ReadonlyMap<string, CardEntry>
): NestedProgress | null {
  const entry = cards.get(step.cardPath);
  const phase = orchestratedChildren(step, cards, placedCardPaths(orch));
  if (!entry || !phase || phase.children.length === 0) return null;
  const done = phase.children.filter((c) => childTicked(entry.plan, c.plan)).length;
  return { done, total: phase.children.length };
}

export function nestedProgressText(progress: NestedProgress): string {
  return `${progress.done}/${progress.total} nested`;
}

export function nestedProgressTip(progress: NestedProgress): string {
  const left = progress.total - progress.done;
  return left === 0
    ? `All ${progress.total} nested tasks are ticked — the plan's own session runs next`
    : `${progress.done} of ${progress.total} nested tasks ticked; ${left} still to run as their own sessions`;
}
