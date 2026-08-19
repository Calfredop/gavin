import type { Component } from "svelte";
import { Kanban, ListChecks, FileText, Bot } from "@lucide/svelte";
import KanbanBoard from "./KanbanBoard.svelte";
import SmokeChecklist from "./SmokeChecklist.svelte";
import PrdHubView from "./PrdHubView.svelte";
import AgentFileHubView from "./AgentFileHubView.svelte";
import { hubViewIsVisible } from "./workspace";

export interface HubView {
  id: string;
  label: string;
  icon: Component;
  component: Component<{ workspaceId: string }>;
  /// Only offered in dev builds, and only in the Smoke Test workspace --
  /// see visibleHubViews.
  devOnly?: boolean;
  /// Only offered once the workspace is bound to a root folder: these
  /// views edit files that live under it.
  requiresRoot?: boolean;
}

export const HUB_VIEWS: HubView[] = [
  { id: "kanban", label: "Kanban", icon: Kanban, component: KanbanBoard },
  { id: "prd", label: "PRD", icon: FileText, component: PrdHubView, requiresRoot: true },
  {
    id: "agent-file",
    label: "CLAUDE.md",
    icon: Bot,
    component: AgentFileHubView,
    requiresRoot: true,
  },
  {
    id: "checklist",
    label: "Checklist",
    icon: ListChecks,
    component: SmokeChecklist,
    devOnly: true,
  },
];

// The hub tabs a given workspace should offer. A dev-only view is hidden
// everywhere except the dev Smoke Test workspace, so a release build (or
// any real workspace) never shows it -- callers must render from this,
// not from HUB_VIEWS directly.
export function visibleHubViews(workspaceId: string, isDev: boolean, hasRoot: boolean): HubView[] {
  return HUB_VIEWS.filter((v) => hubViewIsVisible(v, workspaceId, isDev, hasRoot));
}
