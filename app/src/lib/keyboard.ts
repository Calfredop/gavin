import { get } from "svelte/store";
import {
  layoutState,
  splitPane,
  addTab,
  closeSession,
  switchToTab,
  switchWorkspaceView,
  switchPage,
  switchWorkspace,
  type LayoutState,
} from "$lib/layoutState";
import { copySelection, pasteClipboard } from "$lib/clipboard";
import { confirmTabClose } from "$lib/confirmClose";
import { findLeafPath, getNodeAtPath, isPinned } from "$lib/layout";
import {
  getActiveTree,
  getActiveWorkspace,
  getActiveView,
  sidebarPageOrder,
  sidebarWorkspaceOrder,
} from "$lib/workspace";
import { tabStripHubViewIds } from "$lib/hub/hubViewMeta";
import { currentHubTabPrefs } from "$lib/hub/hubTabPrefs";
import { scratchpadEnabled } from "$lib/sidebar/sidebarPrefs";
import { cmdHeld, isMacSync } from "$lib/platform";
import { digitFromCode, matchesChord, resolveIndex, SHORTCUTS } from "$lib/shortcuts";
import { requestedCompose, resolveComposeTarget } from "$lib/cards/composeRequest";

/// Just the parts of a KeyboardEvent the shortcut layer reads. A real
/// KeyboardEvent satisfies it structurally; tests build one by hand,
/// which is why the routing needs no DOM.
export interface ShortcutKeyEvent {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /// Where the key landed, used only to keep ⌘C/⌘V out of text fields.
  /// Optional so a hand-built test event can leave it off.
  target?: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}

/// True when the keystroke landed in something the browser edits itself:
/// an <input>, a <textarea>, or a contenteditable (the plan editor). ⌘C
/// and ⌘V there belong to that field, and consuming them here is what
/// sent every paste to the last-focused terminal instead.
///
/// Duck-typed rather than `instanceof HTMLElement`: this layer is tested
/// with no DOM at all, and a plain object has to be able to stand in.
function isTextFieldTarget(target: EventTarget | null | undefined): boolean {
  const el = target as
    | { tagName?: string; isContentEditable?: boolean; closest?: (s: string) => unknown }
    | null
    | undefined;
  if (!el || typeof el !== "object") return false;
  // xterm focuses a hidden <textarea>, but a terminal is not a text
  // field: its clipboard has to travel to the pty, so ⌘C/⌘V inside the
  // terminal container stay ours.
  if (el.closest?.(".xterm")) return false;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
  return el.isContentEditable === true;
}

// ⌘1-8 select that position, ⌘9 the last, ⌘0 the first. Which LIST is
// addressed depends on the modifiers and what is on screen: plain ⌘ =
// the focused pane's tabs (session page) or the hub tabs (workspace
// page); ⌘⇧ = the active workspace's pages; ⌘⌥ = the workspaces.
//
// Deliberately SYNCHRONOUS, returning the action to run rather than
// running it: the caller has to preventDefault() before the first await,
// or dispatch has already finished and the terminal has seen the key.
function routeDigit(
  event: ShortcutKeyEvent,
  digit: number,
  state: LayoutState,
  isMac: boolean
): (() => Promise<void>) | null {
  const { shiftKey, altKey } = event;
  if (shiftKey && altKey) return null;
  // The other platform's command key must be up, exactly as matchesChord
  // requires for letters -- ⌃⌘1 on macOS is not ⌘1.
  if (isMac ? event.ctrlKey : event.metaKey) return null;
  // On Windows/Linux AltGr arrives as ctrl+alt, which is how a German or
  // French layout types ² @ ~ -- never a workspace switch.
  if (!isMac && event.ctrlKey && event.altKey) return null;

  if (altKey) {
    // The same list the sidebar draws, Scratchpad included or not: these
    // digits are the sidebar's rows counted from the top, and a router
    // that counted a row nothing draws would be off by one for every
    // workspace below it.
    const list = sidebarWorkspaceOrder(state.workspaces, get(scratchpadEnabled));
    const index = resolveIndex(digit, list.length);
    if (index === null) return null;
    const workspaceId = list[index].id;
    return () => switchWorkspace(workspaceId);
  }

  const ws = getActiveWorkspace(state);
  if (!ws) return null;

  if (shiftKey) {
    // The sidebar's own order, pinned pages first -- these digits count
    // the rows it draws, and a router counting the stored array instead
    // would address a different page than the badge on the row promises.
    const pages = sidebarPageOrder(ws.pages);
    const index = resolveIndex(digit, pages.length);
    if (index === null) return null;
    const pageId = pages[index].id;
    return () => switchPage(ws.id, pageId);
  }

  if (getActiveView(ws) === "terminal") {
    const tree = getActiveTree(state);
    const focused = state.focusedSessionId;
    if (!tree || !focused) return null;
    const path = findLeafPath(tree, focused);
    if (!path) return null;
    const leaf = getNodeAtPath(tree, path);
    if (leaf.type !== "leaf") return null;
    const index = resolveIndex(digit, leaf.tabs.length);
    if (index === null) return null;
    const tabId = leaf.tabs[index];
    return () => switchToTab(tabId);
  }

  // The STRIP's ids, not every view on offer: ⌘-digits address tabs by
  // position, and the row is what the human is counting along. A view
  // reached by a button in the actions (Settings) has no position to
  // address, and counting it here would shift every digit past it -- and
  // for the same reason the row's own preferences are passed in: a
  // rearranged or thinned-out strip is still what is being counted.
  const views = tabStripHubViewIds(Boolean(ws.rootPath), currentHubTabPrefs(ws.id));
  const index = resolveIndex(digit, views.length);
  if (index === null) return null;
  const viewId = views[index];
  return () => switchWorkspaceView(ws.id, viewId);
}

