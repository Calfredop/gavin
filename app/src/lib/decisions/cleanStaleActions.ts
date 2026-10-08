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

import { get } from "svelte/store";
import * as backend from "$lib/core/backend";
import {
  armFailureDetection,
  handleAgentSessionSpawned,
  layoutState,
  profileIdForLaunch,
  promptExtrasFor,
  resolvedAgentFor,
  setSessionName,
} from "$lib/core/layoutState";
import { revealSession, sshLaunchBlocker } from "$lib/cards/cardRunActions";
import { buildRunCommand, noPromptReason, provisionalSessionName, withPromptExtras } from "$lib/cards/cardRun";
import { mustPromptBody } from "$lib/agents/actionPromptsState";
import { holdOrQueue, type CleanIntent } from "$lib/agents/launchQueue";
import {
  CLEAN_LABEL,
  composeCleanPrompt,
  type CleanEntry,
  type CleanKind,
} from "$lib/decisions/cleanStale";

/// Composes the request from the list the tab is showing and starts it.
/// The error string is for the tab's own line; null means it started (or
/// was queued behind the launch wall, whose badge says so).
export function requestCleanStale(
  workspaceId: string,
  kind: CleanKind,
  entries: readonly CleanEntry[]
): Promise<string | null> {
  const prompt = composeCleanPrompt(
    kind,
    entries,
    mustPromptBody("action:clean-stale", workspaceId),
    mustPromptBody("action:name-tab-first", workspaceId)
  );
  return launchClean(workspaceId, CLEAN_LABEL[kind], prompt);
}

/// The queue's way back in. The prompt is the one composed at the press,
/// not recomposed: it is the list the human asked about.
export async function launchQueuedClean(intent: CleanIntent): Promise<void> {
  await launchClean(intent.workspaceId, intent.label, intent.prompt, true);
}

async function launchClean(
  workspaceId: string,
  label: string,
  prompt: string,
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

  if (!queued && holdOrQueue({ kind: "clean", workspaceId, label, prompt })) return null;

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
  handleAgentSessionSpawned(workspaceId, sessionId);
  // Before the rename, so a failed rename (cosmetic) cannot swallow the
  // jump to the run the human just asked for.
  await revealSession(sessionId);
  const name = provisionalSessionName(label);
  try {
    if (name) await setSessionName(sessionId, name);
  } catch {
    // Cosmetic only.
  }
  return null;
}
