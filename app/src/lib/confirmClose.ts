import { confirm } from "@tauri-apps/plugin-dialog";
import { get } from "svelte/store";
import { layoutState } from "./layoutState";
import { findLeafPath, getNodeAtPath, isLastTabInPane } from "./layout";

// Prompts before closing a single tab, but only when doing so would empty
// its pane -- closing a tab that leaves siblings behind needs no prompt,
// exactly as it behaves today. Returns whether the caller should proceed
// with closeSession(sessionId).
export async function confirmTabClose(sessionId: string): Promise<boolean> {
  const state = get(layoutState);
  if (!state.tree || !isLastTabInPane(state.tree, sessionId)) return true;
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
  if (!state.tree) return true;
  const path = findLeafPath(state.tree, anySessionId);
  if (!path) return true;
  const leaf = getNodeAtPath(state.tree, path);
  const count = leaf.type === "leaf" ? leaf.tabs.length : 0;
  return confirm(`Close this pane? ${count} terminal session${count === 1 ? "" : "s"} will end.`, {
    title: "gavin",
  });
}
