// The Kanban, Review and Plans tabs' shared facet lens: by default all
// three narrow their cards by the same context/kind/rail answer
// (boardFilters.ts's BoardFacets), and changing it in one tab moves the
// other two. A tab can unlink to answer the three questions on its own;
// linking again rejoins the group at whatever it currently reads.
//
// A module-level store rather than component `$state`: `+page.svelte`
// renders one hub view at a time and destroys the rest on every tab
// switch (see PlanExplorerHubView's own note on the same trap), so a
// filter that lived in a tab's `$state` would forget itself -- and its
// link to the other two -- on every switch away and back. Because only
// one of the three tabs is ever mounted, "changing one tab's filter
// updates the others" does not need any live cross-component wiring: the
// unmounted tabs simply read the current store when they are next shown.

import { writable } from "svelte/store";
import { emptyFacets, type BoardFacets } from "$lib/board/boardFilters";

/// The three tabs that answer context/kind/rail the same way.
export const HUB_FACET_TABS = ["kanban", "review", "plans"] as const;
export type HubFacetTab = (typeof HUB_FACET_TABS)[number];

export interface WorkspaceHubFacets {
  /// What every LINKED tab reads and writes.
  shared: BoardFacets;
  /// True for a tab following `shared`. All three start linked -- the
  /// feature this state exists for is one filter, not three that happen
  /// to start equal.
  linked: Record<HubFacetTab, boolean>;
  /// An unlinked tab's own answer, seeded from `shared` at the moment it
  /// unlinked (see `setTabLinked`). Absent for a tab that has never
  /// unlinked, which is a different thing from NO_FACETS: it means "ask
  /// `shared` instead", not "this tab has cleared its filters".
  own: Partial<Record<HubFacetTab, BoardFacets>>;
}

function emptyWorkspace(): WorkspaceHubFacets {
  return {
    shared: emptyFacets(),
    linked: { kanban: true, review: true, plans: true },
    own: {},
  };
}

export const hubFacetState = writable<Record<string, WorkspaceHubFacets>>({});

/// The facets a tab should filter by right now -- `shared` while linked,
/// its own frozen answer otherwise. Takes the workspace's stored state
/// directly (typically `$hubFacetState[workspaceId]`) so a component
/// reads it inside its own `$derived` rather than through a store
/// subscription this module would have to manage itself.
export function facetsFor(state: WorkspaceHubFacets | undefined, tab: HubFacetTab): BoardFacets {
  const ws = state ?? emptyWorkspace();
  return ws.linked[tab] ? ws.shared : (ws.own[tab] ?? ws.shared);
}

export function isTabLinked(state: WorkspaceHubFacets | undefined, tab: HubFacetTab): boolean {
  return (state ?? emptyWorkspace()).linked[tab];
}

/// A change from one tab's dropdowns: writes `shared` -- and so every
/// other linked tab -- while linked, or only this tab's own answer while
/// not.
export function setTabFacets(workspaceId: string, tab: HubFacetTab, facets: BoardFacets): void {
  hubFacetState.update((all) => {
    const ws = all[workspaceId] ?? emptyWorkspace();
    const next: WorkspaceHubFacets = ws.linked[tab]
      ? { ...ws, shared: facets }
      : { ...ws, own: { ...ws.own, [tab]: facets } };
    return { ...all, [workspaceId]: next };
  });
}

/// The link toggle. Unlinking freezes the tab's CURRENT reading (whatever
/// `shared` says right now) as its own, so the tab does not change under
/// the human the instant they click it. Relinking drops that own answer
/// and rejoins the group at whatever `shared` reads then -- there is no
/// single correct blend of two tabs' independently-edited filters, so
/// rejoining takes the group's answer over the tab's former one.
export function setTabLinked(workspaceId: string, tab: HubFacetTab, linked: boolean): void {
  hubFacetState.update((all) => {
    const ws = all[workspaceId] ?? emptyWorkspace();
    if (ws.linked[tab] === linked) return all;
    const next: WorkspaceHubFacets = linked
      ? { ...ws, linked: { ...ws.linked, [tab]: true } }
      : { ...ws, linked: { ...ws.linked, [tab]: false }, own: { ...ws.own, [tab]: ws.shared } };
    return { ...all, [workspaceId]: next };
  });
}

/// What the tab's own Reset button calls, alongside clearing its search:
/// the facets clear through the same linked/unlinked routing as any
/// other edit, rather than being special-cased to always touch `shared`.
export function resetTabFacets(workspaceId: string, tab: HubFacetTab): void {
  setTabFacets(workspaceId, tab, emptyFacets());
}
