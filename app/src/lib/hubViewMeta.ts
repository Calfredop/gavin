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
  /// Offered, but NOT as a tab in the strip -- reached by a button in the
  /// row's actions instead. The view itself is unchanged: it still has an
  /// id the workspace remembers, and switchWorkspaceView still opens it.
  /// This only says the strip is the wrong place to spend a tab on it.
  viaAction?: boolean;
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
  // No requiresRoot: binding the root is one of this view's jobs.
  //
  // viaAction: it is the workspace's own settings, not a view OF the
  // workspace like the eight above -- and it is the one a human opens to
  // change something and then leaves, rather than one they work in. A
  // tab of its own put it in the same rank as Kanban and Git and pushed
  // them all one place left; the gear at the right of the row says the
  // same thing in the place the OS has been putting it for forty years.
  { id: "settings", label: "Settings", viaAction: true },
  { id: "checklist", label: "Checklist", devOnly: true },
];

/// Every hub view a given workspace offers, in the order they render --
/// including the ones reached by a button rather than a tab. This is the
/// "is this view on offer here" question: what resolveHubView may land
/// on, and what the sidebar's recap chips may jump to.
export function visibleHubViewIds(workspaceId: string, isDev: boolean, hasRoot: boolean): string[] {
  return HUB_VIEW_META.filter((v) => hubViewIsVisible(v, workspaceId, isDev, hasRoot)).map((v) => v.id);
}

/// The subset that renders as a tab, in strip order.
///
/// Separate from visibleHubViewIds because the ⌘-digit router addresses
/// tabs BY POSITION: it and the strip have to count the same things, or
/// the badge a tab wears while ⌘ is held opens a different tab.
export function tabStripHubViewIds(workspaceId: string, isDev: boolean, hasRoot: boolean): string[] {
  return HUB_VIEW_META.filter(
    (v) => !v.viaAction && hubViewIsVisible(v, workspaceId, isDev, hasRoot)
  ).map((v) => v.id);
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
