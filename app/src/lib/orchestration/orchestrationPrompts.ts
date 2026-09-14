// The two requests the Orchestration tab hands to an agent of its own, as
// pure text. Both drive the same `gavin-orchestrate` skill and both end in
// a whole-plan write; what differs is the SCOPE the prompt hands the
// agent:
//
//   - Organize   — the tab header's button, over the cards nobody placed;
//   - Reorganize — a rail header's button, over that one rail.
//
// Each now launches a DEDICATED session rather than being pasted into the
// workspace's main agent, which is why both start with NAME_TAB_FIRST:
// the run has a tab of its own on the Agents page, and a tab labelled by a
// session-id fragment tells the human nothing about which of the two
// requests is in it.
//
// Kept out of orchestrationState.ts so the wording is testable without a
// terminal to launch (spec O10's habit: the load-bearing part is a pure
// function). Templates live in actionPrompts.ts; call sites pass overrides.

import type { CardEntry, Orchestration, Rail, Step, ToolSummary } from "$lib/orchestration/orchestration";
import { isToolStep, stepStateOf } from "$lib/orchestration/orchestration";
import { NAME_TAB_FIRST } from "$lib/cards/cardRun";
import {
  DEFAULT_ORGANIZE,
  DEFAULT_REORGANIZE,
  fillTemplate,
} from "$lib/agents/actionPromptDefaults";

const READ_FIRST =
  "Read gavin_get_orchestration for the authoritative picture before writing anything.";

// Every write replaces the WHOLE plan, so both prompts have to say the
// same things about the steps they are not touching, and about what is
// available to place: this workspace's own tools AND gavin's built-ins,
// which the read payload never lists (SKILL.md §2a carries the catalog).
const CARRY_THROUGH = [
  "The payload also lists this workspace's own TOOLS — a step can run a tool (toolId) instead of a",
  "card. That list is custom tools only; gavin's built-ins (the skill names the full catalog) never",
  "appear in it but are always available — use either kind wherever a tool step is the right fit,",
  "and carry every existing step's id, toolId and toolParams through the rewrite.",
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

/// "Organize with agent…" — the job is the cards nobody has placed. The
/// tab's own picture rides along so the agent starts from what the human
/// is looking at; it still reads gavin_get_orchestration for the truth.
///
/// PARALLELISM IS THE ASK, and the prompt says so rather than leaving it
/// to the skill alone. Pressing Organize is the human saying "spread this
/// out"; an agent that reads only the safety half of the parallelism rule
/// ("when unsure, serialize") answers it with one long rail, which is the
/// arrangement they already had. The safe way to run more at once is more
/// rails on more worktrees, so the request has to name the isolation --
/// and name it as work the agent DOES, since a rail whose worktree nobody
/// created is a `worktree-missing` conflict, not a bound rail.
export function composeOrganizePrompt(
  orch: Orchestration | null,
  unplaced: CardEntry[],
  conflictSummary: string[],
  template?: string,
  nameTabBase?: string
): string {
  // The whole list is one gavin_get_orchestration call away, and this one
  // arrives as a launch argument -- so a big backlog is cut here and SAID
  // to be cut, rather than filling the agent's screen or being silently
  // truncated into "that is all of them".
  const shown = unplaced.slice(0, MAX_LISTED);
  const list = [
    ...shown.map((e) => `- ${e.plan.title} (${e.plan.status ?? "no status"}) — ${e.plan.path}`),
    ...(unplaced.length > shown.length
      ? [`- …and ${unplaced.length - shown.length} more; the read payload lists them all.`]
      : []),
  ].join("\n");

  const unplaced_block =
    unplaced.length > 0
      ? `${plural(unplaced.length, "card")} nobody has placed yet:\n${list}`
      : "Nothing is unplaced right now — say so and change nothing rather than inventing work.";

  const rails_block =
    orch && orch.rails.length > 0
      ? `The tab currently shows:\n${orch.rails.map(railLine).join("\n")}`
      : "The tab has no rails yet — create them.";

  return fillTemplate(template ?? DEFAULT_ORGANIZE, {
    name_tab_first: nameTabBase ?? NAME_TAB_FIRST,
    unplaced_block,
    rails_block,
    conflicts_block: conflictBlock(conflictSummary, null),
    read_first: READ_FIRST,
    carry_through: CARRY_THROUGH,
  });
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
  conflictSummary: string[],
  template?: string,
  nameTabBase?: string
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

  const rail_body =
    stages.length > 0
      ? `It runs in ${binding(rail)} and holds:\n${body}`
      : `It runs in ${binding(rail)} and holds no steps yet — say so rather than filling it from elsewhere.`;

  return fillTemplate(template ?? DEFAULT_REORGANIZE, {
    name_tab_first: nameTabBase ?? NAME_TAB_FIRST,
    rail_name: rail.name,
    rail_body,
    conflicts_block: conflictBlock(conflictSummary, `this rail`),
    read_first: READ_FIRST,
    carry_through: CARRY_THROUGH,
  });
}
