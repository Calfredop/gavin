// Which hub tabs a workspace offers, as data. Component-free on purpose:
// workspaceViews.ts binds these ids to Svelte components, so anything
// that only needs the POLICY (the keyboard router, its tests) can import
// this without pulling in the whole component graph.
import { hubViewIsVisible } from "./workspace";

export interface HubViewMeta {
  id: string;
  label: string;
  /// Only offered in dev builds, and only in the Smoke Test workspace.
  devOnly?: boolean;
  /// Only offered once the workspace is bound to a root folder: these
  /// views edit files that live under it.
  requiresRoot?: boolean;
}

export const HUB_VIEW_META: HubViewMeta[] = [
  { id: "home", label: "Home", requiresRoot: true },
  { id: "git", label: "Git", requiresRoot: true },
  { id: "kanban", label: "Kanban" },
  { id: "prd", label: "PRD", requiresRoot: true },
  { id: "agent-file", label: "CLAUDE.md", requiresRoot: true },
  { id: "plans", label: "Plans", requiresRoot: true },
  // No requiresRoot: binding the root is one of this tab's jobs.
  { id: "settings", label: "Settings" },
  { id: "checklist", label: "Checklist", devOnly: true },
];

/// The hub tab ids a given workspace offers, in the order they render.
export function visibleHubViewIds(workspaceId: string, isDev: boolean, hasRoot: boolean): string[] {
  return HUB_VIEW_META.filter((v) => hubViewIsVisible(v, workspaceId, isDev, hasRoot)).map((v) => v.id);
}
