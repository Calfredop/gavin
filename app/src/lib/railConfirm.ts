import { railCardPaths, railDoneStepIds, railStateOf, stepStateOf } from "./orchestration";
import type { CardEntry, Orchestration, Rail } from "./orchestration";

/// What a destructive rail action asks before it runs: the prompt's
/// title, its consequence lines, and the word on the button. Built here
/// rather than inside the header so the counts a human agrees to come
/// from the very joins the ACTIONS use -- railDoneStepIds decides what
/// "done" means for the clear, railCardPaths counts a twice-placed card
/// once -- and so the copy can be tested without a component.
export interface RailConfirm {
  title: string;
  lines: string[];
  confirmLabel: string;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/// Deleting a rail throws away the PLAN's column: its stages, its steps
/// and its run rows. The cards are untouched -- a step is only a
/// reference (spec O2) -- and so is the worktree it was bound to, which
/// is exactly what the human needs told, because both look like they go
/// with it.
export function railDeleteConfirm(rail: Rail, orch: Orchestration): RailConfirm {
  const steps = rail.stages.flatMap((s) => s.steps);
  const cards = railCardPaths(rail).length;
  const state = railStateOf(orch, rail.id);
  const running = steps.filter((s) => stepStateOf(orch, s.id) === "running").length;
  // An empty rail says so rather than reading "0 stages and 0 steps",
  // which is arithmetic where a sentence belongs.
  const lines = [
    steps.length === 0 && rail.stages.length === 0
      ? "This rail is empty — only the rail itself goes."
      : `Removes ${count(rail.stages.length, "stage")} and ${count(steps.length, "step")} from the plan.`,
  ];
  if (cards > 0)
    lines.push(`${count(cards, "card")} ${cards === 1 ? "stays" : "stay"} — a step is only a reference.`);
  if (state !== "idle") lines.push(`Its run state (${state}) goes with it.`);
  // A LIVE running step is refused by the daemon (replace_plan guard 3),
  // so say so here rather than let the delete come back as an error
  // strip. A stale row whose session has ended is allowed through, which
  // is why this warns rather than blocks.
  if (running > 0)
    lines.push(
      `${count(running, "step")} ${running === 1 ? "is" : "are"} still running — a live one refuses the delete, so pause the rail first.`
    );
  if (rail.worktreePath)
    lines.push(`The worktree ${rail.worktreePath} is left as it is — only the rail's binding to it goes.`);
  return { title: `Delete rail "${rail.name}"?`, lines, confirmLabel: "Delete rail" };
}

/// Clearing takes the finished steps off and leaves the rail showing
/// only what is still ahead. Nothing on disk changes: the cards keep
/// their files and their columns.
export function railClearDoneConfirm(
  rail: Rail,
  orch: Orchestration,
  cards: Map<string, CardEntry>,
  doneColumnName: string | null
): RailConfirm {
  const ids = railDoneStepIds(rail, orch, cards, doneColumnName);
  const lines = [
    `Takes ${count(ids.length, "done step")} off this rail.`,
    "The cards stay — only the steps that pointed at them leave.",
  ];
  // The clear repoints a running rail at the first stage that survived
  // (clearDoneStepsAction), which is worth saying: cutting away the
  // stage under a live run reads like it would stop it.
  if (railStateOf(orch, rail.id) === "running")
    lines.push("The run picks up from the first unfinished stage that is left.");
  return {
    title: `Clear done steps from "${rail.name}"?`,
    lines,
    confirmLabel: `Clear ${count(ids.length, "step")}`,
  };
}
