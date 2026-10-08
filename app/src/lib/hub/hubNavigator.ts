// The hub navigator: the narrow column of shortcuts a workspace shows
// beside a page, so a person parked on a terminal can reach any of the
// hub's sections without finding the Hub button in the sidebar first.
//
// Component-free for the reason hubViewMeta.ts is: the policy (which
// sections, in what order, called what) is testable without importing
// the eight components the hub's views are bound to.
import {
  tabStripHubViewIds,
  visibleHubViewIds,
  NO_HUB_TAB_PREFS,
  type HubTabPrefs,
} from "$lib/hub/hubViewMeta";

/// The sections the navigator offers, in the order it draws them.
///
/// The strip's own list -- the same hidden set and the same dragged
/// order -- so the column and the row it stands in for can never
/// disagree about what the hub contains. Settings follows: it has no tab
/// (the hub reaches it by a gear), but it is a section a person wants a
/// shortcut to just as much.
export function hubNavigatorViewIds(hasRoot: boolean, prefs: HubTabPrefs = NO_HUB_TAB_PREFS): string[] {
  const ids = tabStripHubViewIds(hasRoot, prefs);
  return visibleHubViewIds(hasRoot).includes("settings") && !ids.includes("settings")
    ? [...ids, "settings"]
    : ids;
}

/// What a navigator button is called, for its tooltip and its aria-label.
/// Settings keeps the name the hub's gear gives it, because "Settings"
/// alone beside a page reads as the app's.
export function hubNavigatorLabel(view: { id: string; label: string }, agentFileName: string): string {
  if (view.id === "settings") return "Workspace settings";
  return view.id === "agent-file" ? agentFileName : view.label;
}
