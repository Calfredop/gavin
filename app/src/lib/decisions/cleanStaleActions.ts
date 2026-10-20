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
import { gavinTrees } from "$lib/core/gavinState";
import { cardViewForPath } from "$lib/core/planBoard";
import type { CardContent } from "$lib/cards/cardReview";
import { stripFrontmatter } from "$lib/cards/planChecklist";
import { ensureCardReviewed } from "$lib/cards/cardReviewActions";
import {
  revealSession,
  resolveAttachmentsForRun,
  sshLaunchBlocker,
  type CardLaunchHost,
} from "$lib/cards/cardRunActions";
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

/// Title, stripped body and attachments as developCard reads them for
/// the first-run digest — the bytes a Clean stale agent is told to open.
/// Null when the tree has no card at that path or the file is gone.
export async function cardContentForLaunch(
  workspaceId: string,
  cardPath: string
): Promise<CardContent | null> {
  const card = cardViewForPath(get(gavinTrees)[workspaceId], cardPath);
  if (!card) return null;
  const file = await backend.readFileForViewer(cardPath);
  if (!file.exists) return null;
  return {
    title: card.title,
    body: stripFrontmatter(file.content).trim(),
    attachments: card.attachments ?? [],
  };
}

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
///
/// First-run review runs before the confirm and before holdOrQueue: no
/// card content the human has not reviewed reaches the composed prompt
/// (or the queued CleanIntent snapshot). Each listed card raises the same
/// sheet develop raises when its digest is missing; a declined card is
/// withheld and named in the confirm so a mixed list can still clean the
/// ones the human accepted.
export async function requestCleanStale(
  workspaceId: string,
  kind: CleanKind,
  entries: readonly CleanEntry[],
  host: CleanLaunchHost = DESK_CLEAN_HOST
): Promise<string | null> {
  const reviewed: CleanEntry[] = [];
  const withheld: string[] = [];
  for (const entry of entries) {
    const content = await cardContentForLaunch(workspaceId, entry.cardPath);
    if (!content) {
      withheld.push(entry.title);
      continue;
    }
    const resolved = await resolveAttachmentsForRun(workspaceId, content.attachments);
    if ("error" in resolved) return resolved.error;
    if (
      await ensureCardReviewed({
        workspaceId,
        path: entry.cardPath,
        content,
        statuses: resolved.statuses,
        prompt: content.body,
        blockLabel: "The card body the agent will read:",
      })
    ) {
      reviewed.push(entry);
    } else {
      withheld.push(entry.title);
    }
  }
  if (reviewed.length === 0) {
    return withheld.length > 0 ? `Review these cards first: ${withheld.join(", ")}` : null;
  }
  if (!(await askConfirm(cleanConfirm(kind, reviewed, withheld)))) return null;
  const prompt = composeCleanPrompt(
    kind,
    reviewed,
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
