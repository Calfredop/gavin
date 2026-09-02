import {
  isToolStep,
  railCardPaths,
  railDoneStepIds,
  railStateOf,
  runnableIdleRails,
  firstUnfinishedStageId,
  stepStateOf,
} from "./orchestration";
import type { CardEntry, Orchestration, Rail, Stage } from "./orchestration";

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

/// Singularizes a count for a plain noun (`1 card`, `2 cards`) -- the one
/// place this codebase spells that pluralization, so callers outside this
/// module (GroupTemplateSaveDialog's own "N tool steps" line included)
/// reuse it rather than growing a second copy that drifts.
export function count(n: number, noun: string): string {
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

/// Dropping a group on the drawer removes it AND every step it holds --
/// unlike every other unplace, which is one step -- so this asks first,
/// the same discipline railDeleteConfirm uses. `cards` narrows the "N
/// cards stay" count to files the tree still knows about, the same
/// honesty a step chip already applies when its own card is gone: a
/// count that includes a reference nothing backs any more would be a
/// promise the app cannot keep.
export function groupRemoveConfirm(stage: Stage, cards: Map<string, CardEntry>): RailConfirm {
  const cardPaths = new Set(
    stage.steps
      .filter((s) => !isToolStep(s) && s.cardPath && cards.has(s.cardPath))
      .map((s) => s.cardPath)
  );
  const title = stage.name ? `Remove group "${stage.name}"?` : "Remove this group?";
  const lines = [`Removes ${count(stage.steps.length, "step")} from the plan.`];
  if (cardPaths.size > 0)
    lines.push(
      `${count(cardPaths.size, "card")} ${cardPaths.size === 1 ? "stays" : "stay"} — a step is only a reference.`
    );
  return { title, lines, confirmLabel: "Remove group" };
}

/// What "Run all" asks before it arms every idle rail. Not destructive,
/// but not small either -- N rails, each launching an agent on a page of
/// its own -- so it names them, and it accounts for every rail it is NOT
/// starting. A count smaller than the number of rails on screen is
/// exactly the moment a human wants to know why, and the three reasons
/// (already running, deliberately paused, nothing left to do) are
/// different enough that one lumped "some rails were skipped" would
/// answer none of them.
export function runAllConfirm(orch: Orchestration): RailConfirm {
  const runnable = runnableIdleRails(orch);
  const idle = orch.rails.filter((r) => railStateOf(orch, r.id) === "idle");
  const running = orch.rails.filter((r) => railStateOf(orch, r.id) === "running").length;
  const paused = orch.rails.filter((r) => railStateOf(orch, r.id) === "paused").length;
  const finished = idle.filter((r) => firstUnfinishedStageId(r, orch) === null).length;
  const lines = [
    `Starts: ${runnable.map((r) => r.name).join(", ")}.`,
    "Each one arms at its first unfinished stage and launches on its own page.",
  ];
  // Said as a fact about the rails, not as an apology: a running rail is
  // left alone because re-arming it would rewind it to its first
  // unfinished stage, and a paused one because pausing was a decision.
  if (running > 0)
    lines.push(
      `${count(running, "rail")} already running ${running === 1 ? "keeps" : "keep"} going, untouched.`
    );
  if (paused > 0)
    lines.push(
      `${count(paused, "rail")} paused ${paused === 1 ? "stays" : "stay"} paused — resume ${paused === 1 ? "it" : "them"} from ${paused === 1 ? "its" : "their"} own header.`
    );
  if (finished > 0)
    lines.push(
      `${count(finished, "idle rail")} ${finished === 1 ? "has" : "have"} nothing left to run.`
    );
  return {
    title: `Run ${count(runnable.length, "idle rail")}?`,
    lines,
    confirmLabel: `Start ${count(runnable.length, "rail")}`,
  };
}
