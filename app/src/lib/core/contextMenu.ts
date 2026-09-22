// The app's context menu (same family as tooltip.ts / ConfirmPrompt):
// one store, one ContextMenu.svelte layer mounted at the app root
// (+page.svelte), shared by kanban cards/columns, pane tabs, and the
// sidebar. Callers build a flat item list -- separators group, danger
// styles red, a disabled item shows but ignores clicks -- and open it
// with openContextMenuFromEvent.

import { writable } from "svelte/store";

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  // A checkmark-style marker (e.g. the card's current column).
  active?: boolean;
  // A checkbox: the item states a setting the next pick will obey,
  // rather than naming the value already chosen. Drawn with its own
  // marker so a menu can carry both without the two reading alike.
  checked?: boolean;
  // Picking this item does NOT dismiss the menu. Only right for an item
  // that toggles something the menu itself displays -- a checkbox whose
  // menu closed on the tick would hide the state it just changed, and
  // the human would have to reopen it to act on the choice they made.
  keepOpen?: boolean;
  // A trailing click-to-switch on the row. Its pick does not fire
  // `onPick` -- it is a second action on the same row (a facet option's
  // NOT). keepOpen still applies; the switch's handler republishes.
  switch?: {
    label: string;
    active?: boolean;
    onPick: () => void;
  };
  // A muted second column at the row's end: a fact ABOUT the choice (how
  // long a session has waited) rather than its name. It never truncates;
  // the label gives way first, since a cut-off fact is a wrong one.
  detail?: string;
  // The row's bubble, for when the menu's width has cut the label short
  // or the row stands for more than it can say.
  tip?: string;
  onPick: () => void;
}

/// A row that names the menu rather than offering anything: what a
/// DROPDOWN needs and a right-click menu never does. A context menu is
/// opened at a thing, so its subject is obvious; a menu hanging off a
/// button whose label has been reduced to an icon has lost the words,
/// and this is where they go.
export type ContextMenuHeading = { heading: string };

export type ContextMenuEntry = ContextMenuItem | { separator: true } | ContextMenuHeading;

export interface ContextMenuState {
  x: number;
  y: number;
  entries: ContextMenuEntry[];
}

export const contextMenu = writable<ContextMenuState | null>(null);

// Breathing room between a dropdown button and the menu it opens.
const MENU_GAP_PX = 4;

export function openContextMenu(x: number, y: number, entries: ContextMenuEntry[]): void {
  // Neither a separator nor a heading is a reason to open a menu: a
  // list of nothing but decoration is an empty menu with a title on it.
  const hasAction = entries.some((e) => !isSeparator(e) && !isHeading(e));
  contextMenu.set(hasAction ? { x, y, entries } : null);
}

// The one call every right-click handler needs: claim the event (no
// native menu, no bubbling to an outer surface's own handler) and open
// the shared menu at the pointer. Surfaces only build their entries.
export function openContextMenuFromEvent(e: MouseEvent, entries: ContextMenuEntry[]): void {
  e.preventDefault();
  e.stopPropagation();
  openContextMenu(e.clientX, e.clientY, entries);
}

/// The parts of a right-click this layer reads. Duck-typed rather than a
/// MouseEvent for the same reason keyboard.ts and lineClipboard.ts
/// duck-type theirs: the suite runs under node with no DOM at all, so a
/// hand-built object has to be able to stand in.
export interface NativeMenuEvent {
  target?: EventTarget | null;
  altKey?: boolean;
  defaultPrevented?: boolean;
}

/// The <input> types the OS menu can actually act on. This app also
/// ships checkboxes, radios, a colour well and hundreds of buttons, and
/// WebKit's Cut/Copy/Paste over one of those is noise.
const NATIVE_EDIT_INPUT_TYPES = new Set(["", "text", "search", "url", "tel", "email", "password", "number"]);

/// True when the click landed in something the browser edits itself: an
/// <input>, a <textarea>, or a contenteditable (the plan editor). Mirrors
/// keyboard.ts's isTextFieldTarget, exception included -- xterm focuses a
/// hidden <textarea>, but a terminal is not a text field: its clipboard
/// travels to the pty, and ⌘C/⌘V there are already ours.
function isNativeEditTarget(target: EventTarget | null | undefined): boolean {
  const el = target as
    | { tagName?: string; type?: string; isContentEditable?: boolean; closest?: (s: string) => unknown }
    | null
    | undefined;
  if (!el || typeof el !== "object") return false;
  if (el.closest?.(".xterm")) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") return NATIVE_EDIT_INPUT_TYPES.has((el.type ?? "").toLowerCase());
  return el.isContentEditable === true;
}

