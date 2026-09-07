// The collapsed sidebar's temporary full width: press a row on the icon
// rail and the column opens over the content until the pointer leaves
// it again.
//
// Deliberately NOT a second persisted preference beside sidebarPrefs'
// collapse flag. A peek is a gesture, not a state the human chose: it
// answers "which page is that?" without spending a click on collapsing
// and another on collapsing back, and it must never be what a window
// reopens in. So it lives only in memory, and every route out of the
// collapsed rail -- expanding it for real, the pointer leaving, a click
// landing anywhere else -- ends it.
//
// It OVERLAYS rather than widening the column in flow. The whole reason
// the rail collapses is to give the view beside it the width; a peek
// that pushed the content across would resize every terminal in the
// window twice per glance (xterm refits on every width change), which
// is a lot of work to undo a moment later.

import { writable } from "svelte/store";

/// Whether the collapsed column is currently showing itself in full.
/// Meaningless while the sidebar is expanded -- `sidebarShowsRail` and
/// `sidebarShowsFull` below are what every surface asks instead of
/// combining the two flags itself.
export const sidebarPeek = writable<boolean>(false);

export function peekSidebar(): void {
  sidebarPeek.set(true);
}

export function endSidebarPeek(): void {
  sidebarPeek.set(false);
}

/// The column is drawing its icon rail: collapsed, and not peeking.
/// This is what picks initials over names, glyphs over labels.
export function sidebarShowsRail(collapsed: boolean, peeking: boolean): boolean {
  return collapsed && !peeking;
}

/// The column is drawing its full contents -- either because it is open,
/// or because a press on the rail floated it over the view. The search
/// row, the workspace names and the page tree all key off this rather
/// than off `collapsed`, so a peek is the same sidebar rather than a
/// third rendering of it.
export function sidebarShowsFull(collapsed: boolean, peeking: boolean): boolean {
  return !sidebarShowsRail(collapsed, peeking);
}
