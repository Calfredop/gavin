// A Device's "Commit via agent", answered at the desk.
//
// The phone asks the host (`agent_commit_for_device`), the host tells the
// desk's windows (`agent-commit-requested`) and waits, and one window
// runs the commit as its own button would and answers
// (`answer_agent_commit_request`). The phone never runs the agent: what
// it starts, the desk runs, as with a rail -- so the run is the desk's,
// shown in the desk's Git tab, written down for a restart, and drawn on
// the phone from that record.
//
// Call `startDeviceCommitRequests` once from the app root; it resolves
// with a stop function for onDestroy.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as backend from "$lib/core/backend";
import { commitViaAgentForDevice, stopAgentCommitForDevice, watchesAgentCommit } from "$lib/git/gitState";
import { runsRailsFor } from "$lib/shell/appDuty";

/// What the host tells the desk's windows, and the shape it tells it in
/// (`device_commit.rs`).
export const AGENT_COMMIT_REQUESTED = "agent-commit-requested";

export type AgentCommitRequested = { id: number; workspaceId: string } & backend.DeviceCommitRequest;

type Answer = { refused: string } | { value: unknown };

/// The window a request is for, which is the one that answers it: a
/// start, the window whose work the workspace is -- its own window, or
/// the one holding the app's duties when none shows it -- and a stop,
/// the window watching that run, which a press there may have begun.
/// Every other window stays silent, and the host takes the one answer.
export function answersRequest(request: AgentCommitRequested): boolean {
  return request.action === "start"
    ? runsRailsFor(request.workspaceId)
    : watchesAgentCommit(request.workspaceId, request.sessionId);
}

/// This window's answer: the session it started, null for a stop on its
/// way, or why not.
export async function answerRequest(request: AgentCommitRequested): Promise<Answer> {
  try {
    if (request.action === "start") {
      const started = await commitViaAgentForDevice(request.workspaceId, request.cwd);
      return "refused" in started ? started : { value: started };
    }
    const refused = await stopAgentCommitForDevice(request.workspaceId, request.sessionId);
    return refused ? { refused } : { value: null };
  } catch (e) {
    return { refused: e instanceof Error ? e.message : String(e) };
  }
}

export function startDeviceCommitRequests(): Promise<UnlistenFn> {
  return listen<AgentCommitRequested>(AGENT_COMMIT_REQUESTED, (event) => {
    const request = event.payload;
    if (!answersRequest(request)) return;
    void answerRequest(request).then((answer) =>
      // Nothing to do about an answer that cannot be delivered: the
      // host's wait runs out and tells the Device so.
      backend.answerAgentCommitRequest(request.id, answer).catch(() => {})
    );
  });
}
