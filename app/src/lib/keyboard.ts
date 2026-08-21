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
} from "./layoutState";
import { copySelection, pasteClipboard } from "./clipboard";
import { confirmTabClose } from "./confirmClose";
import { findLeafPath, getNodeAtPath, isPinned } from "./layout";
import { getActiveTree, getActiveWorkspace, getActiveView, sidebarWorkspaceOrder } from "./workspace";
import { visibleHubViewIds } from "./hubViewMeta";
import { cmdHeld, isMacSync } from "./platform";
import { digitFromCode, matchesChord, resolveIndex, SHORTCUTS } from "./shortcuts";

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
  preventDefault(): void;
  stopPropagation(): void;
}

// ⌘1-8 select that position, ⌘9 the last, ⌘0 the first. Which LIST is
// addressed depends on the modifiers and what is on screen: plain ⌘ =
// the focused pane's tabs (session page) or the hub tabs (workspace
// page); ⌘⇧ = the active workspace's pages; ⌘⌥ = the workspaces.
async function routeDigit(
  event: ShortcutKeyEvent,
  digit: number,
  state: LayoutState
): Promise<boolean> {
  const { shiftKey, altKey } = event;
  if (shiftKey && altKey) return false;

  if (altKey) {
    const list = sidebarWorkspaceOrder(state.workspaces);
    const index = resolveIndex(digit, list.length);
    if (index === null) return false;
    await switchWorkspace(list[index].id);
    return true;
  }

  const ws = getActiveWorkspace(state);
  if (!ws) return false;

  if (shiftKey) {
    const index = resolveIndex(digit, ws.pages.length);
    if (index === null) return false;
    await switchPage(ws.id, ws.pages[index].id);
    return true;
  }

  if (getActiveView(ws) === "terminal") {
    const tree = getActiveTree(state);
    const focused = state.focusedSessionId;
    if (!tree || !focused) return false;
    const path = findLeafPath(tree, focused);
    if (!path) return false;
    const leaf = getNodeAtPath(tree, path);
    if (leaf.type !== "leaf") return false;
    const index = resolveIndex(digit, leaf.tabs.length);
    if (index === null) return false;
    await switchToTab(leaf.tabs[index]);
    return true;
  }

  const views = visibleHubViewIds(ws.id, import.meta.env.DEV, Boolean(ws.rootPath));
  const index = resolveIndex(digit, views.length);
  if (index === null) return false;
  await switchWorkspaceView(ws.id, views[index]);
  return true;
}

/// Handles one keydown. Exported for tests; the window listener below is
/// the only production caller. Returns whether the event was consumed.
export async function handleShortcutKeydown(event: ShortcutKeyEvent): Promise<boolean> {
  if (!cmdHeld(event)) return false;
  const state = get(layoutState);
  const isMac = isMacSync();

  const digit = digitFromCode(event.code);
  if (digit !== null) {
    const handled = await routeDigit(event, digit, state);
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
    return handled;
  }

  // Everything below acts on the focused terminal session.
  if (!state.focusedSessionId) return false;

  const consume = (): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  if (matchesChord(event, SHORTCUTS["split-down"], isMac)) {
    consume();
    await splitPane(state.focusedSessionId, "column");
    return true;
  }
  if (matchesChord(event, SHORTCUTS["split-right"], isMac)) {
    consume();
    await splitPane(state.focusedSessionId, "row");
    return true;
  }
  if (matchesChord(event, SHORTCUTS["new-tab"], isMac)) {
    consume();
    await addTab(state.focusedSessionId);
    return true;
  }
  if (matchesChord(event, SHORTCUTS["close-tab"], isMac)) {
    consume();
    // A pinned tab is protected from the close shortcut (browser-style);
    // the tab menu's explicit Close still works.
    const tree = getActiveTree(state);
    if (tree && isPinned(tree, state.focusedSessionId)) return true;
    if (await confirmTabClose(state.focusedSessionId)) {
      await closeSession(state.focusedSessionId);
    }
    return true;
  }
  // Copy/paste stay macOS-only on metaKey: on Linux/Windows Ctrl+C in a
  // terminal must remain SIGINT, not a copy.
  if (isMac && event.metaKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "c") {
    consume();
    await copySelection();
    return true;
  }
  if (isMac && event.metaKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "v") {
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
