// Running a tool on its own: the launch, and the verdict.
//
// Modelled on codeReviewActions.confirmReview, which is the app's
// existing standalone-launch seam -- a visible session, revealed, named,
// bound to no card and advancing no rail. The differences from a rail
// step are all consequences of there being no rail: nothing to advance,
// no retry budget, and no auto-resume, because an auto-resume exists to
// keep a rail moving and there is no rail here to keep moving.
//
// The request/confirm split is the review dialog's, for the same reason
// it has one: a tool with parameters has to ask, and the tab is not a
// good place to own a modal -- the row is drawn by a list that a search
// box re-renders under. So the pending launch lives in a module-level
// store, one dialog draws it at the tab's root, and the same family
// (dialog.ts, contextMenu.ts, codeReviewActions.ts) already does exactly
// this.
//
// The VERDICT is split in two, and the split is the daemon's:
//
//  - A `command` or `script` tool's session exits, and its code is the
//    answer (tools spec T5). The daemon closes that row itself, off the
//    exit it already watches, so it is right even if nothing was
//    attached and even if the app was closed.
//  - An `agent` tool's session does NOT exit when its turn ends -- an
//    interactive agent sits at its prompt forever -- so nothing the
//    daemon watches would ever close the row. `startToolVerdictWatch`
//    below is the other half: it files `passed` when the session goes
//    idle after actually working, and `failed` when failure detection
//    fires, which is exactly the rule a rail's agent tool step already
//    runs on (agentTurnEnded).

import { get, writable, type Readable } from "svelte/store";
import * as backend from "$lib/core/backend";
import { buildRunCommand, buildToolCommand } from "$lib/cards/cardRun";
import { revealSession } from "$lib/cards/cardRunActions";
import { featureBlockedReason } from "$lib/core/daemonCompat";
import {
  armFailureDetection,
  conversationIdForLaunch,
  daemonCompat,
  handleAgentSessionSpawned,
  layoutState,
  resolvedAgentFor,
  setSessionName,
  workspaceRootPath,
} from "$lib/core/layoutState";
import {
  noteToolRunStarted,
  refreshToolRuns,
  startToolRunWatcher,
  toolRunsStore,
} from "$lib/orchestration/toolRunsState";
import {
  resolveToolBody,
  resolveToolCwd,
  toolPlatformBlockedReason,
  type Tool,
} from "$lib/orchestration/orchestrationTools";
import { currentPlatform } from "$lib/core/platform";
import { holdOrQueue, type ToolIntent } from "$lib/agents/launchQueue";
import { renderLibraryFor, toolRecords } from "$lib/orchestration/toolsState";
import { cannotRunAloneReason, isRunnableStandalone, runBlockedReason } from "$lib/workspace/workspaceTools";

/// A launch the human has been asked to fill the parameters of.
/// Everything the launch needs is resolved when the dialog OPENS -- the
/// workspace root cannot change while a modal is up, and resolving it
/// here is what lets the dialog say where the tool will run.
export interface ToolRunRequest {
  workspaceId: string;
  tool: Tool;
  /// Where it will run: the tool's own `cwd` resolved against the root.
  /// Shown in the dialog, because "which checkout" is the question a
  /// human asks before pressing Run on something that commits.
  cwd: string;
  /// Seeded from each parameter's default, then edited. Never the final
  /// answer -- `confirmToolRun` takes what the dialog hands back.
  values: Record<string, string>;
}

const pending = writable<ToolRunRequest | null>(null);

/// The launch awaiting its parameters, or null. Read-only: the answer
/// goes through `confirmToolRun`, so one dialog cannot launch twice.
export const toolRunRequest: Readable<ToolRunRequest | null> = { subscribe: pending.subscribe };

export function cancelToolRun(): void {
  pending.set(null);
}

/// The Run button. Returns an error string, or null.
///
/// A tool with parameters opens the dialog and returns null -- the
/// launch has not failed, it is waiting on an answer. A tool without any
/// launches immediately: asking "are you sure" about a tool whose whole
/// definition is on the row in front of the human is a click that buys
/// nothing.
export async function requestToolRun(workspaceId: string, tool: Tool): Promise<string | null> {
  const rootPath = workspaceRootPath(workspaceId);
  const blocked = runBlockedReason({
    compat: get(daemonCompat),
    rootPath,
    tool,
    lastRun: undefined,
    platform: currentPlatform(),
  });
  if (blocked) return blocked;
  const cwd = resolveToolCwd(tool, rootPath);
  if (!cwd) return "This workspace has no root folder, so there is nowhere to run a tool.";
  if (tool.params.length === 0) return launch(workspaceId, tool, {}, cwd);
  pending.set({
    workspaceId,
    tool,
    cwd,
    values: Object.fromEntries(tool.params.map((p) => [p.name, p.default])),
  });
  return null;
}

