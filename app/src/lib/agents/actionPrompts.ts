// Agent action prompts: the templates gavin hands an agent for a named
// action (commit via agent, run a card, critical review, …), as data.
//
// Built-in agent tool bodies live in orchestrationTools.ts; everything
// else that launches an agent with a canned prompt lives here. Both are
// tweakable the same way: a body override at workspace scope wins over
// one at app scope, and neither set means the shipped default.
//
// Pure. Persistence and the editor live in actionPromptsState.ts and the
// Tools explorer; composers take the resolved body as an argument so
// this module never reads a store.

import { BUILTIN_TOOLS, placeholdersIn, type Tool, type ToolParam } from "$lib/orchestration/orchestrationTools";
import {
  DEFAULT_BEST_OF_N_SUFFIX,
  DEFAULT_CODE_REVIEW,
  DEFAULT_CRITICAL_REVIEW_SUFFIX,
  DEFAULT_DEVELOP,
  DEFAULT_NAME_TAB_FIRST,
  DEFAULT_ORGANIZE,
  DEFAULT_REORGANIZE,
  DEFAULT_RESUME_PLAN,
  DEFAULT_RESUME_TASK,
  DEFAULT_REVIEW_LAUNCH,
  DEFAULT_RUN_PLAN,
  DEFAULT_RUN_TASK,
  DEFAULT_UNTIL_RETRY_PREFIX,
  fillTemplate,
} from "$lib/agents/actionPromptDefaults";

export {
  DEFAULT_BEST_OF_N_SUFFIX,
  DEFAULT_CODE_REVIEW,
  DEFAULT_CRITICAL_REVIEW_SUFFIX,
  DEFAULT_DEVELOP,
  DEFAULT_NAME_TAB_FIRST,
  DEFAULT_ORGANIZE,
  DEFAULT_REORGANIZE,
  DEFAULT_RESUME_PLAN,
  DEFAULT_RESUME_TASK,
  DEFAULT_REVIEW_LAUNCH,
  DEFAULT_RUN_PLAN,
  DEFAULT_RUN_TASK,
  DEFAULT_UNTIL_RETRY_PREFIX,
  fillTemplate,
};

export type ActionPromptGroup =
  | "git"
  | "cards"
  | "review"
  | "orchestration"
  | "tools";

export type ActionPromptSource = "default" | "app" | "workspace";

export interface ActionPrompt {
  id: string;
  name: string;
  description: string;
  group: ActionPromptGroup;
  defaultBody: string;
  /// Declared `{{placeholders}}` the editor can hint about. Dynamic
  /// sections the app fills in at launch (card lists, attachment blocks)
  /// are named here so a human editing the template knows what survives.
  params: ToolParam[];
  /// When set, this prompt IS that built-in's body: editing it overrides
  /// the tool the rails and Tools tab run, not a parallel string.
  toolId?: string;
}

export function effectiveBody(
  id: string,
  defaultBody: string,
  appOverrides: Record<string, string> | null | undefined,
  workspaceOverrides: Record<string, string> | null | undefined
): string {
  const workspace = workspaceOverrides?.[id];
  if (typeof workspace === "string" && workspace.trim()) return workspace;
  const app = appOverrides?.[id];
  if (typeof app === "string" && app.trim()) return app;
  return defaultBody;
}

export function bodySource(
  id: string,
  appOverrides: Record<string, string> | null | undefined,
  workspaceOverrides: Record<string, string> | null | undefined
): ActionPromptSource {
  const workspace = workspaceOverrides?.[id];
  if (typeof workspace === "string" && workspace.trim()) return "workspace";
  const app = appOverrides?.[id];
  if (typeof app === "string" && app.trim()) return "app";
  return "default";
}

export function groupLabel(group: ActionPromptGroup): string {
  switch (group) {
    case "git":
      return "Git";
    case "cards":
      return "Cards";
    case "review":
      return "Review";
    case "orchestration":
      return "Orchestration";
    case "tools":
      return "Built-in agent tools";
  }
}

function toolParams(tool: Tool): ToolParam[] {
  return tool.params.map((p) => ({ ...p }));
}

function agentBuiltin(tool: Tool, group: ActionPromptGroup, description?: string): ActionPrompt {
  return {
    id: tool.id,
    name: tool.name,
    description: description ?? tool.description,
    group,
    defaultBody: tool.body,
    params: toolParams(tool),
    toolId: tool.id,
  };
}

const byId = (id: string): Tool => {
  const tool = BUILTIN_TOOLS.find((t) => t.id === id);
  if (!tool) throw new Error(`missing builtin ${id}`);
  return tool;
};

const PATH_PARAMS: ToolParam[] = [
  { name: "path", label: "Card path", default: "" },
  { name: "title", label: "Card title", default: "" },
];

