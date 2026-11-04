// Where a view a tab opens lands, and what its chip does when pressed
// (ADR 0013, CONTEXT.md "Attached view" / "Tab group").
//
// A terminal tab's views of its own work -- its card's plan, its run's
// changes, its follow-ups, its browser, a file it named, its context's
// board -- are that tab's Attached views: one side pane inside the tab's
// own pane, drawn only while the tab is in front. They used to split the
// WHOLE pane, so the diff opened from tab (a) sat beside every tab in
// it, and switching to (b) left (a)'s diff on screen.
//
// Pure, over the layout tree and the three tab maps, so the opens in
// layoutState.ts and the chips in Pane.svelte ask one place.

import type { BoardTab, CardTab } from "$lib/core/gavin";
import * as layout from "$lib/panes/layout";
import type { LayoutNode, Leaf } from "$lib/panes/layout";
import { isViewTab, type TabMaps } from "$lib/panes/tabIdentity";

/// What an open is OF -- enough to tell "the same thing" apart, which is
/// what bringing an open view forward instead of opening a second one
/// needs. A card subject covers the plan, the changes, the follow-ups and
/// the browser (`CardTab.view` says which), keyed exactly as the tab maps
/// key them.
export type ViewSubject =
  | { kind: "card"; tab: CardTab }
  | { kind: "file"; path: string }
  | { kind: "board"; tab: BoardTab };

/// Whether tab `id` shows `subject`, read off the maps that classify it.
export function showsSubject(id: string, subject: ViewSubject, maps: TabMaps): boolean {
  switch (subject.kind) {
    case "card": {
      const open = maps.cardTabsById[id];
      return (
        open !== undefined &&
        open.workspaceId === subject.tab.workspaceId &&
        open.path === subject.tab.path &&
        open.view === subject.tab.view &&
        open.sessionId === subject.tab.sessionId
      );
    }
    case "file":
      return maps.fileTabsById[id]?.path === subject.path;
    case "board": {
      const open = maps.boardTabsById[id];
      return (
        open !== undefined &&
        open.workspaceId === subject.tab.workspaceId &&
        open.contextFolder === subject.tab.contextFolder
      );
    }
  }
}

/// Where an open lands.
///
/// - `attach`: into `ownerId`'s Tab group. `existingId` is a view of the
///   same subject already in that group, to bring forward rather than
///   open twice -- looked for in the group alone, not across the page.
/// - `split`: beside `anchorId` as a page-level split, which is how
///   every view opened before groups. Only for an anchor that is itself
///   an ordinary view tab (a file or board tab in the page tree): a view
///   cannot own views, and terminals are the only owners. `existingId`
///   keeps that path's old de-duplication -- a card view already on the
///   page -- so the fallback is exactly what it was.
export type OpenPlacement =
  | { kind: "attach"; ownerId: string; existingId: string | null }
  | { kind: "split"; anchorId: string; existingId: string | null };

/// Null when `anchorId` is nowhere in `tree`: there is nothing to open
/// beside. An anchor that is an Attached view stands for its group's
/// owner, so a view opened from inside a group -- Show plan, pressed
/// while the diff has the focus -- joins the same group.
export function placeViewOpen(
  tree: LayoutNode,
  anchorId: string,
  subject: ViewSubject,
  maps: TabMaps
): OpenPlacement | null {
  const path = layout.findLeafPath(tree, anchorId);
  if (!path) return null;
  const leaf = layout.getNodeAtPath(tree, path) as Leaf;
  const ownerId = layout.attachedOwner(leaf, anchorId) ?? anchorId;
  if (isViewTab(ownerId, maps)) {
    const existingId =
      subject.kind === "card"
        ? (layout.allTabIds(tree).find((id) => showsSubject(id, subject, maps)) ?? null)
        : null;
    return { kind: "split", anchorId, existingId };
  }
  const group = layout.attachedGroup(leaf, ownerId);
  const existingId = group?.tabs.find((id) => showsSubject(id, subject, maps)) ?? null;
  return { kind: "attach", ownerId, existingId };
}

/// The view of `subject` open in `ownerId`'s group, or null -- what lights
/// a chip. Only the group: a view dragged out of it is an ordinary tab now,
/// and no longer the chip's.
export function openViewOf(
  tree: LayoutNode | null,
  ownerId: string,
  subject: ViewSubject,
  maps: TabMaps
): string | null {
  if (!tree) return null;
  const path = layout.findLeafPath(tree, ownerId);
  if (!path) return null;
  const group = layout.attachedGroup(layout.getNodeAtPath(tree, path) as Leaf, ownerId);
  return group?.tabs.find((id) => showsSubject(id, subject, maps)) ?? null;
}

