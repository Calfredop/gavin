// The run flow for executable cards (card-model spec §3): spawn a
// visible agent session with a generated prompt, land it on the Agents
// page (D19 posture via handleAgentSessionSpawned), bind it to the card,
// and write In Progress. One live session per card: Run with a live
// binding jumps instead of double-spawning. The app never auto-completes.

import { get } from "svelte/store";
import * as backend from "./backend";
import { resolvedAgentFor, armFailureDetection, conversationIdForLaunch, layoutState, handleAgentSessionSpawned, setSessionName, switchWorkspaceView, switchToSessionInPage, workspaceRootPath } from "./layoutState";
import { findSessionLocation } from "./workspace";
import { cardSessionState } from "./columnRunAction";
import { kanbanState, cardSessionFor, linkCardSessionAction } from "./kanbanState";
import { patchPlanField, patchPlanPath } from "./gavinState";
import {
  composeTaskPrompt,
  composePlanPrompt,
  composeResumeTaskPrompt,
  composeResumePlanPrompt,
  composeDevelopPrompt,
  buildRunCommand,
  buildResumeCommand,
  withFreshConversationId,
  noPromptReason,
  provisionalSessionName,
  runStatusNeeded,
} from "./cardRun";
import { stripFrontmatter } from "./planChecklist";
import { missingAttachmentReason, resolvedAttachmentPaths } from "./attachments";
import type { CardView } from "./planBoard";

/// The run gate for a card's attachments: the absolute paths to hand the
/// agent, or the reason this launch must not happen.
///
/// Stat'd HERE, immediately before spawning, rather than trusted from
/// the last scan: the daemon never stats attachments, and a file the
/// human moved five minutes ago has to stop the run rather than reach
/// the agent as a dead path. An agent handed one burns a whole session
/// before anybody notices; the card is the cheap thing to fix.
///
/// Shared with the orchestration scheduler so a rail step and a board
/// Run refuse on exactly the same evidence.
export async function resolveAttachmentsForRun(
  workspaceId: string,
  attachments: string[]
): Promise<{ paths: string[] } | { error: string }> {
  if (attachments.length === 0) return { paths: [] };
  const root = workspaceRootPath(workspaceId);
  // Only reachable with attachments to resolve: a relative one has
  // nothing to resolve against, and guessing a base is how a card ends
  // up reading a file from whatever directory the app was launched in.
  if (root === null) {
    return { error: "This workspace has no root folder, so the card's attachments can't be resolved." };
  }
  let statuses;
  try {
    statuses = await backend.attachmentStatus(root, attachments);
  } catch (e) {
    return { error: `Couldn't check the card's attachments: ${e instanceof Error ? e.message : e}` };
  }
  const missing = missingAttachmentReason(statuses);
  if (missing) return { error: missing };
  return { paths: resolvedAttachmentPaths(statuses) };
}

// Focus a card's bound live session (card-model spec §3): "jumped" on
// success, "exited" when the binding's session is gone (Re-launch lives
// in the card detail), "interrupted" when the tab is there but holds the
// bare shell a daemon restart left behind, "none" when nothing is bound.
//
// "interrupted" never jumps. Landing the human in a dead shell and
// calling it their agent is the lie this whole change removes; the
// answer there is Resume, which the caller routes to. "failed" is the
// same refusal for the other cause of death: the tab holds an agent that
// is genuinely there and has genuinely stopped, and jumping to it would
// present a broken run as work in progress.
export async function jumpToBoundSession(
  workspaceId: string,
  path: string
): Promise<"jumped" | "interrupted" | "failed" | "exited" | "none"> {
  const binding = cardSessionFor(get(kanbanState)[workspaceId], path);
  if (!binding) return "none";
  const state = cardSessionState(get(layoutState), binding);
  if (state !== "live") return state === "none" ? "none" : state;
  const location = findSessionLocation(get(layoutState), binding.sessionId);
  if (!location) return "exited";
  await switchWorkspaceView(location.workspaceId, "terminal");
  await switchToSessionInPage(location.workspaceId, location.pageId, binding.sessionId);
  return "jumped";
}

// Returns an error string for the board's error strip, or null.
export function runCard(workspaceId: string, card: CardView): Promise<string | null> {
  return launchCard(workspaceId, card, "run");
}

// Resume: the same launch, with the prompt that tells the agent work on
// this card already happened (columnRunAction.ts). Deliberately usable
// on a card whose bound session has EXITED -- picking that work back up
// is the whole point -- and the fresh session replaces the dead
// binding. A live session still just gets a jump: it is the work.
export function resumeCard(
  workspaceId: string,
  card: CardView,
  /// Whether GAVIN decided this rather than the human pressing Resume.
  /// Only an automatic resume spends the persisted budget: a human may
  /// press the button as often as they like, and bounding that was never
  /// what the budget is for.
  options: { automatic?: boolean } = {}
): Promise<string | null> {
  return launchCard(workspaceId, card, "resume", options);
}

