import type { Component } from "svelte";
import { LayoutDashboard, Kanban, ListChecks, FileText, Bot, FolderTree, Settings } from "@lucide/svelte";
import HomeHubView from "./HomeHubView.svelte";
import SettingsHubView from "./SettingsHubView.svelte";
import KanbanBoard from "./KanbanBoard.svelte";
import SmokeChecklist from "./SmokeChecklist.svelte";
import PrdHubView from "./PrdHubView.svelte";
import AgentFileHubView from "./AgentFileHubView.svelte";
import PlanExplorerHubView from "./PlanExplorerHubView.svelte";
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
  { id: "home", label: "Home", icon: LayoutDashboard, component: HomeHubView, requiresRoot: true },
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
    id: "plans",
    label: "Plans",
    icon: FolderTree,
    component: PlanExplorerHubView,
    requiresRoot: true,
  },
  {
    // No requiresRoot: binding the root is one of this tab's jobs.
    id: "settings",
    label: "Settings",
    icon: Settings,
    component: SettingsHubView,
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
