// How wide the open sidebar is, when the human has dragged its edge.
//
// A per-human view preference like the collapse flag beside it
// (sidebarPrefs.ts), and kept where that one is for the same reasons:
// localStorage, no daemon request, no protocol bump, no compat gate, and
// not config.json -- every AppConfig field is a carry-through field a
// dozen commands must remember to hand back.
//
// What is stored is the width the human CHOSE, not the width drawn. The
// column cannot be narrower than the chrome in its top row (the window
// controls plus the sidebar's own buttons -- theme.css's --sidebar-width,
// wider off macOS), and that floor is a platform fact CSS already knows,
// so +page.svelte applies it as `max(var(--sidebar-width), chosen)`
// rather than this module guessing which platform it is on. A choice
// under the floor simply draws at the floor.
//
// Absence means "never dragged": the column is the floor, exactly as it
// was before it could be resized. A reset clears the key rather than
// storing a number, so absence keeps meaning that.

import { writable } from "svelte/store";

type MaybeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;

function defaultStorage(): MaybeStorage {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

export const SIDEBAR_WIDTH_KEY = "gavin.sidebarWidth";

/// The narrowest a choice can be: the macOS floor. Off macOS the floor
/// is wider and CSS holds it; this only keeps a stored number sane.
export const MIN_SIDEBAR_WIDTH = 200;

/// The widest. Past this the column stops being a list of workspaces and
/// starts being a second view, and a window narrow enough for that to
/// matter is the window that most needs the room back.
export const MAX_SIDEBAR_WIDTH = 480;

export function clampSidebarWidth(px: number): number {
  return Math.round(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, px)));
}

/// Anything that is not a finite number reads as "never dragged".
export function loadSidebarWidth(storage: MaybeStorage = defaultStorage()): number | null {
  try {
    const raw = storage?.getItem(SIDEBAR_WIDTH_KEY);
    if (raw == null || raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? clampSidebarWidth(n) : null;
  } catch {
    return null;
  }
}

export function saveSidebarWidth(
  width: number | null,
  storage: MaybeStorage = defaultStorage()
): void {
  try {
    if (width === null) storage?.removeItem(SIDEBAR_WIDTH_KEY);
    else storage?.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(width)));
  } catch {
    // Best-effort: a full or blocked storage must never break the sidebar.
  }
}

/// Read by the column's width (+page.svelte) and, through it, by the
/// corner over it and the peek that borrows the open width.
export const sidebarWidth = writable<number | null>(loadSidebarWidth());

/// The value .app hands CSS as --sidebar-chosen-width, or nothing at all
/// when the column was never dragged (the floor wins on its own).
export function sidebarWidthStyle(width: number | null): string | undefined {
  return width === null ? undefined : `${width}px`;
}

export function resetSidebarWidth(storage: MaybeStorage = defaultStorage()): void {
  sidebarWidth.set(null);
  saveSidebarWidth(null, storage);
}

type ListenerTarget = Pick<Window, "addEventListener" | "removeEventListener">;

/// One drag of the column's edge, from a pointerdown at `startX` on a
/// column `startWidth` wide. The width follows the pointer live and is
/// written to storage once, when the drag ends -- and not at all if it
/// never moved, which keeps the two presses of a double-click (the
/// reset) from storing anything.
///
/// Window-level listeners with a `buttons === 0` bail-out, like every
/// other splitter in the app: WKWebView drops pointerup when the
/// pointerdown target leaves the DOM, and pointer capture is unreliable
/// there. Returns the function that ends the drag early.
export function beginSidebarResize(
  startWidth: number,
  startX: number,
  opts: {
    target?: ListenerTarget;
    storage?: MaybeStorage;
    onEnd?: () => void;
  } = {}
): () => void {
  const target = opts.target ?? window;
  const storage = opts.storage ?? defaultStorage();
  let moved = false;
  let latest = clampSidebarWidth(startWidth);
  let ended = false;

  const move = (ev: Event): void => {
    const e = ev as PointerEvent;
    if (e.buttons === 0) {
      end();
      return;
    }
    const next = clampSidebarWidth(startWidth + e.clientX - startX);
    if (next === latest && !moved) return;
    moved = true;
    latest = next;
    sidebarWidth.set(next);
  };
  const end = (): void => {
    if (ended) return;
    ended = true;
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", end);
    target.removeEventListener("pointercancel", end);
    if (moved) saveSidebarWidth(latest, storage);
    opts.onEnd?.();
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", end);
  return end;
}
