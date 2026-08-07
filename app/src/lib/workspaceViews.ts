import type { Component } from "svelte";
import { Kanban, ListChecks } from "@lucide/svelte";
import KanbanBoard from "./KanbanBoard.svelte";
import SmokeChecklist from "./SmokeChecklist.svelte";
import { showsDevOnlyViews } from "./workspace";

export interface HubView {
  id: string;
  label: string;
  icon: Component;
  component: Component<{ workspaceId: string }>;
  /// Only offered in dev builds, and only in the Smoke Test workspace --
  /// see visibleHubViews.
  devOnly?: boolean;
}

export const HUB_VIEWS: HubView[] = [
  { id: "kanban", label: "Kanban", icon: Kanban, component: KanbanBoard },
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
export function visibleHubViews(workspaceId: string, isDev: boolean): HubView[] {
  return HUB_VIEWS.filter((v) => !v.devOnly || showsDevOnlyViews(workspaceId, isDev));
}
