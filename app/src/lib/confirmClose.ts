import { askConfirm } from "./dialog";
import { get } from "svelte/store";
import { layoutState } from "./layoutState";
import type { LayoutNode } from "./layout";
import { findLeafPath, getNodeAtPath, isLastTabInPane, allSessionIds, sessionTabsOnly } from "./layout";
import type { Workspace, WorkspacesData } from "./workspace";
import { getActiveTree, allSessionIdsInWorkspace, findSessionLocation } from "./workspace";

// The workspace that owns a tab, falling back to the active one when the
// tab is nowhere in a page tree (a main-agent session, or an id already
// removed). Which workspace matters because "Close confirm" is a
// per-workspace setting and the sidebar's rows can close a tab belonging
// to any workspace, not just the one on screen.
function owningWorkspace(state: WorkspacesData, sessionId: string): Workspace | null {
  const location = findSessionLocation(state, sessionId);
  const id = location?.workspaceId ?? state.activeWorkspaceId;
  return state.workspaces.find((w) => w.id === id) ?? null;
}

// Whether this workspace asks before closing a tab. Absent means on, so
// an existing config.json (and the Scratchpad workspace, which nobody
// visited settings for) gets the safe behaviour.
function tabCloseConfirmEnabled(state: WorkspacesData, sessionId: string): boolean {
  return owningWorkspace(state, sessionId)?.confirmTabClose ?? true;
}

// The tree the tab actually lives in -- its own page's, not the visible
// page's, for the same cross-workspace reason as owningWorkspace.
function treeHolding(state: WorkspacesData, sessionId: string): LayoutNode | null {
  const location = findSessionLocation(state, sessionId);
  if (!location) return getActiveTree(state);
  return (
    state.workspaces
      .find((w) => w.id === location.workspaceId)
      ?.pages.find((p) => p.id === location.pageId)?.layout ?? null
  );
}

// Prompts before closing a single tab, gated on the workspace's "Close
// confirm" setting (on by default). The wording escalates when the close
// would also take the pane with it, since that is the outcome people
// actually get wrong. Returns whether the caller should proceed with
// closeSession(sessionId).
//
// With the setting off there is no prompt at all, not even the
// pane-emptying one: the toggle means "stop asking me about tab
// closes", and a lone survivor prompt would make it read as broken.
export async function confirmTabClose(sessionId: string): Promise<boolean> {
  const state = get(layoutState);
  if (!tabCloseConfirmEnabled(state, sessionId)) return true;
  const tree = treeHolding(state, sessionId);
  // A file or board tab ends no process; a terminal tab does, and saying
  // so is the whole point of the prompt.
  const ends = !state.fileTabsById[sessionId] && !state.boardTabsById[sessionId];
  const lines = [
    ...(ends ? ["The terminal session will end."] : []),
    ...(tree && isLastTabInPane(tree, sessionId)
      ? ["It's the last tab in this pane, so the pane will close too."]
      : []),
  ];
  return askConfirm({ title: "Close this tab?", lines, confirmLabel: "Close tab" });
}

// Prompts once for a whole batch (the tab menu's Close Others / to the
// Right / to the Left). One prompt, not one per tab: N modals in a row
// for a single menu pick is not a confirmation, it is a wall, and the
// answer to the second one is never considered.
export async function confirmTabsClose(sessionIds: string[]): Promise<boolean> {
  if (sessionIds.length === 0) return true;
  if (sessionIds.length === 1) return confirmTabClose(sessionIds[0]);
  const state = get(layoutState);
  if (!tabCloseConfirmEnabled(state, sessionIds[0])) return true;
  const sessions = sessionTabsOnly(sessionIds, state.fileTabsById, state.boardTabsById).length;
  return askConfirm({
    title: `Close ${sessionIds.length} tabs?`,
    lines: sessions === 0 ? [] : [`${sessions} terminal session${sessions === 1 ? "" : "s"} will end.`],
    confirmLabel: "Close tabs",
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
  return askConfirm({
    title: "Close this pane?",
    lines: [`${count} terminal session${count === 1 ? "" : "s"} will end.`],
    confirmLabel: "Close pane",
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
  return askConfirm({
    title: "Close this page?",
    lines: [`${count} terminal session${count === 1 ? "" : "s"} will end.`],
    confirmLabel: "Close page",
  });
}

// Prompts before closing an entire workspace -- always, for the same
// reason as confirmPageClose, just counted across every page it holds.
// Returns whether the caller should proceed with closeWorkspace(workspaceId).
//
// The prompt says what closing does NOT do, because the gesture reads as
// a delete and is not one: the workspace leaves the app, its sessions
// end, and everything else -- the files on disk and the daemon's rows --
// stays exactly where it is. Deleting those is a separate, deliberate
// walk through Settings > Danger zone.
export async function confirmWorkspaceClose(workspaceId: string): Promise<boolean> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return true;
  const count = sessionTabsOnly(allSessionIdsInWorkspace(ws), state.fileTabsById, state.boardTabsById).length;
  return askConfirm({
    title: "Remove this workspace from gavin?",
    lines: [
      `${count} terminal session${count === 1 ? "" : "s"} will end.`,
      "Nothing on disk is deleted and its board is kept — re-adding the folder offers to restore it.",
    ],
    confirmLabel: "Remove workspace",
    // Red, and Enter dismisses rather than removes: the gesture reads as
    // a delete even though it is not one, so it must not be answerable
    // by reflex.
    danger: true,
  });
}