/// Launches the tool the dialog was asking about, with the values it
/// collected. Returns an error string (the dialog stays up and shows
/// it), or null (the dialog closes and the human is looking at the
/// session).
export async function confirmToolRun(values: Record<string, string>): Promise<string | null> {
  const request = get(pending);
  if (!request) return null;
  const failure = await launch(request.workspaceId, request.tool, values, request.cwd);
  if (!failure) pending.set(null);
  return failure;
}

/// The launch itself, shared by both entry points.
///
/// The command is built by exactly the functions a rail step uses --
/// `buildRunCommand` for an agent, `buildToolCommand` for a shell -- so
/// a tool run from here and the same tool run as a step are the same
/// command line. Two builders would be two ways for one tool to behave.
async function launch(
  workspaceId: string,
  tool: Tool,
  values: Record<string, string>,
  cwd: string,
  /// The drain calling back in with an intent that has already cleared
  /// the launch wall. Asking again there would re-queue it for ever.
  queued = false
): Promise<string | null> {
  if (!isRunnableStandalone(tool)) {
    // The same sentence the dark Run button carries, from the same
    // table: this path is only reachable when something bypassed that
    // button, and two wordings for one fact is two things to keep true.
    return cannotRunAloneReason(tool.kind) ?? `A ${tool.kind} tool only means something as a step.`;
  }
  // Same posture, one line down: a tool that cannot run on this OS at
  // all. The dark Run button already carries this exact sentence
  // (`runBlockedReason`), so this is the backstop for the paths that do
  // not go through the button -- a queued run draining after the machine
  // it was queued on, most of all.
  const unsupported = toolPlatformBlockedReason(tool, currentPlatform());
  if (unsupported) return unsupported;
  // The launch wall. Every tool kind, not only `agent`: a script tool
  // that runs the test suite is a build, and a build under memory
  // pressure is exactly what the hold exists for. Before the command is
  // composed, so a queued run composes its body from the tool as it is
  // when it actually starts.
  if (!queued && holdOrQueue({ kind: "tool", workspaceId, label: tool.name, toolId: tool.id, values })) {
    return null;
  }
  const body = resolveToolBody(tool, values);
  const agent = resolvedAgentFor(workspaceId);
  // Only an agent tool gets a conversation: a command or script tool is
  // a shell, and its verdict is its exit code.
  const conversationId = tool.kind === "agent" ? conversationIdForLaunch(agent) : null;
  const command =
    tool.kind === "agent"
      ? buildRunCommand(agent.launchCommand, agent.promptArgs, body, agent.sessionIdArgs, conversationId)
      : buildToolCommand(tool.kind, body, tool.name);
  // Only an agent tool can land here: a shell tool builds its own line
  // and never asks the profile for one.
  if (command === null) {
    return `${agent.label} has no verified way to take a prompt on the command line, so gavin cannot run an agent tool with it.`;
  }

  let sessionId: string;
  try {
    sessionId = await backend.createSession(cwd, command, workspaceRootPath(workspaceId) ?? undefined);

  } catch (e) {
    return `Couldn't start ${tool.name}: ${e instanceof Error ? e.message : e}`;
  }

  if (tool.kind === "agent") {
    void armFailureDetection(sessionId, agent.failurePatterns);
  }
  handleAgentSessionSpawned(workspaceId, sessionId);
  // Revealed for the reason a review is: nothing else on screen would
  // show that a tool is running, and an agent's first question would be
  // asked in a tab nobody is looking at. A shell tool's PTY can close in
  // well under a second, so this is also the only chance to see what it
  // printed.
  await revealSession(sessionId);
  try {
    // The store, not backend.setSessionName: the backend command only
    // persists the name to config and pushes nothing back, so a tab
    // named that way keeps its cwd label until the app restarts.
    await setSessionName(sessionId, tool.name);
  } catch {
    // Cosmetic only -- never a reason to fail a launch already running.
  }
  // Filed AFTER the session exists, because the row is a record of a
  // run and there is nothing to record until there is one. Best effort:
  // a run that could not be filed is a missing chip, not a reason to
  // tell the human their tool did not start when it is running in front
  // of them.
  try {
    await backend.startToolRun({
      workspaceId,
      toolId: tool.id,
      sessionId,
      command,
      launchCwd: cwd,
      conversationId,
    });
  } catch {
    // Left to the next refresh, which will simply find no row.
  }
  noteToolRunStarted({
    workspaceId,
    toolId: tool.id,
    sessionId,
    command,
    launchCwd: cwd,
    conversationId,
  });
  return null;
}

// ---- The verdict -----------------------------------------------------------

let stopVerdictWatch: (() => void) | null = null;

