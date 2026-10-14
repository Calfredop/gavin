// What the middle mouse button does: open the link under it in a
// terminal -- a URL or a file path, exactly what ⌘-click opens -- and
// close the tab it lands on, exactly what the tab's close box does. One
// switch for both, in Settings > Mouse, on unless the human turns it off.
//
// The predicates are the whole rule, so the two surfaces that act on a
// press (terminalRegistry.ts's link activation, Pane.svelte's tab strip)
// cannot disagree about what counts. Middle is `button === 1` on every
// platform; the left button is 0 and a ⌘-click keeps working whether or
// not this is on.
//
// A per-human preference about this screen's mouse, not workspace data,
// so it lives in localStorage beside the sidebar's (sidebarPrefs.ts says
// why not config.json). No daemon request, no protocol bump.

import { writable } from "svelte/store";

const MIDDLE_BUTTON = 1;

/// Whether a press on a terminal link should open it. ⌘ is the gesture
/// that always worked; a middle press joins it only while enabled.
export function opensLink(event: { metaKey: boolean; button: number }, middleClick: boolean): boolean {
  return event.metaKey || (middleClick && event.button === MIDDLE_BUTTON);
}

/// Whether a press on a tab should close it.
export function closesTab(event: { button: number }, middleClick: boolean): boolean {
  return middleClick && event.button === MIDDLE_BUTTON;
}

/// Injected for sidebarPrefs.ts's reasons: vitest's node environment and
/// an SSR pass have no localStorage, and both must remember nothing
/// rather than throw.
type MaybeStorage = Pick<Storage, "getItem" | "setItem"> | undefined;

function defaultStorage(): MaybeStorage {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

export const MIDDLE_CLICK_KEY = "gavin.middleClick";

/// On unless the human has said otherwise. Anything but the exact string
/// written for "off" reads as on, as sidebarPrefs.ts's flags do.
export function loadMiddleClickEnabled(storage: MaybeStorage = defaultStorage()): boolean {
  try {
    return storage?.getItem(MIDDLE_CLICK_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveMiddleClickEnabled(enabled: boolean, storage: MaybeStorage = defaultStorage()): void {
  try {
    storage?.setItem(MIDDLE_CLICK_KEY, enabled ? "true" : "false");
  } catch {
    // Best-effort: a full or blocked storage must never break a click.
  }
}

export const middleClickEnabled = writable<boolean>(loadMiddleClickEnabled());

export function setMiddleClickEnabled(enabled: boolean): void {
  middleClickEnabled.set(enabled);
  saveMiddleClickEnabled(enabled);
}
