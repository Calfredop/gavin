// Multi-tab close used by the tab context menu. One confirmation covers
// the whole batch (confirmTabsClose), then the closes run sequentially --
// closeSession mutates the shared layout tree, so overlapping them would
// race. Lives outside layoutState.ts because confirmClose.ts already
// imports layoutState -- importing it back would form an import cycle.
import { confirmTabsClose } from "$lib/shell/confirmClose";
import { closeSession } from "$lib/core/layoutState";

export async function closeTabs(sessionIds: string[]): Promise<void> {
  if (!(await confirmTabsClose(sessionIds))) return;
  await closeTabsNow(sessionIds);
}

// The batch close with the asking already done, for callers that ask
// with the app's own prompt instead (the page menu's "Close Idle Tabs"
// puts its counts in a ConfirmPrompt). Going through closeTabs there
// would ask twice -- once in the app, once in a native dialog.
export async function closeTabsNow(sessionIds: string[]): Promise<void> {
  for (const id of sessionIds) {
    await closeSession(id);
  }
}
