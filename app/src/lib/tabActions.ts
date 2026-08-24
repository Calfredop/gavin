// Multi-tab close used by the tab context menu. One confirmation covers
// the whole batch (confirmTabsClose), then the closes run sequentially --
// closeSession mutates the shared layout tree, so overlapping them would
// race. Lives outside layoutState.ts because confirmClose.ts already
// imports layoutState -- importing it back would form an import cycle.
import { confirmTabsClose } from "./confirmClose";
import { closeSession } from "./layoutState";

export async function closeTabs(sessionIds: string[]): Promise<void> {
  if (!(await confirmTabsClose(sessionIds))) return;
  for (const id of sessionIds) {
    await closeSession(id);
  }
}