const CARD_RUN_PARAMS: ToolParam[] = [
  { name: "name_tab_first", label: "Name-tab opener", default: "" },
  ...PATH_PARAMS,
  { name: "attachments", label: "Attachments block", default: "" },
  { name: "body", label: "Card body", default: "" },
  { name: "card_home_note", label: "Decoy-card note", default: "" },
];

/// Every tweakable agent action prompt, in editor order.
export const ACTION_PROMPTS: ActionPrompt[] = [
  {
    id: "action:name-tab-first",
    name: "Name the tab first",
    description: "Opening line almost every visible agent launch prepends.",
    group: "cards",
    defaultBody: DEFAULT_NAME_TAB_FIRST,
    params: [],
  },
  {
    id: "action:run-task",
    name: "Run a task card",
    description: "Board / rail launch for kind: task.",
    group: "cards",
    defaultBody: DEFAULT_RUN_TASK,
    params: CARD_RUN_PARAMS,
  },
  {
    id: "action:run-plan",
    name: "Run a plan card",
    description: "Board / rail launch for kind: plan.",
    group: "cards",
    defaultBody: DEFAULT_RUN_PLAN,
    params: [
      { name: "name_tab_first", label: "Name-tab opener", default: "" },
      { name: "path", label: "Card path", default: "" },
      { name: "attachments", label: "Attachments block", default: "" },
      { name: "card_home_note", label: "Decoy-card note", default: "" },
    ],
  },
  {
    id: "action:resume-task",
    name: "Resume a task card",
    description: "In Progress task → gavin-resume skill.",
    group: "cards",
    defaultBody: DEFAULT_RESUME_TASK,
    params: CARD_RUN_PARAMS,
  },
  {
    id: "action:resume-plan",
    name: "Resume a plan card",
    description: "In Progress plan → gavin-resume skill.",
    group: "cards",
    defaultBody: DEFAULT_RESUME_PLAN,
    params: [
      { name: "name_tab_first", label: "Name-tab opener", default: "" },
      { name: "path", label: "Card path", default: "" },
      { name: "attachments", label: "Attachments block", default: "" },
    ],
  },
  {
    id: "action:develop",
    name: "Develop a card",
    description: "To Do → gavin-develop skill.",
    group: "cards",
    defaultBody: DEFAULT_DEVELOP,
    params: [
      { name: "name_tab_first", label: "Name-tab opener", default: "" },
      ...PATH_PARAMS,
    ],
  },
  {
    id: "action:review-launch",
    name: "Review-tab agent",
    description: "Agent opened beside a Done card on the Review tab.",
    group: "review",
    defaultBody: DEFAULT_REVIEW_LAUNCH,
    params: [
      { name: "name_tab_first", label: "Name-tab opener", default: "" },
      { name: "subject", label: "“task card” or “plan”", default: "task card" },
      ...PATH_PARAMS,
      { name: "attachments", label: "Attachments block", default: "" },
      { name: "quoted_body", label: "Quoted body block", default: "" },
    ],
  },
  {
    id: "action:code-review",
    name: "Review with agent",
    description:
      "Single-agent review prompt (Git tab, card menu). Same filing rules as the rail tool.",
    group: "review",
    defaultBody: DEFAULT_CODE_REVIEW,
    params: [
      { name: "name_tab_first", label: "Optional name-tab opener", default: "" },
      { name: "subject", label: "What is under review", default: "the changes on this branch" },
      { name: "base", label: "Compare against", default: "main" },
      { name: "rules_path", label: "Rules file", default: ".gavin-root/REVIEW.md" },
      { name: "card_read_line", label: "Optional “read the card” line", default: "" },
      { name: "context_folder_line", label: "context_folder bullet", default: "" },
      { name: "placement", label: "Finding placement lines", default: "" },
      {
        name: "plans_folder",
        label: "Fallback plans folder",
        default: "that context's `plans/` folder",
      },
    ],
  },
  {
    id: "action:critical-review-suffix",
    name: "Critical review framing",
    description: "Appended to each parallel reviewer after the ordinary review prompt.",
    group: "review",
    defaultBody: DEFAULT_CRITICAL_REVIEW_SUFFIX,
    params: [
      { name: "reviewer_label", label: "Reviewer label", default: "" },
      { name: "reviewer_total", label: "Reviewer count", default: "2" },
      { name: "findings_rail_note", label: "Optional findings-rail note", default: "" },
    ],
  },
  {
    id: "action:organize",
    name: "Organize with agent",
    description: "Orchestration tab — place unplaced cards onto rails.",
    group: "orchestration",
    defaultBody: DEFAULT_ORGANIZE,
    params: [
      { name: "name_tab_first", label: "Name-tab opener", default: "" },
      { name: "unplaced_block", label: "Unplaced cards block", default: "" },
      { name: "rails_block", label: "Current rails block", default: "" },
      { name: "conflicts_block", label: "Conflicts block", default: "" },
      { name: "read_first", label: "Read-first line", default: "" },
      { name: "carry_through", label: "Carry-through tools note", default: "" },
    ],
  },
  {
    id: "action:reorganize",
    name: "Reorganize a rail",
    description: "One rail’s “Reorganize with agent…”.",
    group: "orchestration",
    defaultBody: DEFAULT_REORGANIZE,
    params: [
      { name: "name_tab_first", label: "Name-tab opener", default: "" },
      { name: "rail_name", label: "Rail name", default: "" },
      { name: "rail_body", label: "Stages / steps block", default: "" },
      { name: "conflicts_block", label: "Conflicts block", default: "" },
      { name: "read_first", label: "Read-first line", default: "" },
      { name: "carry_through", label: "Carry-through tools note", default: "" },
    ],
  },
  {
    id: "action:best-of-n-suffix",
    name: "Best-of-N candidate framing",
    description: "Appended to each candidate’s ordinary card prompt.",
    group: "cards",
    defaultBody: DEFAULT_BEST_OF_N_SUFFIX,
    params: [
      { name: "label", label: "Candidate label", default: "" },
      { name: "total", label: "Candidate count", default: "2" },
    ],
  },
  {
    id: "action:until-retry-prefix",
    name: "Until-retry prefix",
    description: "Prefixed onto an agent step when a Loop-until check sends the rail back.",
    group: "orchestration",
    defaultBody: DEFAULT_UNTIL_RETRY_PREFIX,
    params: [{ name: "check_output", label: "Failing check output", default: "" }],
  },
  agentBuiltin(byId("builtin:commit"), "git", "Git tab “Commit via agent” and the Commit changes rail tool."),
  agentBuiltin(byId("builtin:merge"), "tools"),
  agentBuiltin(byId("builtin:merge-into"), "tools"),
  agentBuiltin(byId("builtin:browser-test"), "tools"),
  {
    ...agentBuiltin(byId("builtin:code-review"), "tools"),
    // Keep the tool body’s default in sync with action:code-review’s
    // rail-step form (no name-tab line). Editing either id is independent
    // on purpose: the Git/card surfaces use action:code-review; the rail
    // tool uses builtin:code-review.
    defaultBody: byId("builtin:code-review").body,
  },
  agentBuiltin(byId("builtin:consolidate-repo"), "tools"),
  agentBuiltin(byId("builtin:reconcile-repo"), "tools"),
];