/// The session the terminal chords may act on: the focused session, but
/// only while a terminal page is what the workspace is actually SHOWING
/// and that session is one of the page's own tabs.
///
/// LayoutState.focusedSessionId deliberately outlives a detour into a hub
/// tab -- switching back has to restore the same pane, which is why
/// switchWorkspaceView leaves it alone. That made every terminal chord
/// fire from the hub against a page nowhere on screen: ⌘T spawned a
/// session into it, ⌘W closed one of its tabs, and ⌘V typed the
/// clipboard into it while the human was looking at the board. The digit
/// router has always refused to address tabs off the terminal view; the
/// letters have to refuse for the same reason.
///
/// The membership check is not redundant with the view check: the two
/// halves of "which page" (activePageId, and the app-wide focus) are
/// updated by different actions, and acting on a stale focus would put
/// the tab on the visible page while addressing a pane that left it.
function focusedTerminalSession(state: LayoutState): string | null {
  const ws = getActiveWorkspace(state);
  if (!ws || getActiveView(ws) !== "terminal") return null;
  const tree = getActiveTree(state);
  const focused = state.focusedSessionId;
  if (!tree || !focused) return null;
  return findLeafPath(tree, focused) ? focused : null;
}

/// Handles one keydown. Exported for tests; the window listener below is
/// the only production caller. Returns whether the event was consumed.
export async function handleShortcutKeydown(event: ShortcutKeyEvent): Promise<boolean> {
  if (!cmdHeld(event)) return false;
  const state = get(layoutState);
  const isMac = isMacSync();

  const digit = digitFromCode(event.code);
  if (digit !== null) {
    const action = routeDigit(event, digit, state, isMac);
    if (!action) return false;
    // Before the await: a preventDefault() after one lands a task turn
    // too late, once dispatch has already handed the key to xterm.
    event.preventDefault();
    event.stopPropagation();
    await action();
    return true;
  }

  const consume = (): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  // New card: the one letter chord that is NOT about the focused
  // terminal, so it is routed before the guard below. It fires only
  // while a board is on screen -- with none showing the key stays the
  // terminal's, which is what keeps ⌘N usable inside a shell.
  if (matchesChord(event, SHORTCUTS["new-card"], isMac)) {
    const target = resolveComposeTarget(
      getActiveWorkspace(state),
      state.focusedSessionId,
      state.boardTabsById
    );
    if (!target) return false;
    consume();
    requestedCompose.set(target);
    return true;
  }

  // Everything below acts on the focused terminal session -- and only
  // while that session's page is the one on screen.
  const focused = focusedTerminalSession(state);
  if (!focused) return false;

  if (matchesChord(event, SHORTCUTS["split-down"], isMac)) {
    consume();
    await splitPane(focused, "column");
    return true;
  }
  if (matchesChord(event, SHORTCUTS["split-right"], isMac)) {
    consume();
    await splitPane(focused, "row");
    return true;
  }
  if (matchesChord(event, SHORTCUTS["new-tab"], isMac)) {
    consume();
    await addTab(focused);
    return true;
  }
  if (matchesChord(event, SHORTCUTS["close-tab"], isMac)) {
    consume();
    // A pinned tab is protected from the close shortcut (browser-style);
    // the tab menu's explicit Close still works.
    const tree = getActiveTree(state);
    if (tree && isPinned(tree, focused)) return true;
    if (await confirmTabClose(focused)) {
      await closeSession(focused);
    }
    return true;
  }
  // Copy/paste stay macOS-only on metaKey: on Linux/Windows Ctrl+C in a
  // terminal must remain SIGINT, not a copy.
  //
  // A text field keeps its own ⌘C/⌘V. Letting the event through is the
  // whole fix: WebKit hands ⌘V to the page first, so preventing it here
  // stopped macOS from ever reaching the Edit menu's Paste, and the
  // field got nothing while the terminal got the clipboard.
  const editing = isTextFieldTarget(event.target);
  if (isMac && event.metaKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "c") {
    if (editing) return false;
    consume();
    await copySelection();
    return true;
  }
  if (isMac && event.metaKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "v") {
    if (editing) return false;
    consume();
    await pasteClipboard();
    return true;
  }
  return false;
}

export function installKeyboardShortcuts(): () => void {
  // Capture phase, not bubble -- xterm.js's own keydown handler stops
  // propagation before a bubble-phase window listener would ever see it
  // (established the hard way in Milestone B).
  const listener = (event: KeyboardEvent) => {
    void handleShortcutKeydown(event);
  };
  window.addEventListener("keydown", listener, true);
  return () => window.removeEventListener("keydown", listener, true);
}