// Develop (the To Do column's counterpart to Resume): hand a thin card
// to the gavin-develop skill so it comes back as worked steps. It parts
// company with a run in three ways, all of them "developing is not
// starting":
//
//  - No In Progress write. The card is being SHAPED, not worked; it
//    stays in the column it is in, ready to be started afterwards.
//  - No card<->session binding. A binding would drop the card out of
//    the To Do column's "Start all" (unbound-only, columnRunAction.ts)
//    and turn its menu entry into "Re-launch agent" -- which would
//    develop it a second time instead of running it. The session is
//    still visible: handleAgentSessionSpawned lands it on Agents.
//  - A live agent on the card is a refusal, not a jump. The develop run
//    REWRITES the card file, and doing that under an agent executing it
//    is the one way this action can destroy work in flight.
export async function developCard(
  workspaceId: string,
  card: CardView
): Promise<string | null> {
  if (card.kind === "note") return "Notes are not runnable";

  const binding = cardSessionFor(get(kanbanState)[workspaceId], card.id);
  // Only a LIVE agent refuses. An interrupted binding names a bare shell
  // -- rewriting the card under it destroys nothing, and refusing there
  // left the card stuck: the binding never looked broken, so nothing
  // else offered a way forward either.
  if (cardSessionState(get(layoutState), binding) === "live") {
    return "This card has a live agent — jump to it instead of developing under it";
  }

  // The card file is never read here: the skill's first move is to read
  // it, and inlining a task's body is what turns an interview into a
  // build.
  const agent = resolvedAgentFor(workspaceId);
  const command = buildRunCommand(
    agent.launchCommand,
    agent.promptArgs,
    composeDevelopPrompt(card.id, card.title)
  );
  if (command === null) return noPromptReason(agent.label);

  let sessionId: string;
  try {
    sessionId = await backend.createSession(card.contextFolder, command);
  } catch (e) {
    return `Couldn't start the agent: ${e instanceof Error ? e.message : e}`;
  }
  // No conversation id: a develop run binds nothing, so there is no
  // record for one to outlive and nothing that could ever resume it.
  void armFailureDetection(sessionId, agent.failurePatterns);
  handleAgentSessionSpawned(workspaceId, sessionId);
  const provisional = provisionalSessionName(card.title);
  if (provisional) await setSessionName(sessionId, provisional);
  return null;
}