export function actionPromptById(id: string): ActionPrompt | undefined {
  return ACTION_PROMPTS.find((p) => p.id === id);
}

export function actionPromptsByGroup(): { group: ActionPromptGroup; label: string; prompts: ActionPrompt[] }[] {
  const order: ActionPromptGroup[] = ["git", "cards", "review", "orchestration", "tools"];
  return order
    .map((group) => ({
      group,
      label: groupLabel(group),
      prompts: ACTION_PROMPTS.filter((p) => p.group === group),
    }))
    .filter((g) => g.prompts.length > 0);
}

/// Resolved body for a catalog id, or null when the id is unknown.
export function resolveActionPrompt(
  id: string,
  appOverrides: Record<string, string> | null | undefined,
  workspaceOverrides: Record<string, string> | null | undefined
): string | null {
  const prompt = actionPromptById(id);
  if (!prompt) return null;
  return effectiveBody(id, prompt.defaultBody, appOverrides, workspaceOverrides);
}

/// Patch agent built-in tool bodies from the override maps. Non-agent
/// tools and custom tools pass through unchanged.
export function applyToolBodyOverrides(
  library: Tool[],
  appOverrides: Record<string, string> | null | undefined,
  workspaceOverrides: Record<string, string> | null | undefined
): Tool[] {
  return library.map((tool) => {
    if (tool.kind !== "agent") return tool;
    const prompt = actionPromptById(tool.id);
    if (!prompt) return tool;
    const body = effectiveBody(tool.id, tool.body, appOverrides, workspaceOverrides);
    return body === tool.body ? tool : { ...tool, body };
  });
}

/// Placeholders used in a body that no param declares — editor hint.
export function undeclaredActionPlaceholders(prompt: ActionPrompt, body: string): string[] {
  const declared = new Set(prompt.params.map((p) => p.name));
  return placeholdersIn(body).filter((name) => !declared.has(name));
}

/// Drop blank override values; empty string means “inherit”.
export function pruneOverrides(overrides: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, body] of Object.entries(overrides)) {
    if (typeof body === "string" && body.trim()) out[id] = body;
  }
  return out;
}

/// Write one override (or clear it with null/empty) into a map copy.
export function withOverride(
  overrides: Record<string, string> | null | undefined,
  id: string,
  body: string | null
): Record<string, string> {
  const next = { ...(overrides ?? {}) };
  if (body === null || !body.trim()) delete next[id];
  else next[id] = body;
  return pruneOverrides(next);
}
