// A workspace's Scheduled tasks on the phone (ADR 0010): the desk's list,
// read through the desk's own loader, and the controls a phone has.
//
// A phone never fires a task (ADR 0003). The scheduler is the desk's and
// is never started here, and the claim and the launch record are refused
// to the Remote role. Run now is asked of the desk instead
// (`scheduled_run_now_for_device`): the window that runs the workspace
// launches it as its own button would, and says why when it will not.
// Pausing, duplicating, deleting and unscheduling are the desk's own
// writes, which a phone may make.
import * as backend from "$lib/core/backend";
import { initScheduledListeners, refreshScheduled } from "$lib/scheduling/scheduledState";
import type { ScheduledTask } from "$lib/scheduling/scheduledTask";
import { loadLaunchTables } from "$companion/state/sessions";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/// The list, read fresh each time the surface opens, and the agent tables
/// the Edit schedule dialog resolves a task's agent from.
export async function loadScheduled(workspaceId: string): Promise<void> {
  await Promise.all([refreshScheduled(workspaceId), loadLaunchTables()]);
}

/// The desk's push for a copy or a report changing, relayed to the phone.
export function listenScheduled(): Promise<() => void> {
  return initScheduledListeners();
}

/// Run now, asked of the desk. Resolves with the desk's reason when it
/// did not start, or null once it has.
export async function runNowFromPhone(workspaceId: string, task: ScheduledTask): Promise<string | null> {
  try {
    await backend.scheduledRunNowForDevice(workspaceId, task.path);
  } catch (e) {
    return message(e);
  }
  await refreshScheduled(workspaceId);
  return null;
}
