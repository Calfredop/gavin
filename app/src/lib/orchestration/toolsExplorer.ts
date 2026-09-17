// Pure list/selection helpers for the Plans-like Tools explorer: the
// full tool library plus action prompts that are not already a tool
// body. Persistence stays in actionPromptsState / toolsState.

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
import { listedTools } from "$lib/workspace/workspaceTools";

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

/// Action prompts that are NOT also a built-in tool body — those already
/// appear in the tools list under their builtin: id.
export function promptListItems(
  appOverrides: Record<string, string> | null | undefined,
  workspaceOverrides: Record<string, string> | null | undefined,
  query: string
): { groupLabel: string; items: PromptListItem[] }[] {
  return actionPromptsByGroup()
    .map(({ label, prompts }) => ({
      groupLabel: label,
      items: prompts
        .filter((p) => !p.toolId)
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

/// Every tool the library offers here: workspace → global → builtin order
/// (listedTools), filtered to global-only in app settings.
export function toolsForExplorer(
  library: Tool[],
  scope: ExplorerScope,
  query: string
): ToolListItem[] {
  const base = listedTools(library).filter((t) =>
    scope === "app" ? t.scope === "global" || t.scope === "builtin" : true
  );
  return base
    .filter((t) => matchesExplorerSearch(`${t.name} ${t.description} ${t.kind}`, query))
    .map((t) => ({
      kind: "tool" as const,
      id: t.id,
      name: t.name,
      description: t.description,
      scopeLabel:
        t.scope === "builtin"
          ? "Built-in"
          : t.scope === "global"
            ? "All workspaces"
            : "This workspace",
      tool: t,
    }));
}

/// @deprecated use toolsForExplorer — kept for older tests that only
/// wanted custom rows.
export function editableToolsFor(
  library: Tool[],
  scope: ExplorerScope,
  query: string
): ToolListItem[] {
  return toolsForExplorer(library, scope, query).filter((t) => !isBuiltinId(t.id));
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

/// Whether this tool's body is stored as an action-prompt override
/// (built-in agent templates) rather than a daemon tool row.
export function toolBodyIsPromptOverride(tool: Pick<Tool, "id" | "scope">): boolean {
  return tool.scope === "builtin" && Boolean(actionPromptById(tool.id));
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
