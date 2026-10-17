// Running a workspace's tools from the phone: the desk's Tools tab, as a
// Device does it.
//
// The library and the runs are the desk's own stores, read by the desk's
// own loaders (`toolsState.ts`, `toolRunsState.ts`), and a launch is the
// desk's one tool launch (`runToolWith`) -- the same command line, the
// same run filed with the daemon. What a Device must not do is what that
// launch does to the DESK -- hold it in a queue only the desk's window
// drains, place the session on the desk's Tools page, move the desk's
// tabs to it -- so those are handed in here as the phone's own
// (`DEVICE_TOOL_HOST`), as a card's run hands in `DEVICE_LAUNCH_HOST`.
//
// Editing the library stays at the desk: its dialog is the Orchestration
// tab's, and a phone lists what it holds.
import { get } from "svelte/store";
import type { UnlistenFn } from "@tauri-apps/api/event";
import * as backend from "$lib/core/backend";
import { featureBlockedReason } from "$lib/core/daemonCompat";
import { daemonCompat, layoutState } from "$lib/core/layoutState";
import { refreshToolRuns, toolRunsStore } from "$lib/orchestration/toolRunsState";
import { initToolListeners, refreshTools, renderLibraryFor, toolRecords } from "$lib/orchestration/toolsState";
import { agentToolVerdict, isRunOpen, lastRunsFor } from "$lib/workspace/workspaceTools";
import { runToolWith, type ToolLaunchHost } from "$lib/workspace/workspaceToolsActions";
import { DEVICE_LAUNCH_HOST, readyToLaunch } from "$companion/state/cards";
import { loadLaunchTables, startedHere } from "$companion/state/sessions";
import { openTerminal } from "$companion/state/workstation";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/// A tool launch as a Device makes it (`ToolLaunchHost`).
///
/// - The launch wall refuses rather than queues, as a card's run does.
/// - The session is the desk's to place, as a labelled tab (companion-16);
///   the phone notes that it started it, which lists it until the desk has.
/// - An agent tool's terminal opens on the phone, since its first question
///   is asked there. A command or a script does not: its session can end
///   in a moment, and a terminal whose session ended closes back to the
///   Sessions list -- off the Tools surface, where the run's verdict is
///   drawn and its session is one tap away while it lasts.
export const DEVICE_TOOL_HOST: ToolLaunchHost = {
  // Read at the press rather than here: this module and the card
  // launch's reach each other through the Workstation's state.
  hold: (intent) => DEVICE_LAUNCH_HOST.hold(intent),
  place: (workspaceId, sessionId) => DEVICE_LAUNCH_HOST.place(workspaceId, sessionId),
  reveal: async (sessionId, kind) => {
    if (kind === "agent") openTerminal(sessionId);
  },
};

/// The library and its last runs, read fresh each time the surface opens:
/// the library's load-once read is the desk's, which hears every write,
/// while a phone was away for all of them. The agent tables come too --
/// an agent tool's prompt is the desk's own, customised where the desk's
/// settings customise it.
export async function loadTools(workspaceId: string): Promise<void> {
  await Promise.all([
    refreshTools(workspaceId),
    refreshToolRuns(workspaceId, get(daemonCompat)),
    loadLaunchTables(),
  ]);
}

/// Runs one of the workspace's tools with the values the page collected.
/// Resolves with what to tell the human, or null once it is running.
///
/// The tool is found again in the library rather than taken from the row:
/// the row was drawn before the agent tables arrived, and they are what
/// an agent tool's prompt is read from.
export async function runTool(
  workspaceId: string,
  toolId: string,
  values: Record<string, string>
): Promise<string | null> {
  const notReady = await readyToLaunch();
  const tool = renderLibraryFor(get(toolRecords), workspaceId).find((t) => t.id === toolId);
  if (!tool) return "This tool is no longer in the library.";
  if (tool.kind === "agent" && notReady) return notReady;
  if (isRunOpen(lastRunsFor(get(toolRunsStore), workspaceId).get(tool.id))) {
    return "This tool is already running — open its session, or wait for it to finish.";
  }
  try {
    return await runToolWith(workspaceId, tool, values, DEVICE_TOOL_HOST);
  } catch (e) {
    return `Couldn't start ${tool.name}: ${message(e)}`;
  }
}

/// A session ended at the Workstation. The daemon closes a command or a
/// script tool's run off that exit and says nothing, so every workspace
/// whose runs the phone holds reads them again -- as the desk does
/// (`startToolRunWatcher`), off the phone's own `session-exited`.
export function toolSessionEnded(): void {
  const compat = get(daemonCompat);
  for (const workspaceId of Object.keys(get(toolRunsStore))) void refreshToolRuns(workspaceId, compat);
}

/// Agent tool runs this Device has filed a verdict for, so a status that
/// flickers cannot file twice. The daemon refuses a second write anyway.
const filed = new Set<string>();

/// Files the verdict of an agent tool this phone started, by the desk's
/// rule (`agentToolVerdict`): an agent's session never exits, so nothing
/// the daemon watches closes its run. The desk files the ones it started,
/// and those of any workspace whose runs it holds; one a phone started in
/// a workspace the desk's Tools tab never read would otherwise stay
/// running until the daemon restarted and called it abandoned.
function fileVerdicts(): void {
  if (featureBlockedReason(get(daemonCompat), "toolRuns")) return;
  const state = get(layoutState);
  const mine = get(startedHere);
  const records = get(toolRecords);
  for (const [workspaceId, view] of Object.entries(get(toolRunsStore))) {
    const library = renderLibraryFor(records, workspaceId);
    for (const run of view.runs) {
      if (run.outcome !== "running" || filed.has(run.sessionId) || !(run.sessionId in mine)) continue;
      if (library.find((t) => t.id === run.toolId)?.kind !== "agent") continue;
      const verdict = agentToolVerdict(
        state.sessionStatusById[run.sessionId],
        (state.sessionsSeenWorking ?? new Set<string>()).has(run.sessionId)
      );
      if (!verdict) continue;
      filed.add(run.sessionId);
      void fileVerdict(workspaceId, run.sessionId, verdict);
    }
  }
}

async function fileVerdict(workspaceId: string, sessionId: string, outcome: "passed" | "failed"): Promise<void> {
  try {
    await backend.setToolRunOutcome(sessionId, outcome);
  } catch {
    // Left open, for a later status to try again.
    filed.delete(sessionId);
    return;
  }
  await refreshToolRuns(workspaceId, get(daemonCompat));
}

/// What keeps the tools current for a visit, whichever surface is up: an
/// agent tool's terminal is where the human is while its run ends. The
/// library an agent wrote over gavin-mcp arrives whole, as at the desk.
export async function watchTools(): Promise<UnlistenFn> {
  const stopLibrary = await initToolListeners();
  const stopLayout = layoutState.subscribe(fileVerdicts);
  const stopRuns = toolRunsStore.subscribe(fileVerdicts);
  return () => {
    stopLibrary();
    stopLayout();
    stopRuns();
    filed.clear();
  };
}
