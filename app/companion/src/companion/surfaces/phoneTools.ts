// What the phone's Tools surface says about each of a workspace's tools:
// which block of the library it is in, what it is, how its last run went,
// and whether Run can start it. Pure -- the surface draws it,
// `state/tools.ts` acts on it.
//
// Every rule is the desk's Tools tab's (`workspaceTools.ts`): the order
// (`listedTools`), the search (`matchesToolSearch`), why Run is dark
// (`runBlockedReason`) and what a run's outcome means (`toolRunChip`,
// `toolRunSentence`), so a tool says the same thing on the phone as at the
// desk. The badge's glyph is looked up in the view, as at the desk: the
// indicators module carries the icon library with it.
import type { DaemonCompat } from "$lib/core/daemonCompat";
import { toolKindLabel, type Tool, type ToolParam, type ToolScope } from "$lib/orchestration/orchestrationTools";
import {
  isRunOpen,
  listedTools,
  matchesToolSearch,
  runBlockedReason,
  toolCwdLabel,
  toolRunChip,
  toolRunSentence,
  type ToolRun,
} from "$lib/workspace/workspaceTools";

export interface ToolRow {
  id: string;
  name: string;
  description: string;
  /// The kind, in the words the desk's library dialog uses for it.
  kindLabel: string;
  /// Where the tool runs, as the human typed it; null at the root.
  cwd: string | null;
  params: ToolParam[];
  /// What it runs: the prompt, the command line or the script.
  body: string;
  /// The last run, or null for a tool never run.
  run: {
    run: ToolRun;
    /// "passed · 4m ago".
    chip: string;
    /// What became of it, in a sentence.
    sentence: string;
    /// Still going: Run is dark, and its session is the place to look.
    open: boolean;
  } | null;
  /// Why Run cannot start it now, or null when it can.
  blocked: string | null;
}

export interface ToolGroup {
  scope: ToolScope;
  title: string;
  rows: ToolRow[];
}

const GROUP_TITLES: Record<ToolScope, string> = {
  workspace: "This workspace",
  global: "All workspaces",
  builtin: "Built-in",
};

export interface ToolRowsInput {
  library: Tool[];
  lastRuns: Map<string, ToolRun>;
  search: string;
  compat: DaemonCompat | null;
  rootPath: string | null;
  nowMs: number;
}

/// One row per tool, in the desk's order: this workspace's own first,
/// then global, then the built-ins. Every kind is listed, the ones that
/// only mean something on a rail with Run dark and the reason on the row.
export function toolRows(input: ToolRowsInput): ToolRow[] {
  return listedTools(input.library)
    .filter((tool) => matchesToolSearch(tool, input.search))
    .map((tool) => {
      const last = input.lastRuns.get(tool.id);
      return {
        id: tool.id,
        name: tool.name,
        description: tool.description,
        kindLabel: toolKindLabel(tool.kind),
        cwd: toolCwdLabel(tool),
        params: tool.params,
        body: tool.body,
        run: last
          ? {
              run: last,
              chip: toolRunChip(last, input.nowMs) ?? "",
              sentence: toolRunSentence(last),
              open: isRunOpen(last),
            }
          : null,
        blocked: runBlockedReason({
          compat: input.compat,
          rootPath: input.rootPath,
          tool,
          lastRun: last,
          // The Workstation's operating system is the desk's to know; a
          // phone cannot tell it, which blocks nothing, and a tool that
          // cannot run there is refused by the launch.
          platform: null,
        }),
      };
    });
}

/// The rows under the block of the library each belongs to, in order,
/// leaving out a block with nothing in it.
export function toolGroups(input: ToolRowsInput): ToolGroup[] {
  const scopeOf = new Map(input.library.map((t) => [t.id, t.scope]));
  const groups: ToolGroup[] = [];
  for (const row of toolRows(input)) {
    const scope = scopeOf.get(row.id) ?? "builtin";
    const last = groups[groups.length - 1];
    if (last?.scope === scope) last.rows.push(row);
    else groups.push({ scope, title: GROUP_TITLES[scope], rows: [row] });
  }
  return groups;
}

/// What the surface says when there is nothing to list.
export function toolsEmptyLine(search: string): string {
  return search.trim()
    ? `No tool matches “${search.trim()}”.`
    : "This workspace has no tools. New ones are written at the desk, on its Tools tab.";
}

/// The values a Run starts with: each parameter's default, then whatever
/// the human typed over it.
export function seededValues(params: ToolParam[], typed: Record<string, string>): Record<string, string> {
  return Object.fromEntries(params.map((p) => [p.name, typed[p.name] ?? p.default]));
}
