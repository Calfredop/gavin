import type { Component } from "svelte";
import { LayoutDashboard, Kanban, FileText, Bot, FolderTree, Files, Settings, GitBranch, Waypoints, Wrench, ScanEye } from "@lucide/svelte";
import HomeHubView from "$lib/hub/HomeHubView.svelte";
import GitHubView from "$lib/GitHubView.svelte";
import SettingsHubView from "$lib/SettingsHubView.svelte";
import KanbanBoard from "$lib/board/KanbanBoard.svelte";
import OrchestrationHubView from "$lib/OrchestrationHubView.svelte";
import WorkspaceToolsHubView from "$lib/WorkspaceToolsHubView.svelte";
import ReviewHubView from "$lib/review/ReviewHubView.svelte";
import PrdHubView from "$lib/files/PrdHubView.svelte";
import AgentFileHubView from "$lib/files/AgentFileHubView.svelte";
import PlanExplorerHubView from "$lib/files/PlanExplorerHubView.svelte";
import FilesHubView from "$lib/files/FilesHubView.svelte";
import {
  HUB_VIEW_META,
  NO_HUB_TAB_PREFS,
  tabStripHubViewIds,
  visibleHubViewIds,
  type HubTabPrefs,
  type HubViewMeta,
} from "$lib/hub/hubViewMeta";

/// A hub tab: the metadata from hubViewMeta.ts plus what renders it.
/// The id/label/visibility rules live there so modules that only need
/// the policy (the keyboard router) don't import eight components.
export interface HubView extends HubViewMeta {
  icon: Component;
  component: Component<{ workspaceId: string }>;
}

// Keyed by the metadata's own ids: a typo, or a new id added to
// HUB_VIEW_META without a component, is then a compile error rather than
// an undefined spread that crashes at render.
type HubViewId = (typeof HUB_VIEW_META)[number]["id"];

const COMPONENTS: Record<HubViewId, { icon: Component; component: Component<{ workspaceId: string }> }> = {
  home: { icon: LayoutDashboard, component: HomeHubView },
  git: { icon: GitBranch, component: GitHubView },
  kanban: { icon: Kanban, component: KanbanBoard },
  orchestration: { icon: Waypoints, component: OrchestrationHubView },
  tools: { icon: Wrench, component: WorkspaceToolsHubView },
  review: { icon: ScanEye, component: ReviewHubView },
  prd: { icon: FileText, component: PrdHubView },
  "agent-file": { icon: Bot, component: AgentFileHubView },
  plans: { icon: FolderTree, component: PlanExplorerHubView },
  files: { icon: Files, component: FilesHubView },
  settings: { icon: Settings, component: SettingsHubView },
};

// Built by mapping the metadata in order, and filtered below by the very
// id set the keyboard router uses -- that shared derivation is what
// keeps a "3" badge and ⌘3 pointing at the same tab. (Not covered by a
// test: asserting it would mean importing this module, and its eight
// components, into a unit test.)
export const HUB_VIEWS: HubView[] = HUB_VIEW_META.map((meta) => ({ ...meta, ...COMPONENTS[meta.id] }));

// The hub tabs a given workspace should offer, in the order they render.
// A view that needs a bound root is not offered to a workspace without
// one -- callers must render from this, not from HUB_VIEWS directly.
export function visibleHubViews(hasRoot: boolean): HubView[] {
  const visible = new Set(visibleHubViewIds(hasRoot));
  return HUB_VIEWS.filter((v) => visible.has(v.id));
}

// The ones that render as a tab, in the order the strip draws them. The
// rest are still offered -- they are in visibleHubViews,
// switchWorkspaceView opens them, and a workspace remembers landing on
// one -- they are just reached by a button in the row's actions instead
// of by a tab of their own.
//
// Built by mapping the id list rather than by filtering HUB_VIEWS, unlike
// visibleHubViews above: the human's own order lives in that list, and
// filtering the declaration order would throw it away.
export function tabStripHubViews(hasRoot: boolean, prefs: HubTabPrefs = NO_HUB_TAB_PREFS): HubView[] {
  const byId = new Map(HUB_VIEWS.map((v) => [v.id, v]));
  return tabStripHubViewIds(hasRoot, prefs)
    .map((id) => byId.get(id))
    .filter((v): v is HubView => v !== undefined);
}
