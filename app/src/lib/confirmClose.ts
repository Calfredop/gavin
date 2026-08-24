import { confirm } from "@tauri-apps/plugin-dialog";
import { get } from "svelte/store";
import { layoutState } from "./layoutState";
import { findLeafPath, getNodeAtPath, isLastTabInPane, allSessionIds, sessionTabsOnly } from "./layout";
import { getActiveTree, allSessionIdsInWorkspace, findSessionLocation } from "./workspace";

// Prompts before closing a single tab, but only when doing so would empty
// its pane -- closing a tab that leaves siblings behind needs no prompt,
// exactly as it behaves today. Looks the tab up wherever it lives: the
// sidebar's session rows can close a session on any page of any
// workspace, not just the one on screen. Returns whether the caller
// should proceed with closeSession(sessionId).
export async function confirmTabClose(sessionId: string): Promise<boolean> {
  const state = get(layoutState);
  // Closing a file or board tab ends no process -- nothing to warn about.
  if (state.fileTabsById[sessionId] || state.boardTabsById[sessionId]) return true;
  const location = findSessionLocation(state, sessionId);
  const tree = location
    ? (state.workspaces
        .find((w) => w.id === location.workspaceId)
        ?.pages.find((p) => p.id === location.pageId)?.layout ?? null)
    : getActiveTree(state);
  if (!tree || !isLastTabInPane(tree, sessionId)) return true;
  return confirm("Close this tab? It's the last one in this pane, so the pane will close too.", {
    title: "gavin",
  });
}

// Prompts before closing an entire pane -- always, since the toolbar's
// "Close Pane" button is by definition emptying a pane, regardless of how
// many tabs it holds. Returns whether the caller should proceed with
// closePane(anySessionId).
export async function confirmPaneClose(anySessionId: string): Promise<boolean> {
  const state = get(layoutState);
  const tree = getActiveTree(state);
  if (!tree) return true;
  const path = findLeafPath(tree, anySessionId);
  if (!path) return true;
  const leaf = getNodeAtPath(tree, path);
  const count = leaf.type === "leaf" ? sessionTabsOnly(leaf.tabs, state.fileTabsById, state.boardTabsById).length : 0;
  return confirm(`Close this pane? ${count} terminal session${count === 1 ? "" : "s"} will end.`, {
    title: "gavin",
  });
}

// Prompts before closing an entire page -- always, since removing a page
// from the sidebar is by definition ending every session inside it,
// regardless of how many panes/tabs it holds. Returns whether the caller
// should proceed with closePage(workspaceId, pageId).
export async function confirmPageClose(workspaceId: string, pageId: string): Promise<boolean> {
  const state = get(layoutState);
  const page = state.workspaces.find((w) => w.id === workspaceId)?.pages.find((p) => p.id === pageId);
  if (!page) return true;
  const count = sessionTabsOnly(allSessionIds(page.layout), state.fileTabsById, state.boardTabsById).length;
  return confirm(`Close this page? ${count} terminal session${count === 1 ? "" : "s"} will end.`, {
    title: "gavin",
  });
}

// Prompts before closing an entire workspace -- always, for the same
// reason as confirmPageClose, just counted across every page it holds.
// Returns whether the caller should proceed with closeWorkspace(workspaceId).
export async function confirmWorkspaceClose(workspaceId: string): Promise<boolean> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return true;
  const count = sessionTabsOnly(allSessionIdsInWorkspace(ws), state.fileTabsById, state.boardTabsById).length;
  return confirm(`Close this workspace? ${count} terminal session${count === 1 ? "" : "s"} will end.`, {
    title: "gavin",
  });
}