/// Sessions this app has already filed a verdict for, so a status that
/// flickers idle → working → idle cannot file twice.
///
/// In memory only, and that is correct rather than a shortcut: the
/// daemon refuses a second write anyway (`outcome = 'running'` is the
/// guard on the update), so this set is a way to avoid a pointless
/// request, not the thing that makes the verdict single. A reload
/// forgets it and the daemon still holds the answer.
const filed = new Set<string>();

/// Files an `agent` tool run's verdict when its session says so.
///
/// The rule is the rail's, deliberately (orchestration.ts
/// `agentTurnEnded`): an agent tool's session never exits, so its turn
/// ending IS its completion, and a broken agent -- which failure
/// detection tells apart from a quiet one by reading the rendered
/// screen -- is its failure. A tool that meant one thing on a rail and
/// another on this tab would be two tools.
///
/// No auto-resume, and that is the one rail rule NOT carried over: a
/// resume exists to get a rail moving again, and there is no rail here.
/// A failed tool run is a failed row and a Run button.
export function startToolVerdictWatch(): () => void {
  stopVerdictWatch?.();
  const unsubscribe = layoutState.subscribe((state) => {
    if (featureBlockedReason(get(daemonCompat), "toolRuns")) return;
    const records = get(toolRecords);
    for (const [workspaceId, view] of Object.entries(get(toolRunsStore))) {
      const library = renderLibraryFor(records, workspaceId);
      for (const run of view.runs) {
        if (run.outcome !== "running" || filed.has(run.sessionId)) continue;
        // An unknown tool cannot be known to be an agent -- a deleted
        // one, or a library still loading. The run keeps waiting for
        // its session to end rather than completing on a guess, exactly
        // as a rail step does.
        const tool = library.find((t) => t.id === run.toolId);
        if (tool?.kind !== "agent") continue;
        const status = state.sessionStatusById[run.sessionId];
        if (status === "failed") {
          filed.add(run.sessionId);
          void fileVerdict(workspaceId, run.sessionId, "failed");
          continue;
        }
        // Idle at the first prompt is not a finished turn — the same
        // rule a rail's agent-prompt step runs on (agentTurnEnded).
        if (status !== "idle") continue;
        const seenWorking = state.sessionsSeenWorking ?? new Set<string>();
        if (!seenWorking.has(run.sessionId)) continue;
        filed.add(run.sessionId);
        void fileVerdict(workspaceId, run.sessionId, "passed");
      }
    }
  });
  const stop = () => {
    unsubscribe();
    // Guarded: a later start owns the field, and this teardown arriving
    // afterwards must not clear the live watcher out of it.
    if (stopVerdictWatch === stop) stopVerdictWatch = null;
  };
  stopVerdictWatch = stop;
  return stop;
}

async function fileVerdict(
  workspaceId: string,
  sessionId: string,
  outcome: "passed" | "failed"
): Promise<void> {
  try {
    await backend.setToolRunOutcome(sessionId, outcome);
  } catch {
    // The row stays open and the next daemon reads it as `abandoned`,
    // which is the honest thing for a run whose end was not recorded.
    // Re-allowed, so a later emission can try again.
    filed.delete(sessionId);
    return;
  }
  await refreshToolRuns(workspaceId, get(daemonCompat));
}

/// Both watchers, started together and torn down together. Registered by
/// the app's bootstrap rather than by the tab, for the reason the rail
/// scheduler moved out of its hub view: a listener a component owns
/// stops listening the moment somebody looks at something else, which is
/// exactly when a tool finishes.
export function initWorkspaceToolListeners(): () => void {
  const stopRuns = startToolRunWatcher();
  const stopVerdicts = startToolVerdictWatch();
  return () => {
    stopRuns();
    stopVerdicts();
  };
}

/** @internal test-only reset for module-level state */
export function __resetForTesting(): void {
  stopVerdictWatch?.();
  stopVerdictWatch = null;
  filed.clear();
  pending.set(null);
}

/// The queue's way back in: run a tool intent that has already cleared
/// the gate.
///
/// The tool is re-resolved from the library rather than carried in the
/// intent, for the reason `launchQueuedCard` gives: a queued run can
/// wait minutes, and the tool may have been edited or deleted. A tool
/// that is gone does not run, and the intent is already off the queue.
export async function launchQueuedTool(intent: ToolIntent): Promise<void> {
  const rootPath = workspaceRootPath(intent.workspaceId);
  const tool = renderLibraryFor(get(toolRecords), intent.workspaceId).find((t) => t.id === intent.toolId);
  if (!tool) return;
  const cwd = resolveToolCwd(tool, rootPath);
  if (!cwd) return;
  await launch(intent.workspaceId, tool, intent.values, cwd, true);
}
