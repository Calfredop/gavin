// "Clean stale decisions" and "Clean stale tests" from the phone: the
// desk's own request (`requestCleanStale`) -- the same confirm first, the
// same prompt over the same entries -- started the way a Device starts an
// agent with no card behind it (`DEVICE_AGENT_HOST`): refused at a full
// machine rather than queued into a queue only the desk drains, the
// session the desk's to place, and the run opened in the phone's own
// terminal.
import type { CleanKind } from "$lib/decisions/cleanStale";
import { requestCleanStale } from "$lib/decisions/cleanStaleActions";
import { DEVICE_AGENT_HOST, readyToLaunch } from "$companion/state/cards";
import type { ItemsList } from "$companion/surfaces/phoneItems";

/// A press on the clean. A blocked one says why, since a phone has no
/// tooltip to. The confirm is the desk's, inside the request.
/// Resolves with what to tell the human, or null.
export async function cleanStale(workspaceId: string, kind: CleanKind, list: ItemsList): Promise<string | null> {
  if (list.cleanBlocked) return list.cleanBlocked;
  const notReady = await readyToLaunch();
  if (notReady) return notReady;
  try {
    return await requestCleanStale(workspaceId, kind, list.cleanable, DEVICE_AGENT_HOST);
  } catch (e) {
    return `Couldn't start the agent: ${e instanceof Error ? e.message : String(e)}`;
  }
}
