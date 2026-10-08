// Launching "Clean stale …" from the Decisions and Review tabs.
//
// The standalone-launch seam codeReviewActions and the orchestration
// agent already use: a visible session in the workspace ROOT, revealed,
// named, bound to no card. Visible because the agent's answer is a list
// of what it closed and what it left, and that is worth reading; in the
// root because the gavin tools and the card paths it is handed both
// resolve from there.
//
// No one-at-a-time slot, unlike Organize: two cleans at once would
// mostly tick the same boxes, and a tick written twice is still one
// tick. The launch queue's own dedupe keeps a held press from queueing
// twice.
//
// What the launch does to the DESK -- queue behind the launch wall, place
// the session as a tab, jump the window to it -- is a host the caller
// hands in, as card runs and Organize take theirs. The desk's is the
// default; a Device hands in its own (companion's `state/decisions.ts`).

import { get } from "svelte/store";
import * as backend from "$lib/core/backend";
import { askConfirm } from "$lib/core/dialog";
import {
  armFailureDetection,
  handleAgentSessionSpawned,
  layoutState,
  profileIdForLaunch,
  promptExtrasFor,
  resolvedAgentFor,
  setSessionName,
} from "$lib/core/layoutState";
import { revealSession, sshLaunchBlocker, type CardLaunchHost } from "$lib/cards/cardRunActions";
import { buildRunCommand, noPromptReason, provisionalSessionName, withPromptExtras } from "$lib/cards/cardRun";
import { mustPromptBody } from "$lib/agents/actionPromptsState";
import { holdOrQueue, type CleanIntent } from "$lib/agents/launchQueue";
import {
  CLEAN_LABEL,
  cleanConfirm,
  composeCleanPrompt,
  type CleanEntry,
  type CleanKind,
} from "$lib/decisions/cleanStale";

/// Where a clean meets the surface that asked for it: a card launch's
/// wall and placing, without the jump to a card's session -- there is no
/// card -- and with putting the human in front of the run. The same shape
/// as orchestrationState's `OrchestrationLaunchHost`, so one Device host
/// serves both.
export interface CleanLaunchHost extends Pick<CardLaunchHost, "hold" | "place"> {
  reveal(sessionId: string): Promise<void>;
}

const DESK_CLEAN_HOST: CleanLaunchHost = {
  hold: (intent) => (holdOrQueue(intent) ? { go: false, error: null } : { go: true }),
  place: (workspaceId, sessionId) => handleAgentSessionSpawned(workspaceId, sessionId),
  reveal: async (sessionId) => {
    await revealSession(sessionId);
  },
};

/// Asks first, then composes the request from the list the tab is
/// showing and starts it. The error string is for the tab's own line;
/// null means it started, was queued behind the launch wall (whose badge
/// says so), or the human said not now.
///
/// The confirm lives here rather than in either tab for answerHumanItem's
/// reason: it belongs to the ACTION, and a second surface that forgot to
/// ask is exactly what it is there to prevent.
export async function requestCleanStale(
  workspaceId: string,
  kind: CleanKind,
  entries: readonly CleanEntry[],
  host: CleanLaunchHost = DESK_CLEAN_HOST
): Promise<string | null> {
  if (!(await askConfirm(cleanConfirm(kind, entries)))) return null;
  const prompt = composeCleanPrompt(
    kind,
    entries,
    mustPromptBody("action:clean-stale", workspaceId),
    mustPromptBody("action:name-tab-first", workspaceId)
  );
  return launchClean(workspaceId, CLEAN_LABEL[kind], prompt, host);
}

/// The queue's way back in. The prompt is the one composed at the press,
/// not recomposed: it is the list the human asked about.
export async function launchQueuedClean(intent: CleanIntent): Promise<void> {
  await launchClean(intent.workspaceId, intent.label, intent.prompt, DESK_CLEAN_HOST, true);
}

async function launchClean(
  workspaceId: string,
  label: string,
  prompt: string,
  host: CleanLaunchHost,
  /// The drain calling back in with an intent that has already cleared
  /// the launch wall. Asking again there would re-queue it for ever.
  queued = false
): Promise<string | null> {
  const ws = get(layoutState).workspaces.find((w) => w.id === workspaceId);
  if (!ws) return "That workspace is gone";
  const root = ws.rootPath || null;
  if (!root) return "This workspace has no root folder — set one on the Settings tab first";
  const remote = sshLaunchBlocker(workspaceId);
  if (remote) return remote;

  if (!queued) {
    const held = host.hold({ kind: "clean", workspaceId, label, prompt });
    if (!held.go) return held.error;
  }

  const agent = resolvedAgentFor(workspaceId);
  const command = buildRunCommand(
    agent.launchCommand,
    agent.promptArgs,
    withPromptExtras(prompt, promptExtrasFor(workspaceId, agent.profileId))
  );
  if (command === null) return noPromptReason(agent.label);
  let sessionId: string;
  try {
    sessionId = await backend.createSession(root, command, root, profileIdForLaunch(agent));
  } catch (e) {
    return `Couldn't start the agent: ${e instanceof Error ? e.message : e}`;
  }
  void armFailureDetection(sessionId, agent.failurePatterns, agent.untrustedOsc133);
  host.place(workspaceId, sessionId);
  // Before the rename, so a failed rename (cosmetic) cannot swallow the
  // jump to the run the human just asked for.
  await host.reveal(sessionId);
  const name = provisionalSessionName(label);
  try {
    if (name) await setSessionName(sessionId, name);
  } catch {
    // Cosmetic only.
  }
  return null;
}
