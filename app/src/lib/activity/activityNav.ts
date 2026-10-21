// Where a row of the activity calendar takes the desk: a card run to its
// card, the way the attention inbox jumps (on its rail's tab when it is
// on one, else the board, detail open), and a tool run to the Tools tab.
//
// Apart from the calendar so the component holds no layout action of
// its own: the Companion draws the same component and hands it jumps of
// the phone's, and a phone must never move the desk's tabs.
import { get } from "svelte/store";
import { switchWorkspace, switchWorkspaceView } from "$lib/core/layoutState";
import { gavinTrees } from "$lib/core/gavinState";
import { orchestrations } from "$lib/orchestration/orchestrationState";
import { linkForCardPath, openLinkedCard } from "$lib/cards/cardTabLink";

export function openRunCard(workspaceId: string, path: string): void {
  void openLinkedCard(workspaceId, linkForCardPath(get(orchestrations)[workspaceId], get(gavinTrees)[workspaceId], path));
}

export function openToolsTab(workspaceId: string): void {
  void switchWorkspace(workspaceId).then(() => switchWorkspaceView(workspaceId, "tools"));
}
