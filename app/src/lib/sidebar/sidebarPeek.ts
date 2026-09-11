// The collapsed sidebar's temporary full width: press a row on the icon
// rail -- or hover it long enough -- and the column opens over the
// content until the pointer leaves it again.
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

/// How long the pointer must stay on the icon rail before a hover
/// becomes a peek. Short enough to feel like the column answering, long
/// enough that a glance across it on the way to the traffic lights does
/// not flash the overlay.
export const PEEK_HOVER_OPEN_MS = 300;

/// How long the pointer may leave the peeked column before it closes.
/// Shorter than the open dwell: this is only covering a restyle under
/// the cursor and the gap between rail and overlay, not a second
/// decision.
export const PEEK_HOVER_CLOSE_MS = 200;

type PeekHoverTimers = {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
};

export type PeekHoverEnter = {
  enabled: boolean;
  collapsed: boolean;
  peeking: boolean;
};

export type PeekHoverLeave = {
  enabled: boolean;
  peeking: boolean;
};

/// The dwell / leave-delay pair the collapsed rail uses when hover-to-
/// open is on. Timers are injectable so the suite can drive them with
/// fake clocks; the live sidebar uses the browser's.
///
/// A peek itself still lives only in the store above -- this controller
/// never writes a preference. Whether hover is even offered is
/// sidebarPrefs' question.
export function createPeekHoverController(timers: PeekHoverTimers = globalThis) {
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const clearOpen = (): void => {
    if (openTimer !== null) {
      timers.clearTimeout(openTimer);
      openTimer = null;
    }
  };

  const clearClose = (): void => {
    if (closeTimer !== null) {
      timers.clearTimeout(closeTimer);
      closeTimer = null;
    }
  };

  return {
    enter({ enabled, collapsed, peeking }: PeekHoverEnter): void {
      clearClose();
      if (!enabled || !collapsed || peeking) return;
      clearOpen();
      openTimer = timers.setTimeout(() => {
        openTimer = null;
        peekSidebar();
      }, PEEK_HOVER_OPEN_MS);
    },

    leave({ enabled, peeking }: PeekHoverLeave): void {
      clearOpen();
      if (!peeking) return;
      if (!enabled) {
        clearClose();
        endSidebarPeek();
        return;
      }
      clearClose();
      closeTimer = timers.setTimeout(() => {
        closeTimer = null;
        endSidebarPeek();
      }, PEEK_HOVER_CLOSE_MS);
    },

    cancel(): void {
      clearOpen();
      clearClose();
    },
  };
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