/// Whether this right-click's native menu has to be taken away. gavin
/// draws its own menus, and openContextMenuFromEvent claims those events
/// before the window ever sees them -- so anything reaching this test
/// landed on a surface with NO menu of its own, where WKWebView answered
/// with its own: Reload, Back/Forward, Services, Inspect Element. None of
/// those mean anything over a terminal or a kanban column, and a web
/// page's menu in a desktop app reads as a bug.
///
/// Two things still get it, both because nothing else in the app does
/// their job:
///
/// - a text field, whose menu is the OS editing menu (cut/copy/paste,
///   spelling, substitutions) and has no gavin replacement;
/// - ⌥-right-click anywhere, which hands the click straight to WebKit.
///   That is the escape hatch: gavin binds no devtools chord, so the
///   inspector is reachable only from the native menu, and a dev build
///   that cannot open it is a worse app than one with a stray menu.
export function suppressesNativeMenu(event: NativeMenuEvent): boolean {
  // Something nearer the target already answered -- our own menu layer,
  // or a surface that prevented without stopping propagation.
  if (event.defaultPrevented) return false;
  if (event.altKey) return false;
  return !isNativeEditTarget(event.target);
}

/// Swaps the entries of the menu that is already open, keeping its
/// position. What a `keepOpen` toggle needs: its own click changed the
/// state the entries were built from, and the list is a plain array
/// captured at open time, so the tick it just set would not appear
/// until the menu was closed and opened again.
///
/// A no-op when no menu is up -- a toggle can only be picked from an
/// open menu, so this is a late/duplicate call rather than a reason to
/// reopen one somewhere the human is not looking.
export function setContextMenuEntries(entries: ContextMenuEntry[]): void {
  contextMenu.update((m) => (m ? { ...m, entries } : m));
}

export function closeContextMenu(): void {
  contextMenu.set(null);
}

/// The one attribute on ContextMenu.svelte's root. Surfaces that must
/// treat a click on the menu as still "inside" their own gesture (the
/// sidebar peek, anything else that dismisses on an outside press) ask
/// this rather than reaching into the layer's markup.
export const CONTEXT_MENU_ATTR = "data-context-menu";
export const CONTEXT_MENU_SELECTOR = `[${CONTEXT_MENU_ATTR}]`;

/// Duck-typed: the suite has no DOM, and a mousedown target is often a
/// text node whose parent is the one that can answer `closest`.
export function isInsideContextMenu(target: EventTarget | null | undefined): boolean {
  let node = target as
    | { closest?: (s: string) => unknown; parentElement?: unknown }
    | null
    | undefined;
  if (!node || typeof node !== "object") return false;
  if (typeof node.closest !== "function") {
    node = node.parentElement as typeof node;
  }
  return node?.closest?.(CONTEXT_MENU_SELECTOR) != null;
}

export function isSeparator(entry: ContextMenuEntry): entry is { separator: true } {
  return "separator" in entry;
}

export function isHeading(entry: ContextMenuEntry): entry is ContextMenuHeading {
  return "heading" in entry;
}

/// The entries that actually offer something. Every caller that walks a
/// menu wants this rather than "not a separator": that test was the whole
/// narrowing before headings existed, and it silently stops narrowing the
/// moment a third kind of row joins the union.
export function isMenuItem(entry: ContextMenuEntry): entry is ContextMenuItem {
  return !isSeparator(entry) && !isHeading(entry);
}

// Anchors the shared menu under an element instead of at the pointer:
// a dropdown BUTTON's menu hangs off the button, wherever inside it the
// click happened to land. Clamping to the viewport stays ContextMenu's
// job, so a button near the right edge still gets a menu on screen.
export function openMenuUnder(el: HTMLElement, entries: ContextMenuEntry[]): void {
  const rect = el.getBoundingClientRect();
  openContextMenu(rect.left, rect.bottom + MENU_GAP_PX, entries);
}
