// Pure list/selection helpers for the Plans-like Tools explorer: action
// prompts plus editable custom tools. Persistence stays in
// actionPromptsState / toolsState.

import {
  ACTION_PROMPTS,
  actionPromptById,
  actionPromptsByGroup,
  bodySource,
  undeclaredActionPlaceholders,
  type ActionPrompt,
  type ActionPromptSource,
} from "$lib/agents/actionPrompts";
import type { Tool } from "$lib/orchestration/orchestrationTools";
import { isBuiltinId } from "$lib/orchestration/orchestrationTools";

export type ExplorerScope = "workspace" | "app";

export type ExplorerSelection =
  | { kind: "prompt"; id: string }
  | { kind: "tool"; id: string };

export interface PromptListItem {
  kind: "prompt";
  id: string;
  name: string;
  description: string;
  groupLabel: string;
  source: ActionPromptSource;
}

export interface ToolListItem {
  kind: "tool";
  id: string;
  name: string;
  description: string;
  scopeLabel: string;
  tool: Tool;
}

export function matchesExplorerSearch(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return haystack.toLowerCase().includes(q);
}

export function promptListItems(
  appOverrides: Record<string, string> | null | undefined,
  workspaceOverrides: Record<string, string> | null | undefined,
  query: string
): { groupLabel: string; items: PromptListItem[] }[] {
  return actionPromptsByGroup()
    .map(({ label, prompts }) => ({
      groupLabel: label,
      items: prompts
        .filter((p) =>
          matchesExplorerSearch(`${p.name} ${p.description} ${p.id}`, query)
        )
        .map((p) => ({
          kind: "prompt" as const,
          id: p.id,
          name: p.name,
          description: p.description,
          groupLabel: label,
          source: bodySource(p.id, appOverrides, workspaceOverrides),
        })),
    }))
    .filter((g) => g.items.length > 0);
}

/// Custom tools the explorer may edit inline. Built-ins are edited via
/// their action-prompt catalog entry (agent ones) or Duplicate (others).
export function editableToolsFor(
  library: Tool[],
  scope: ExplorerScope,
  query: string
): ToolListItem[] {
  return library
    .filter((t) => !isBuiltinId(t.id))
    .filter((t) => (scope === "app" ? t.scope === "global" : true))
    .filter((t) => matchesExplorerSearch(`${t.name} ${t.description} ${t.kind}`, query))
    .map((t) => ({
      kind: "tool" as const,
      id: t.id,
      name: t.name,
      description: t.description,
      scopeLabel: t.scope === "global" ? "All workspaces" : "This workspace",
      tool: t,
    }));
}

export function sourceLabel(source: ActionPromptSource, scope: ExplorerScope): string {
  switch (source) {
    case "workspace":
      return "Customized for this workspace";
    case "app":
      return scope === "app" ? "Customized" : "Using app default";
    case "default":
      return "Shipped default";
  }
}

export function promptEditorHint(prompt: ActionPrompt, body: string): string | null {
  const undeclared = undeclaredActionPlaceholders(prompt, body);
  if (undeclared.length === 0) return null;
  return `Unknown placeholders: ${undeclared.map((n) => `{{${n}}}`).join(", ")}`;
}

export function selectionStillValid(
  selection: ExplorerSelection | null,
  promptIds: Set<string>,
  toolIds: Set<string>
): boolean {
  if (!selection) return true;
  if (selection.kind === "prompt") return promptIds.has(selection.id);
  return toolIds.has(selection.id);
}

export { ACTION_PROMPTS, actionPromptById };
