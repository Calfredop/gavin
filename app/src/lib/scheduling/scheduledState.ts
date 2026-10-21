// Scheduled tasks in the running app (ADR 0010): the list per workspace,
// the scheduler that fires them, and Run now.
//
// The scheduler ticks beside the rail one and on the same terms: only the
// window that `runsRailsFor` a workspace fires its tasks, so two windows
// never race each other -- and the Companion, whose window shim answers
// false there (ADR 0003), never fires anything. Two APPS on one machine
// (dev and release) can both be that window; the daemon's fire claim is
// what keeps them from firing one slot twice.
//
// A run is silent: headless, in the workspace's main checkout, with no
// tab and no "finished" notification. What it did is its Run report.

import { get, writable } from "svelte/store";
import { listen } from "@tauri-apps/api/event";
import * as backend from "$lib/core/backend";
import {
  agentForCard,
  daemonCompat,
  layoutState,
  prepareCursorAgentLaunch,
  profileIdForLaunch,
  workspaceRootPath,
} from "$lib/core/layoutState";
import { featureBlockedReason } from "$lib/core/daemonCompat";
import { buildHeadlessCommand } from "$lib/cards/cardRun";
import { mustPromptBody } from "$lib/agents/actionPromptsState";
import { mayStartWork, startBlockedReason } from "$lib/agents/agentPauseState";
import { launchBlockedReason, mayLaunch } from "$lib/agents/launchQueue";
import { runsRailsFor } from "$lib/shell/appDuty";
import { isSshWorkspace } from "$lib/workspace/sshWorkspace";
import { dueSlot, liveFire, reportStamp } from "$lib/scheduling/schedule";
import {
  composeScheduledPrompt,
  scheduledAgentFields,
  scheduledRunArgs,
  scheduledRunBlocker,
} from "$lib/scheduling/scheduledRun";
import type { FireClaim, ScheduledTask } from "$lib/scheduling/scheduledTask";

/// Every loaded workspace's Scheduled tasks, by workspace id.
export const scheduledTasks = writable<Record<string, ScheduledTask[]>>({});

/// Why a workspace's list could not be read, by workspace id.
export const scheduledErrors = writable<Record<string, string | null>>({});

/// How often the scheduler looks at the clock. A fire lands within this
/// of its slot: fine enough that "every 2 minutes" reads as every two
/// minutes, coarse enough to cost nothing.
export const SCHEDULED_TICK_MS = 15_000;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/// Why this workspace cannot have Scheduled tasks here, or null.
export function scheduledBlockedReason(workspaceId: string): string | null {
  const blocked = featureBlockedReason(get(daemonCompat), "scheduledTasks");
  if (blocked) return blocked;
  const ws = get(layoutState).workspaces.find((w) => w.id === workspaceId);
  if (!ws) return "Unknown workspace";
  if (isSshWorkspace(ws)) return "Scheduled tasks run on this machine's workspaces only, not over ssh";
  if (!ws.rootPath) return "This workspace has no folder";
  return null;
}

/// Sessions this window has attached to, so their output and exit reach
/// it -- a run started before a restart is one no page references.
const adopted = new Set<string>();

/// Reads a workspace's list from the daemon. Silent when the workspace
/// cannot have one; the reason is the tab's to show.
export async function refreshScheduled(workspaceId: string): Promise<ScheduledTask[]> {
  const root = workspaceRootPath(workspaceId);
  if (scheduledBlockedReason(workspaceId) || !root) return [];
  try {
    const tasks = await backend.listScheduledTasks(workspaceId, root);
    scheduledTasks.update((all) => ({ ...all, [workspaceId]: tasks }));
    scheduledErrors.update((all) => ({ ...all, [workspaceId]: null }));
    for (const task of tasks) {
      const live = liveFire(task);
      if (live?.sessionId && !adopted.has(live.sessionId)) {
        adopted.add(live.sessionId);
        void backend.adoptSession(live.sessionId).catch(() => adopted.delete(live.sessionId!));
      }
    }
    return tasks;
  } catch (e) {
    scheduledErrors.update((all) => ({ ...all, [workspaceId]: errorText(e) }));
    return get(scheduledTasks)[workspaceId] ?? [];
  }
}

/// The daemon's push: something under `.gavin-root/scheduled/` changed
/// -- a copy edited, a report or a run's terminal written.
export async function initScheduledListeners(): Promise<() => void> {
  return await listen<string>("scheduled-tasks-changed", (event) => {
    void refreshScheduled(event.payload);
  });
}

/// What the host tells the desk's windows when a Device presses Run now
/// (`device_scheduled.rs`).
export const RUN_NOW_REQUESTED = "scheduled-run-now-requested";

type RunNowRequested = { id: number; workspaceId: string; path: string };

/// A Device's Run now, answered by the window that fires the workspace's
/// tasks -- every other window stays silent and the host takes the one
/// answer. The run is this window's, exactly as its own button's.
export async function answerRunNowRequest(request: RunNowRequested): Promise<{ refused: string } | { value: null }> {
  const tasks = await refreshScheduled(request.workspaceId);
  const task = tasks.find((t) => t.path === request.path);
  if (!task) return { refused: "This Scheduled task is no longer on the Workstation." };
  const refused = await runScheduledNow(request.workspaceId, task);
  return refused ? { refused } : { value: null };
}

/// Listens for a Device's Run now. Desk only: started by bootstrap.
export async function initRunNowRequests(): Promise<() => void> {
  return await listen<RunNowRequested>(RUN_NOW_REQUESTED, (event) => {
    const request = event.payload;
    if (!runsRailsFor(request.workspaceId)) return;
    void answerRunNowRequest(request).then((answer) =>
      // An answer that cannot be delivered: the host's wait runs out and
      // tells the Device so.
      backend.answerScheduledRunNow(request.id, answer).catch(() => {})
    );
  });
}

