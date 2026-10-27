// The divider between the per-run Changes view's file list and its diff.
//
// Stored as the list's SHARE of the pair, like every divider in the app
// (splitShare.ts says why): the same view is drawn as a modal and as a
// pane split off beside an agent, at whatever width that split has, and
// a pixel width dragged in one would overflow the other.
//
// One share for every run, kept in localStorage: how wide this screen
// draws a file list is a per-human view preference, not a fact about a
// card or a workspace -- and the modal has no workspace to file it
// under anyway. No config.json field, so no carry-through to forget.

import { shareFromSize } from "$lib/panes/splitShare";

/// The 260px list the view shipped with, out of its ~970px body.
export const DEFAULT_LIST_SHARE = 0.27;

/// A badge and the start of a name on one side; a few columns of code
/// on the other.
export const MIN_SIDE_PX = 120;

export const LIST_SHARE_KEY = "gavin.runChangesListShare";

/// The share of `total` the list should take, given a drag that wants it
/// `desired` px wide.
export function listShareFromWidth(desired: number, total: number, min = MIN_SIDE_PX): number {
  return shareFromSize(desired, total, min, DEFAULT_LIST_SHARE);
}

/// Injected for the reasons sidebarPrefs.ts gives: vitest's node
/// environment and an SSR pass have no localStorage, and both must
/// remember nothing rather than throw.
type MaybeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;

function defaultStorage(): MaybeStorage {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

/// Anything but a share strictly between 0 and 1 reads as the default --
/// absent, corrupt, hand-edited, or a storage that refuses to be read.
export function loadListShare(storage: MaybeStorage = defaultStorage()): number {
  try {
    const raw = storage?.getItem(LIST_SHARE_KEY);
    const n = raw == null ? NaN : Number(raw);
    return n > 0 && n < 1 ? n : DEFAULT_LIST_SHARE;
  } catch {
    return DEFAULT_LIST_SHARE;
  }
}

/// `null` forgets the share, so the next view opens at the default.
export function saveListShare(share: number | null, storage: MaybeStorage = defaultStorage()): void {
  try {
    if (share === null) storage?.removeItem(LIST_SHARE_KEY);
    else storage?.setItem(LIST_SHARE_KEY, String(share));
  } catch {
    // A storage that refuses writes leaves the split as dragged for this
    // view; there is nothing better to fall back to.
  }
}
