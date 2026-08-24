// The two requests the Orchestration tab hands to the RUNNING workspace
// agent, as pure text. Both drive the same `gavin-orchestrate` skill and
// both end in a whole-plan write; what differs is the SCOPE the prompt
// hands the agent:
//
//   - Generate  — the tab header's button, over the cards nobody placed;
//   - Reorganize — a rail header's button, over that one rail.
//
// Kept out of orchestrationState.ts so the wording is testable without a
// terminal to paste into (spec O10's habit: the load-bearing part is a
// pure function).

import type { CardEntry, Orchestration, Rail, Step, ToolSummary } from "./orchestration";
import { isToolStep, stepStateOf } from "./orchestration";

const READ_FIRST =
  "Read gavin_get_orchestration for the authoritative picture before writing anything.";

// Every write replaces the WHOLE plan, so both prompts have to say the
// same two things about the steps they are not touching.
const CARRY_THROUGH = [
  "The payload also lists this workspace's TOOLS — a step can run a tool (toolId) instead of a card,",
  "and rewriting a rail must carry every existing step's id, toolId and toolParams through.",
].join("\n");

/// How many unplaced cards the prompt spells out before deferring to the
/// read payload.
const MAX_LISTED = 30;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/// What a rail's agents edit, in one phrase: the checkout, and the
/// branch gavin puts it on if one is bound (spec O15). "no worktree" is
/// the honest answer for an unbound rail — its steps fall back to each
/// card's own context folder, which is not isolation.
function binding(rail: Rail): string {
  const wt = rail.worktreePath ?? "no worktree";
  return rail.branch ? `${wt}, branch ${rail.branch}` : wt;
}

function railLine(rail: Rail): string {
  const steps = rail.stages.reduce((n, s) => n + s.steps.length, 0);
  return `- ${rail.name} (${binding(rail)}): ${plural(rail.stages.length, "stage")}, ${plural(steps, "step")}`;
}

/// A step by the name the human sees on the tab: a card's title, or a
/// tool's name. Both fall back to the raw identifier — a step pointing
/// at a deleted card or tool still has to be describable, or the agent
/// cannot be told which step to fix.
function stepName(step: Step, cards: Map<string, CardEntry>, tools: ToolSummary[]): string {
  if (isToolStep(step)) {
    const tool = tools.find((t) => t.id === step.toolId);
    return `${tool?.name ?? step.toolId} (tool)`;
  }
  return cards.get(step.cardPath)?.plan.title ?? step.cardPath;
}

/// Run state rides along on every step that has any: `running` is the one
/// the daemon refuses to let the agent delete, and `stalled` is usually
/// the reason the human pressed the button at all.
function stepEntry(
  orch: Orchestration,
  step: Step,
  cards: Map<string, CardEntry>,
  tools: ToolSummary[]
): string {
  const name = stepName(step, cards, tools);
  const state = stepStateOf(orch, step.id);
  return state === "pending" ? name : `${name} [${state}]`;
}

function conflictBlock(conflictSummary: string[], railName: string | null): string {
  const where = railName ? ` on ${railName}` : "";
  return conflictSummary.length > 0
    ? `Gavin currently flags${where}:\n${conflictSummary.map((c) => `- ${c}`).join("\n")}`
    : `Gavin currently flags no conflicts${where}.`;
}

/// "Generate with agent…" — the job is the cards nobody has placed. The
/// tab's own picture rides along so the agent starts from what the human
/// is looking at; it still reads gavin_get_orchestration for the truth.
export function composeGeneratePrompt(
  orch: Orchestration | null,
  unplaced: CardEntry[],
  conflictSummary: string[]
): string {
  // The whole list is one gavin_get_orchestration call away, and this one
  // is bracketed-pasted into a terminal -- so a big backlog is cut here
  // and SAID to be cut, rather than filling the agent's screen or being
  // silently truncated into "that is all of them".
  const shown = unplaced.slice(0, MAX_LISTED);
  const list = [
    ...shown.map((e) => `- ${e.plan.title} (${e.plan.status ?? "no status"}) — ${e.plan.path}`),
    ...(unplaced.length > shown.length
      ? [`- …and ${unplaced.length - shown.length} more; the read payload lists them all.`]
      : []),
  ].join("\n");

  return [
    "Use the gavin-orchestrate skill to put this workspace's UNPLACED cards on rails.",
    "",
    unplaced.length > 0
      ? `${plural(unplaced.length, "card")} nobody has placed yet:\n${list}`
      : "Nothing is unplaced right now — say so and change nothing rather than inventing work.",
    "",
    orch && orch.rails.length > 0
      ? `The tab currently shows:\n${orch.rails.map(railLine).join("\n")}`
      : "The tab has no rails yet — create them.",
    "",
    conflictBlock(conflictSummary, null),
    "",
    "Place every unplaced card the payload lists: extend a rail where the work belongs on one, add",
    "a rail where it does not. Leave the steps already on rails where they are unless a card you",
    "are placing forces a reorder — and if it does, say which and why.",
    "",
    READ_FIRST,
    CARRY_THROUGH,
  ].join("\n");
}

/// A rail header's "Reorganize with agent…" — the same skill, aimed at
/// ONE rail. The steps it already holds are the material; the arrangement
/// is the question.
export function composeRailPrompt(
  orch: Orchestration,
  rail: Rail,
  cards: Map<string, CardEntry>,
  tools: ToolSummary[],
  /// Already narrowed to this rail by the caller (conflictsForRail).
  conflictSummary: string[]
): string {
  const stages = [...rail.stages].sort((a, b) => a.position - b.position);
  const body = stages
    .map((stage, i) => {
      const steps = [...stage.steps]
        .sort((a, b) => a.position - b.position)
        .map((s) => stepEntry(orch, s, cards, tools))
        .join(", ");
      return `  stage ${i + 1} — ${steps}`;
    })
    .join("\n");

  return [
    `Use the gavin-orchestrate skill to reorganize the rail "${rail.name}" — that rail only.`,
    "",
    stages.length > 0
      ? `It runs in ${binding(rail)} and holds:\n${body}`
      : `It runs in ${binding(rail)} and holds no steps yet — say so rather than filling it from elsewhere.`,
    "",
    conflictBlock(conflictSummary, `this rail`),
    "",
    "Reorganize this rail's stages: reorder them, split a stage whose steps would collide in one",
    "checkout, merge stages that are genuinely independent. Keep the steps it already holds — this",
    "is not the place to add or drop work — and send every OTHER rail back exactly as you read it.",
    "",
    READ_FIRST,
    CARRY_THROUGH,
  ].join("\n");
}