/// Why a fire of `task` would be skipped right now, or null to launch:
/// the pause, the memory wall, an agent with no headless mode. Asked
/// again at every fire, because any of the three can change between
/// scheduling a task and its slot coming due. (A run still going is the
/// daemon's to see, at the claim.)
export function fireSkipReason(workspaceId: string, task: ScheduledTask): string | null {
  if (!mayStartWork(workspaceId)) return startBlockedReason(workspaceId) ?? "work is paused";
  if (!mayLaunch()) return launchBlockedReason() ?? "the Workstation is holding new agents";
  return scheduledRunBlocker(agentForCard(workspaceId, scheduledAgentFields(task)));
}

/// Launches a claimed fire headless in the workspace's main checkout and
/// records its session -- or why it could not start -- on the fire.
async function launchClaimed(workspaceId: string, task: ScheduledTask, claim: FireClaim): Promise<string | null> {
  const fireId = claim.fireId!;
  const fail = async (why: string) => {
    await backend.recordScheduledLaunch(workspaceId, fireId, null, why).catch(() => {});
    return why;
  };
  const root = workspaceRootPath(workspaceId);
  if (!root || !claim.reportPath) return fail("This workspace has no folder");
  const prepared = await prepareCursorAgentLaunch(
    workspaceId,
    root,
    agentForCard(workspaceId, scheduledAgentFields(task)),
    "headless"
  );
  if (typeof prepared === "string") return fail(prepared);
  const args = scheduledRunArgs(prepared.profileId, prepared.headlessArgs);
  if (!args) return fail(scheduledRunBlocker(prepared) ?? "no headless mode");
  let prompt: string;
  try {
    prompt = composeScheduledPrompt(mustPromptBody("action:run-scheduled", workspaceId), {
      fireNumber: claim.fireNumber,
      title: task.title,
      body: task.body,
      reportPath: claim.reportPath,
    });
  } catch (e) {
    return fail(errorText(e));
  }
  const command = buildHeadlessCommand(prepared.launchCommand, args, prompt);
  if (!command) return fail(scheduledRunBlocker(prepared) ?? "no headless mode");
  let sessionId: string;
  try {
    sessionId = await backend.createSession(root, command, root, profileIdForLaunch(prepared));
  } catch (e) {
    return fail(`The run could not start: ${errorText(e)}`);
  }
  adopted.add(sessionId);
  // Cosmetic: it only matters if the human opens the run's terminal.
  await backend.setSessionName(sessionId, `scheduled: ${task.title}`).catch(() => {});
  await backend.recordScheduledLaunch(workspaceId, fireId, sessionId, null);
  return null;
}

/// One pass over a workspace's tasks: claim each due slot at the daemon,
/// recording a skip with its reason, and launch the fires this app won.
export async function tickScheduled(workspaceId: string, now: Date = new Date()): Promise<void> {
  if (!runsRailsFor(workspaceId) || scheduledBlockedReason(workspaceId)) return;
  const tasks = get(scheduledTasks)[workspaceId] ?? [];
  let fired = false;
  for (const task of tasks) {
    const slot = dueSlot(task, now);
    if (slot === null) continue;
    fired = true;
    const skip = fireSkipReason(workspaceId, task);
    let claim: FireClaim;
    try {
      claim = await backend.claimScheduledFire(workspaceId, task.path, slot, reportStamp(now), skip);
    } catch (e) {
      scheduledErrors.update((all) => ({ ...all, [workspaceId]: errorText(e) }));
      continue;
    }
    if (claim.claimed && !claim.skipped) await launchClaimed(workspaceId, task, claim);
  }
  if (fired) await refreshScheduled(workspaceId);
}

/// Run now: one run outside the schedule, which never counts toward its
/// runs. A human pressed it, so the pause does not hold it -- the memory
/// wall does, since that protects the machine. Answers why it did not
/// start, or null.
export async function runScheduledNow(workspaceId: string, task: ScheduledTask): Promise<string | null> {
  const blocked = scheduledBlockedReason(workspaceId);
  if (blocked) return blocked;
  if (!mayLaunch()) return launchBlockedReason() ?? "the Workstation is holding new agents";
  const noAgent = scheduledRunBlocker(agentForCard(workspaceId, scheduledAgentFields(task)));
  if (noAgent) return noAgent;
  let claim: FireClaim;
  try {
    claim = await backend.claimScheduledFire(workspaceId, task.path, null, reportStamp(new Date()), null);
  } catch (e) {
    return errorText(e);
  }
  if (!claim.claimed) return claim.why ?? "The run could not be claimed";
  const why = await launchClaimed(workspaceId, task, claim);
  await refreshScheduled(workspaceId);
  return why;
}

let ticking: Promise<void> | null = null;

async function tickAll(): Promise<void> {
  if (ticking) return;
  ticking = (async () => {
    for (const ws of get(layoutState).workspaces) {
      if (!runsRailsFor(ws.id) || scheduledBlockedReason(ws.id)) continue;
      // Re-read first: the other app on this machine may have claimed
      // or finished something since this window last looked.
      await refreshScheduled(ws.id);
      await tickScheduled(ws.id);
    }
  })().finally(() => {
    ticking = null;
  });
  await ticking;
}

/// Starts the scheduler. Returns its teardown; bootstrap starts it beside
/// the rail scheduler, and the Companion never does.
export function startScheduledScheduler(): () => void {
  void tickAll();
  const timer = setInterval(() => void tickAll(), SCHEDULED_TICK_MS);
  return () => clearInterval(timer);
}
