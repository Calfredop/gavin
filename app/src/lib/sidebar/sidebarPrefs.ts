// The sidebar's own two preferences: whether the column is collapsed to
// its icon rail, and whether the pinned Scratchpad has a row in it.
//
// Collapsed, NOT hidden: the column stays on screen as an icon rail, and
// every workspace keeps a row -- just its initial rather than its name,
// badges and actions. A sidebar that disappeared entirely would take the
// window's traffic lights with it (they live in the strip above it,
// inside the same column), so "hide" is not a state this layout can
// offer at all; "collapse" is.
//
// Those traffic lights are also the whole floor: the rail is as narrow
// as the platform's window controls and no narrower, which is why the
// sidebar's own chrome buttons had to leave the strip for the header row
// beside it (SidebarActions.svelte). What a rail cannot show, a peek
// does -- see sidebarPeek.ts.
//
// Both are per-human view preferences rather than workspace data -- how
// wide the chrome is on this screen, and which rows it pins, are not
// facts about any project -- so they go where the sidebar's row
// expansion and the Plans tab's selection already live: localStorage. No daemon request, so no protocol bump and
// no compat gate.
//
// Deliberately NOT config.json, even though the Scratchpad toggle is
// drawn in the Settings panel beside settings that do live there. Every
// AppConfig field is a carry-through field: a dozen Tauri commands each
// read it and hand it back to `save`, and one that forgets silently
// resets it on the next save. That price is worth paying for a terminal
// font size the daemon-side agent config has to agree with; it is not
// worth paying for which rows this screen's sidebar draws.

import { get, writable } from "svelte/store";
import { layoutState, openAppHub, switchWorkspace } from "$lib/layoutState";
import { endSidebarPeek } from "$lib/sidebar/sidebarPeek";
import { UNFILED_WORKSPACE_ID } from "$lib/workspace";

/// Injected (defaulting to the browser's) for the same two reasons
/// sidebarExpansion.ts injects it: vitest's node environment has no
/// localStorage at all, and an SSR pass has none either -- both must
/// remember nothing rather than throw.
type MaybeStorage = Pick<Storage, "getItem" | "setItem"> | undefined;

function defaultStorage(): MaybeStorage {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

export const SIDEBAR_COLLAPSED_KEY = "gavin.sidebarCollapsed";

/// Anything but the exact string this module writes reads as "not
/// collapsed" -- absent, corrupt, hand-edited, or a storage that refuses
/// to be read. Expanded is the safe answer to forget to: it is the state
/// that shows every affordance, so a human who cannot get their
/// preference back is never also short of a way to act.
export function loadSidebarCollapsed(storage: MaybeStorage = defaultStorage()): boolean {
  try {
    return storage?.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveSidebarCollapsed(
  collapsed: boolean,
  storage: MaybeStorage = defaultStorage()
): void {
  try {
    storage?.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "true" : "false");
  } catch {
    // Best-effort: a full or blocked storage must never break the sidebar.
  }
}

/// Read by three surfaces at once -- the column's width (+page.svelte),
/// what the sidebar renders, and the toggle's own glyph -- so it is a
/// store rather than component state. Seeded from storage at module
/// load, which is also what restores it across a hot module swap: the
/// module is re-executed, and the answer is on disk rather than in the
/// tree that was just thrown away.
export const sidebarCollapsed = writable<boolean>(loadSidebarCollapsed());

/// Both writers end any peek in progress. A peek is the collapsed
/// column borrowing its full width for a moment; once the human has said
/// what the column should be, the borrowed state has nothing left to
/// say, and a stale one would leave an overlay floating over the view
/// with no pointer near it to dismiss it.
export function setSidebarCollapsed(collapsed: boolean): void {
  sidebarCollapsed.set(collapsed);
  saveSidebarCollapsed(collapsed);
  endSidebarPeek();
}

export function toggleSidebarCollapsed(): void {
  sidebarCollapsed.update((collapsed) => {
    saveSidebarCollapsed(!collapsed);
    return !collapsed;
  });
  endSidebarPeek();
}

export const SCRATCHPAD_KEY = "gavin.scratchpadEnabled";

/// Shown unless the human has said otherwise -- the Scratchpad is where
/// a page with nowhere else to go lands, so its row is the default and
/// its absence is the choice. Anything but the exact string this module
/// writes for "off" reads as on, for the same reason the collapse flag
/// falls back to expanded: forgetting a preference must never also mean
/// losing a way to reach something.
export function loadScratchpadEnabled(storage: MaybeStorage = defaultStorage()): boolean {
  try {
    return storage?.getItem(SCRATCHPAD_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveScratchpadEnabled(
  enabled: boolean,
  storage: MaybeStorage = defaultStorage()
): void {
  try {
    storage?.setItem(SCRATCHPAD_KEY, enabled ? "true" : "false");
  } catch {
    // Best-effort, as above.
  }
}

/// Read by the sidebar (which rows it draws), by the ⌘⌥-number router
/// (which workspaces those digits address) and by the Settings panel
/// that writes it. The first two MUST agree -- sidebarWorkspaceOrder is
/// shared between them precisely so a hint badge and its shortcut can
/// never point at different rows -- and one store is how they do.
export const scratchpadEnabled = writable<boolean>(loadScratchpadEnabled());

/// Switching it off while you are standing in the Scratchpad would leave
/// the app showing a workspace with no row anywhere and no shortcut to
/// it. Moving off first is not a courtesy; it is the difference between
/// a setting and a dead end. The app hub is the fallback when there is
/// nothing else to move to -- it belongs to no workspace, so it is
/// always somewhere to be.
///
/// Nothing inside the Scratchpad is touched. Its pages, and any agent
/// running in them, are exactly where they were; turning the row back on
/// brings all of it back.
export async function setScratchpadEnabled(enabled: boolean): Promise<void> {
  scratchpadEnabled.set(enabled);
  saveScratchpadEnabled(enabled);
  if (enabled) return;
  const state = get(layoutState);
  if (state.activeWorkspaceId !== UNFILED_WORKSPACE_ID) return;
  const elsewhere = state.workspaces.find((w) => w.id !== UNFILED_WORKSPACE_ID);
  if (elsewhere) await switchWorkspace(elsewhere.id);
  else openAppHub();
}