async function launchCard(
  workspaceId: string,
  card: CardView,
  mode: "run" | "resume",
  options: { automatic?: boolean } = {}
): Promise<string | null> {
  if (card.kind === "note") return "Notes are not runnable";

  if ((await jumpToBoundSession(workspaceId, card.id)) === "jumped") return null;
  const state = get(layoutState);
  const binding = cardSessionFor(get(kanbanState)[workspaceId], card.id);
  // Re-checked rather than trusted from the jump above, which is async:
  // a session that became live in between is still the work. An
  // INTERRUPTED binding falls through on purpose -- launching replaces
  // it, which is the only way a card gets un-stuck from a killed run.
  if (cardSessionState(state, binding) === "live") return null;

  // Both gates run BEFORE the status write below. A refused launch must
  // leave the card exactly as it was: writing In Progress and then
  // refusing would move the card on the board for a run that never
  // happened, and the human would have to put it back by hand.
  //
  // The agent gate is first and needs nothing from the card: an agent
  // that takes no prompt refuses every card, so resolving attachments
  // for one is work with no possible outcome.
  const agent = resolvedAgentFor(workspaceId);
  if (agent.promptArgs === null) return noPromptReason(agent.label);

  const resolved = await resolveAttachmentsForRun(workspaceId, card.attachments ?? []);
  if ("error" in resolved) return resolved.error;

  // Status FIRST: running a Done card un-archives it out of `plans/done/`,
  // and the prompt has to name where the file ends up, not where it was.
  // A nested task gaining In Progress frees itself from its plan --
  // deliberate: it is actively being worked (spec §3). A resume normally
  // writes nothing here: its card already sits In Progress.
  let path = card.id;
  if (runStatusNeeded(card.status)) {
    try {
      path = await backend.setPlanFrontmatterField(card.id, "status", "In Progress");
      patchPlanField(workspaceId, card.id, "status", "In Progress");
      if (path !== card.id) patchPlanPath(workspaceId, card.id, path);
    } catch (e) {
      return `Couldn't set In Progress: ${e instanceof Error ? e.message : e}`;
    }
  }

  // Resume, where the CLI can do it, is the agent reopening its OWN
  // conversation -- not a new agent reading an account of what the last
  // one was doing. The transcript is still on disk and gavin holds its
  // id because it minted it at launch, so there is nothing to
  // reconstruct.
  //
  // Only ever by an id gavin itself recorded on THIS binding, which is
  // the whole binding verification this needs: the id and the run are
  // written together on every launch, so a stale id cannot outlive the
  // run it belongs to. A resume against somebody else's conversation is
  // how you get the silent fresh start this is trying to avoid.
  //
  // The LAUNCH cwd, not the card's context folder and not the session's
  // cwd: `cwd` on the binding follows OSC 7 and drifts the moment the
  // agent moves into a worktree, and the resumed agent has to run where
  // the work is.
  const resumeCommand =
    mode === "resume"
      ? buildResumeCommand(agent.launchCommand, agent.resumeArgs, binding?.conversationId)
      : null;
  if (resumeCommand !== null && binding) {
    const resumeCwd = binding.launchCwd ?? binding.cwd;
    let resumed: string;
    try {
      resumed = await backend.createSession(resumeCwd, resumeCommand);
    } catch (e) {
      return `Couldn't resume the conversation: ${e instanceof Error ? e.message : e}`;
    }
    void armFailureDetection(resumed, agent.failurePatterns);
    handleAgentSessionSpawned(workspaceId, resumed);
    const name = provisionalSessionName(card.title);
    if (name) await setSessionName(resumed, name);
    // The SAME conversation id: resuming appends to that transcript
    // rather than rotating it (measured), so the id stays the handle on
    // this work and a second failure can be resumed the same way.
    await linkCardSessionAction(workspaceId, {
      path,
      sessionId: resumed,
      cwd: resumeCwd,
      command: resumeCommand,
      conversationId: binding.conversationId,
      launchCwd: resumeCwd,
      // The budget travels with the conversation, because that is what
      // it bounds: one AUTOMATIC resume per run. A human's press carries
      // the count unchanged -- it is not an automatic attempt, so it
      // neither spends nor refunds one.
      resumeAttempts: options.automatic
        ? (binding.resumeAttempts ?? 0) + 1
        : (binding.resumeAttempts ?? null),
    });
    return null;
  }

  let prompt: string;
  if (card.kind === "task") {
    const file = await backend.readFileForViewer(path);
    if (!file.exists) return `Card file not found: ${path}`;
    const body = stripFrontmatter(file.content).trim();
    prompt =
      mode === "resume"
        ? composeResumeTaskPrompt(path, card.title, body, resolved.paths)
        : composeTaskPrompt(path, card.title, body, resolved.paths);
  } else {
    prompt =
      mode === "resume"
        ? composeResumePlanPrompt(path, resolved.paths)
        : composePlanPrompt(path, resolved.paths);
  }

  const conversationId = conversationIdForLaunch(agent);
  const command = buildRunCommand(
    agent.launchCommand,
    agent.promptArgs,
    prompt,
    agent.sessionIdArgs,
    conversationId
  );
  // Cannot be null -- the gate above returned already -- but the null is
  // the whole point of buildRunCommand's signature, so it is checked
  // rather than asserted away.
  if (command === null) return noPromptReason(agent.label);
  const cwd = card.contextFolder;

  let sessionId: string;
  try {
    sessionId = await backend.createSession(cwd, command);
  } catch (e) {
    return `Couldn't start the agent: ${e instanceof Error ? e.message : e}`;
  }
  void armFailureDetection(sessionId, agent.failurePatterns);
  handleAgentSessionSpawned(workspaceId, sessionId);
  // Named before the agent has drawn a frame. The agent's own
  // gavin_name_session replaces this the moment it runs -- but that call
  // is the FIRST thing it does and the first thing to break when the
  // gavin tools are unreachable, and a tab labelled by a session-id
  // fragment tells the human nothing about which card is running.
  const provisional = provisionalSessionName(card.title);
  if (provisional) await setSessionName(sessionId, provisional);
  await linkCardSessionAction(workspaceId, {
    path,
    sessionId,
    cwd,
    command,
    conversationId,
    // The directory this run was LAUNCHED in, kept separate from `cwd`
    // above because that one follows the session's OSC 7 reports and
    // drifts the moment the agent moves into a worktree.
    launchCwd: cwd,
    // A fresh conversation is a fresh run, so it gets a fresh budget.
    resumeAttempts: 0,
  });
  return null;
}

const NO_MAIN_AGENT = "No workspace agent running — start it on the Home tab first";

/// The workspace's running main agent, or null. Exported so callers can
/// fail fast before doing work (composing a prompt reads a file).
export function mainAgentSessionId(workspaceId: string): string | null {
  return get(layoutState).workspaces.find((w) => w.id === workspaceId)?.mainSessionId ?? null;
}