/// What pressing a chip does. A chip toggles its view: pressed while that
/// view is in front -- its owner the pane's active tab, and the view the
/// front tab of the side strip -- it closes the view; pressed otherwise it
/// opens the view, or brings an open one forward.
export type ChipPress = { kind: "close"; viewId: string } | { kind: "open" };

export function chipPress(
  tree: LayoutNode | null,
  ownerId: string,
  subject: ViewSubject,
  maps: TabMaps
): ChipPress {
  if (!tree) return { kind: "open" };
  const path = layout.findLeafPath(tree, ownerId);
  if (!path) return { kind: "open" };
  const leaf = layout.getNodeAtPath(tree, path) as Leaf;
  if (layout.activeSessionId(leaf) !== ownerId) return { kind: "open" };
  const group = layout.attachedGroup(leaf, ownerId);
  const front = group?.tabs[group.activeTabIndex];
  return front !== undefined && showsSubject(front, subject, maps)
    ? { kind: "close", viewId: front }
    : { kind: "open" };
}

/// The tab a hub tab's "open beside" anchors to, from where the focus
/// sits: a terminal tab, or the owner of the Attached view the focus is
/// on -- a view opened from inside a group joins it. Null for a focus on
/// an ordinary view tab, or none: the caller then has no pane to open
/// beside and falls back (to the OS, or to no button at all).
export function openAnchorFor(focused: string | null, tree: LayoutNode | null, maps: TabMaps): string | null {
  if (!focused) return null;
  const owner = (tree ? layout.ownerOfAttached(tree, focused) : null) ?? focused;
  return isViewTab(owner, maps) ? null : owner;
}

/// The marker on an owner's tab: its views, by label, in strip order --
/// "Plan · Changes". Null for a tab with none, which draws no marker.
export function groupTooltip(leaf: Leaf, ownerId: string, labelOf: (id: string) => string): string | null {
  const group = layout.attachedGroup(leaf, ownerId);
  if (!group) return null;
  return group.tabs.map(labelOf).join(" · ");
}

/// What a pane draws beside its active tab: that tab's group -- its strip,
/// the view in front and the side pane's width -- or null for a tab with
/// none, which fills the pane alone.
export interface SidePane {
  ownerId: string;
  views: string[];
  front: string;
  size: number;
}

export function sidePaneFor(leaf: Leaf): SidePane | null {
  const ownerId = layout.activeSessionId(leaf);
  const group = ownerId === undefined ? null : layout.attachedGroup(leaf, ownerId);
  if (!group) return null;
  return { ownerId, views: group.tabs, front: group.tabs[group.activeTabIndex], size: group.size };
}

/// Every Attached view in the pane, with its owner. Each stays mounted
/// while its owner is not in front, the way an inactive tab does, so a
/// diff comes back scrolled where it was left.
export function attachedViewsIn(leaf: Leaf): { id: string; ownerId: string }[] {
  return leaf.tabs.flatMap((ownerId) =>
    (layout.attachedGroup(leaf, ownerId)?.tabs ?? []).map((id) => ({ id, ownerId }))
  );
}

/// Where a drag of the side pane's divider puts it: the side pane's share
/// of the pane body, measured from the body's right edge. Clamped by
/// layout.resizeAttached when it is stored.
export function sideShareAt(body: { left: number; width: number }, clientX: number): number {
  if (body.width <= 0) return layout.ATTACHED_DEFAULT_SIZE;
  return (body.left + body.width - clientX) / body.width;
}

/// The subjects the tab bar's chips toggle, built in one place so a chip's
/// light (openViewOf) and its press (chipPress) can never disagree about
/// what "its view" is. Keyed exactly as the opens record them.
export function cardSubject(
  workspaceId: string,
  path: string,
  view: CardTab["view"],
  sessionId?: string
): ViewSubject {
  return { kind: "card", tab: sessionId === undefined ? { workspaceId, path, view } : { workspaceId, path, view, sessionId } };
}

export function boardSubject(workspaceId: string, contextFolder: string): ViewSubject {
  return { kind: "board", tab: { workspaceId, contextFolder } };
}
