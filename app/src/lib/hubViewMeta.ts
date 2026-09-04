// Which hub tabs a workspace offers, as data. Component-free on purpose:
// workspaceViews.ts binds these ids to Svelte components, so anything
// that only needs the POLICY (the keyboard router, its tests) can import
// this without pulling in the whole component graph.
import { hubViewIsVisible, type Workspace } from "./workspace";

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
  { id: "orchestration", label: "Orchestration", requiresRoot: true },
  { id: "prd", label: "PRD", requiresRoot: true },
  { id: "agent-file", label: "CLAUDE.md", requiresRoot: true },
  { id: "plans", label: "Plans", requiresRoot: true },
  { id: "files", label: "Files", requiresRoot: true },
  // No requiresRoot: binding the root is one of this tab's jobs.
  { id: "settings", label: "Settings" },
  { id: "checklist", label: "Checklist", devOnly: true },
];

/// The hub tab ids a given workspace offers, in the order they render.
export function visibleHubViewIds(workspaceId: string, isDev: boolean, hasRoot: boolean): string[] {
  return HUB_VIEW_META.filter((v) => hubViewIsVisible(v, workspaceId, isDev, hasRoot)).map((v) => v.id);
}

/// What a hub tab can be busy WITH. One field today -- the Git tab's
/// hidden commit agent -- but shaped as a bag so the next background run
/// that wants a tab to say so adds a field rather than a second
/// mechanism.
export interface HubViewActivity {
  /// A "Commit via agent" run in flight in this workspace.
  committing: boolean;
  /// A rail in this workspace has a running step waiting on a HUMAN --
  /// an agent asking a question, or one whose turn ended without its card
  /// reaching the done column (see stepAttentions).
  railsWantingAttention: boolean;
}

/// Whether this tab should say, from the tab strip, that something it
/// owns is running right now. A hidden run has no tab and no window of
/// its own, so the tab that launched it is the only place the app can
/// admit it exists while the human is looking at some other tab.
export function hubViewBusy(viewId: string, activity: HubViewActivity): boolean {
  return viewId === "git" && activity.committing;
}

/// Whether this tab should say, from the tab strip, that something it
/// owns is waiting on the HUMAN. A separate axis from `hubViewBusy` on
/// purpose, and never collapsed into it: a spinner says gavin is doing
/// something, a mark says you have to. A rail can be both at once.
export function hubViewAttention(viewId: string, activity: HubViewActivity): boolean {
  return viewId === "orchestration" && activity.railsWantingAttention;
}

/// The hub tab to land on when a workspace's Hub button is clicked: the
/// one it was last showing, or -- when nothing is remembered, or the
/// remembered tab is no longer offered (its root was unbound, a dev-only
/// tab in a release build) -- the first tab it does offer.
export function resolveHubView(ws: Workspace, isDev: boolean): string {
  const ids = visibleHubViewIds(ws.id, isDev, Boolean(ws.rootPath));
  return ws.hubView && ids.includes(ws.hubView) ? ws.hubView : ids[0];
}
