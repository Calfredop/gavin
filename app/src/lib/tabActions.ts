// Multi-tab close used by the tab context menu. Sequential on purpose:
// confirmTabClose only prompts when a close would empty the pane, and a
// declined prompt must stop the rest of the batch. Lives outside
// layoutState.ts because confirmClose.ts already imports layoutState --
// importing it back would form an import cycle.
import { confirmTabClose } from "./confirmClose";
import { closeSession } from "./layoutState";

export async function closeTabs(sessionIds: string[]): Promise<void> {
  for (const id of sessionIds) {
    if (!(await confirmTabClose(id))) return;
    await closeSession(id);
  }
}