/// Bracketed paste into the workspace's RUNNING main agent, then Enter.
/// Bracketed so a multi-line prompt arrives as one block instead of
/// line-by-line submissions. Returns an error string, or null.
///
/// Never starts the agent: agent launches cost money and attention, and
/// that is the human's call.
export async function pasteToMainAgent(
  workspaceId: string,
  prompt: string
): Promise<string | null> {
  const mainSessionId = mainAgentSessionId(workspaceId);
  if (!mainSessionId) return NO_MAIN_AGENT;
  try {
    await backend.writeInput(mainSessionId, `\x1b[200~${prompt}\x1b[201~\r`);
  } catch (e) {
    return `Couldn't reach the workspace agent: ${e instanceof Error ? e.message : e}`;
  }
  return null;
}

// Hands a card to the RUNNING workspace agent (the Home panel's main
// session, D12) instead of spawning a dedicated one: the same prompt is
// bracketed-pasted into its terminal and submitted, the card gets In
// Progress, and the view jumps to Home to watch. No card_sessions
// binding -- the main agent serves many cards; the card's status
// lifecycle is the tracking. Never starts the agent (sub-6 invariant:
// agent launches cost money and attention).
export async function sendToMainAgent(workspaceId: string, card: CardView): Promise<string | null> {
  if (card.kind === "note") return "Notes are not runnable";
  // Checked before composing: composing reads the card file, and "no
  // agent" is the more useful message when both are true.
  if (!mainAgentSessionId(workspaceId)) return NO_MAIN_AGENT;
  // Same gate, same reason, and again before the status write: handing
  // the main agent a card whose attachments have gone is the same wasted
  // session as spawning a dedicated one for it.
  const resolved = await resolveAttachmentsForRun(workspaceId, card.attachments ?? []);
  if ("error" in resolved) return resolved.error;
  // Status FIRST, for the same reason as launchCard: sending a Done card
  // un-archives it, and the agent must be handed the path it lands on.
  let path = card.id;
  if (runStatusNeeded(card.status)) {
    try {
      path = await backend.setPlanFrontmatterField(card.id, "status", "In Progress");
      patchPlanField(workspaceId, card.id, "status", "In Progress");
      if (path !== card.id) patchPlanPath(workspaceId, card.id, path);
    } catch (e) {
      return `Couldn't set In Progress: ${e instanceof Error ? e.message : e}`;
    }
  }
  let prompt: string;
  if (card.kind === "task") {
    const file = await backend.readFileForViewer(path);
    if (!file.exists) return `Card file not found: ${path}`;
    prompt = composeTaskPrompt(path, card.title, stripFrontmatter(file.content).trim(), resolved.paths);
  } else {
    prompt = composePlanPrompt(path, resolved.paths);
  }
  const pasteError = await pasteToMainAgent(workspaceId, prompt);
  if (pasteError) return pasteError;
  await switchWorkspaceView(workspaceId, "home");
  return null;
}

// Re-launch from the remembered binding (same cwd/command), replacing
// the stored session id -- the old modal's behavior, file-card edition.
export async function relaunchCard(workspaceId: string, path: string): Promise<string | null> {
  const binding = cardSessionFor(get(kanbanState)[workspaceId], path);
  if (!binding) return "No session remembered for this card";
  const agent = resolvedAgentFor(workspaceId);
  // The remembered command carries the conversation id gavin fixed at
  // launch, and running it again as-is DOES NOT WORK: `claude
  // --session-id <uuid>` refuses outright with "Session ID <uuid> is
  // already in use", so the re-launch would fail to start at all.
  // Measured, not deduced.
  //
  // A fresh id is also what this button means. Re-launch is "run this
  // again from the beginning"; reopening the old conversation is
  // Resume, which is a different entry with different words on it.
  const fresh = withFreshConversationId(binding.command, agent.sessionIdArgs);
  let sessionId: string;
  try {
    sessionId = await backend.createSession(binding.cwd, fresh.command ?? undefined);
  } catch (e) {
    return `Couldn't re-launch: ${e instanceof Error ? e.message : e}`;
  }
  void armFailureDetection(sessionId, agent.failurePatterns);
  handleAgentSessionSpawned(workspaceId, sessionId);
  await linkCardSessionAction(workspaceId, {
    ...binding,
    sessionId,
    command: fresh.command,
    conversationId: fresh.conversationId,
    // Re-launch means "run this again from the beginning": a new
    // conversation, and therefore a new budget. Spreading the old
    // binding would otherwise carry a spent one into a run that has not
    // failed yet.
    resumeAttempts: 0,
  });
  return null;
}
