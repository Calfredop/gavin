// The run flow for executable cards (card-model spec §3): spawn a
// visible agent session with a generated prompt, land it on the Agents
// page (D19 posture via handleAgentSessionSpawned), bind it to the card,
// and write In Progress. One live session per card: Run with a live
// binding jumps instead of double-spawning. The app never auto-completes.

import { get } from "svelte/store";
import * as backend from "./backend";
import { agentForCard, armFailureDetection, baseShaForLaunch, conversationIdForLaunch, layoutState, handleAgentSessionSpawned, setSessionName, switchWorkspaceView, switchToSessionInPage, workspaceRootPath } from "./layoutState";
import { gavinTrees } from "./gavinState";
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
  composeReviewLaunchPrompt,
  buildRunCommand,
  buildResumeCommand,
  withFreshConversationId,
  noPromptReason,
  provisionalSessionName,
  runStatusNeeded,
} from "./cardRun";
import {
  developingBlocker,
  developingRunOn,
  recordDevelopingCard,
} from "./developingCardsState";
import { stripFrontmatter } from "./planChecklist";
import { missingAttachmentReason, resolvedAttachmentPaths, withheldAttachmentPaths } from "./attachments";
import { INTERRUPTED_REASON, shouldQueueForMainAgent } from "./queuedInput";
import { queueFollowUp, queueTargetFor } from "./queuedInputActions";
import { cardViewForPath, type CardView } from "./planBoard";

/// The run gate for a card's attachments: the absolute paths to hand the
/// agent (and the ones it named but gavin is withholding), or the reason
/// this launch must not happen.
///
/// Stat'd HERE, immediately before spawning, rather than trusted from
/// the last scan: the daemon never stats attachments, and a file the
/// human moved five minutes ago has to stop the run rather than reach
/// the agent as a dead path. An agent handed one burns a whole session
/// before anybody notices; the card is the cheap thing to fix.
///
/// `paths` never includes an entry the host classified `outside` the
/// workspace -- `withheld` names those instead, by the raw text the card
/// used, so a launcher can tell the agent they were named but not read.
///
/// Shared with the orchestration scheduler so a rail step and a board
/// Run refuse on exactly the same evidence.
export async function resolveAttachmentsForRun(
  workspaceId: string,
  attachments: string[]
): Promise<{ paths: string[]; withheld: string[] } | { error: string }> {
  if (attachments.length === 0) return { paths: [], withheld: [] };
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
  return { paths: resolvedAttachmentPaths(statuses), withheld: withheldAttachmentPaths(statuses) };
}

/// Put the human in front of a session: the terminal view, on whichever
/// page holds it, with its tab active. False when no page holds the id
/// -- the session exited, or handleAgentSessionSpawned refused it.
///
/// Best effort by design. Every caller has ALREADY spawned by the time
/// it gets here, so a layout that has no place for the session is a
/// missed jump, never a failed launch.
export async function revealSession(sessionId: string): Promise<boolean> {
  const location = findSessionLocation(get(layoutState), sessionId);
  if (!location) return false;
  await switchWorkspaceView(location.workspaceId, "terminal");
  await switchToSessionInPage(location.workspaceId, location.pageId, sessionId);
  return true;
}

/// Puts the human in front of the agent DEVELOPING this card, if one is.
/// False when nothing is developing it (and when the reveal misses, for
/// revealSession's own reasons).
///
/// What the card's develop badge, its menu entry and a second press of
/// Develop all do: a card mid-rewrite has exactly one useful action on
/// it, and it is not another launch.
export async function revealDevelopingCard(workspaceId: string, path: string): Promise<boolean> {
  const record = developingRunOn(workspaceId, path);
  if (!record) return false;
  return await revealSession(record.sessionId);
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
  return (await revealSession(binding.sessionId)) ? "jumped" : "exited";
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

// Review (the Review tab's "Start agent session"): the same launch as a
// resume, with one thing taken away and one thing kept.
//
//  - No status write. A resume on a Done card writes In Progress, which
//    un-archives it out of `plans/done/` and drops it off the very list
//    the human is standing in. The Review tab is a place to READ
//    finished work, and a list that empties as you use it is not one.
//  - The binding's baseline, kept. The tab's whole middle column is the
//    diff since that sha; resolving a fresh one at launch would move the
//    baseline past everything the run did and report the work under
//    review as nobody's. `launchCard` already keeps it for a resume, and
//    this rides the same path for the same reason.
//
// The conversation is reopened where the profile can do it, which is the
// best "current card context" there is: the agent that did the work,
// with its own transcript, waiting for the reviewer's first question.
// Where it cannot, `composeReviewLaunchPrompt` says the same thing in
// writing -- including, explicitly, not to touch the card's status.
export function reviewCardSession(workspaceId: string, card: CardView): Promise<string | null> {
  return launchCard(workspaceId, card, "review");
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
  // A develop run already on this card is the worst version of the same
  // conflict -- BOTH agents rewrite the whole file -- so a second press
  // lands the human in the first run's tab instead of starting one. Read
  // here rather than trusted from the button, which cannot see a run
  // another window started.
  if (await revealDevelopingCard(workspaceId, card.id)) return null;

  // The card file is never read here: the skill's first move is to read
  // it, and inlining a task's body is what turns an interview into a
  // build.
  // The CARD's agent, by the same rule every other launch follows
  // (`agentForCard` -> `cardAgentEntry`): its own `agent:`/`model:` if
  // it names either, else what its `complexity:` level is attributed to,
  // else the workspace's own. Developing a card is not executing it, but
  // it is still work ON that card, and the level is the human's only
  // statement about what this card is worth -- the ⌘N composer files the
  // level and starts the develop run in ONE gesture, so a card typed as
  // intricate and developed on the spot has to reach the agent that
  // level names. Reading it there and ignoring it here is what made the
  // composer's promise false for one of the two actions it offers.
  //
  // Safe on the route whose whole point is thin cards, because "unrated"
  // is not a level: develop overwhelmingly targets a card that names
  // neither field, and `agentForCard` resolves that to EXACTLY
  // `resolvedAgentFor` -- the behaviour this route had before.
  const agent = agentForCard(workspaceId, card);
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
  // Written down BEFORE the jump, and before anything can fail after it:
  // this record is the card's only indication that it is being rewritten,
  // and the only thing standing between the run and a second agent
  // started on the same file (developingCards.ts). An unrecorded run is
  // one the next window cannot tell apart from any other agent on the
  // Agents page.
  await recordDevelopingCard(workspaceId, { path: card.id, sessionId });
  // Jump to it. Develop is the one launch with NO binding and no status
  // write (see above), so the board it was started from shows nothing at
  // all afterwards -- no session dot, no column change -- and the agent's
  // first move is to ask the human a question. Left on the board they
  // would be waiting for an answer they cannot see, in a tab they have to
  // go find on the Agents page. Before the rename below, so a failed
  // rename (cosmetic) cannot swallow the jump (the point of the action).
  await revealSession(sessionId);
  const provisional = provisionalSessionName(card.title);
  if (provisional) await setSessionName(sessionId, provisional);
  return null;
}

async function launchCard(
  workspaceId: string,
  card: CardView,
  mode: "run" | "resume" | "review",
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

  // All three gates run BEFORE the status write below. A refused launch
  // must leave the card exactly as it was: writing In Progress and then
  // refusing would move the card on the board for a run that never
  // happened, and the human would have to put it back by hand.
  //
  // Develop first, because it is the only gate about work already in
  // flight: an agent is rewriting this card's file right now, and a run
  // started on it would be executing a prompt that is about to be
  // replaced -- and writing its own status into a file the develop agent
  // is holding in its editor. Re-read here rather than trusted from the
  // button, which cannot see a run another window started.
  const developing = developingBlocker(workspaceId, card.id);
  if (developing) return developing;

  // The agent gate needs nothing from the card: an agent that takes no
  // prompt refuses every card, so resolving attachments for one is work
  // with no possible outcome.
  //
  // Which agent, though, is the card's own business: its `agent:` and
  // `model:` name one outright, its `complexity:` picks one out of the
  // two settings tables, and a card that says neither (or a level nobody
  // attributed) resolves to exactly the workspace's agent -- so this
  // reads the same as `resolvedAgentFor` did for every card that
  // predates the fields.
  const agent = agentForCard(workspaceId, card);
  if (agent.promptArgs === null) return noPromptReason(agent.label);

  const resolved = await resolveAttachmentsForRun(workspaceId, card.attachments ?? []);
  if ("error" in resolved) return resolved.error;

  // Status FIRST: running a Done card un-archives it out of `plans/done/`,
  // and the prompt has to name where the file ends up, not where it was.
  // A nested task gaining In Progress frees itself from its plan --
  // deliberate: it is actively being worked (spec §3). A resume normally
  // writes nothing here: its card already sits In Progress.
  let path = card.id;
  // A review never writes one. See reviewCardSession: the card is being
  // READ, and In Progress would take it out of the column that put it in
  // front of the reviewer, out of `plans/done/`, and off the list they
  // are looking at.
  if (mode !== "review" && runStatusNeeded(card.status)) {
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
    mode === "resume" || mode === "review"
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
      // And so does the baseline, for the same reason: a resume is this
      // run continuing. Re-resolving HEAD here would move the baseline
      // past everything the run had already done and report the work as
      // nobody's.
      baseSha: binding.baseSha ?? null,
    });
    return null;
  }

  let prompt: string;
  // A review reads the card file for BOTH kinds, unlike a run or a
  // resume: the reviewer's agent is being asked what the work was for,
  // and a plan's body is where that is written. The other two modes send
  // a plan agent to read the file itself, because they are about to
  // rewrite its checklist.
  if (mode === "review") {
    const file = await backend.readFileForViewer(path);
    if (!file.exists) return `Card file not found: ${path}`;
    prompt = composeReviewLaunchPrompt(
      path,
      card.title,
      card.kind,
      stripFrontmatter(file.content).trim(),
      resolved.paths,
      resolved.withheld
    );
  } else if (card.kind === "task") {
    const file = await backend.readFileForViewer(path);
    if (!file.exists) return `Card file not found: ${path}`;
    const body = stripFrontmatter(file.content).trim();
    prompt =
      mode === "resume"
        ? composeResumeTaskPrompt(path, card.title, body, resolved.paths, resolved.withheld)
        : composeTaskPrompt(path, card.title, body, resolved.paths, null, resolved.withheld);
  } else {
    prompt =
      mode === "resume"
        ? composeResumePlanPrompt(path, resolved.paths, resolved.withheld)
        : composePlanPrompt(path, resolved.paths, null, resolved.withheld);
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
  // A review runs WHERE THE WORK IS: the run's launch directory, which
  // is a worktree of its own whenever a rail cut one. The card's context
  // folder would put the reviewer's agent in the repository the card
  // file lives in and the diff on screen somewhere else entirely.
  // `launchCwd` and not `cwd`, for the reason runChanges.ts gives: `cwd`
  // follows the session's OSC 7 reports and drifts.
  const cwd =
    mode === "review" ? (binding?.launchCwd ?? binding?.cwd ?? card.contextFolder) : card.contextFolder;
  // Before the session exists, because that is the only moment this can
  // be asked: an agent's first minutes move HEAD and dirty the tree.
  //
  // A resume reaching here is the WRITTEN reconstruction -- the profile
  // could not reopen the conversation -- but it is still this run
  // carrying on, and the edits the first attempt made are still its
  // work. So it keeps the baseline it has, and resolves one only when
  // there is none to keep: a view starting at the resume understates
  // what the run did, but it is the only baseline that run will ever
  // have.
  //
  // A review keeps it for a stronger reason still: the baseline IS the
  // view. The tab's file list and every diff in it are taken since that
  // sha, and re-resolving one here would leave the agent bound to a card
  // whose "what this run changed" had just become empty.
  const baseSha =
    (mode === "resume" || mode === "review") && binding?.baseSha
      ? binding.baseSha
      : await baseShaForLaunch(cwd);

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
    // ...and a fresh baseline: what this run changes is measured from
    // where IT started, not from where some earlier run of the same card
    // did.
    baseSha,
  });
  return null;
}

const NO_MAIN_AGENT = "No workspace agent running — start it on the Home tab first";

/// The workspace's running main agent, or null. Exported so callers can
/// fail fast before doing work (composing a prompt reads a file).
export function mainAgentSessionId(workspaceId: string): string | null {
  return get(layoutState).workspaces.find((w) => w.id === workspaceId)?.mainSessionId ?? null;
}

/// Hands a prompt to the workspace's RUNNING main agent: bracket-pasted
/// straight into its terminal when it is free, QUEUED when it is not.
/// Returns an error string, or null.
///
/// The queue is the whole reason this is not one line. A bracketed paste
/// into a working agent lands in the middle of its turn -- somewhere in
/// its reasoning, at a prompt that is not accepting input -- and one
/// into an agent with a question on screen files a card as the answer to
/// that question. Both are silent: the paste succeeds, the terminal
/// scrolls, and the human finds out much later. The daemon holds the
/// message instead and delivers it at the next idle, which is the moment
/// a paste was ever going to be safe.
///
/// Falling back to the paste is not a fallback for convenience. Against
/// a daemon older than v29 the queue does not exist on the wire at all,
/// and this must behave exactly as it did before the feature -- a
/// silently-dropped card would be strictly worse than a badly-timed
/// paste. `shouldQueueForMainAgent` covers the rest of that judgement.
///
/// Never starts the agent: agent launches cost money and attention, and
/// that is the human's call.
export async function pasteToMainAgent(
  workspaceId: string,
  prompt: string
): Promise<string | null> {
  const mainSessionId = mainAgentSessionId(workspaceId);
  if (!mainSessionId) return NO_MAIN_AGENT;
  const state = get(layoutState);
  const target = queueTargetFor(
    state.sessionStatusById[mainSessionId],
    state.interruptedSessionIds.has(mainSessionId)
  );
  // Refused outright rather than pasted OR queued: what is in an
  // interrupted tab is a bare shell, so the paste would run the prompt as
  // a command, and the queue would hold a message that can never be
  // delivered (`interrupted` is never cleared).
  if (target.interrupted) return INTERRUPTED_REASON;
  if (!target.blockedReason && shouldQueueForMainAgent(target.status)) {
    return queueFollowUp(mainSessionId, target, prompt);
  }
  try {
    await backend.writeInput(mainSessionId, `\x1b[200~${prompt}\x1b[201~\r`);
  } catch (e) {
    return `Couldn't reach the workspace agent: ${e instanceof Error ? e.message : e}`;
  }
  return null;
}

// Hands a card to the RUNNING workspace agent (the Home panel's main
// session, D12) instead of spawning a dedicated one: the same prompt
// goes into its terminal -- pasted if the agent is free, queued if it is
// mid-turn -- the card gets In Progress, and the view jumps to Home to
// watch. No card_sessions binding -- the main agent serves many cards;
// the card's status lifecycle is the tracking. Never starts the agent
// (sub-6 invariant: agent launches cost money and attention).
//
// The jump is what makes the queued case legible without a second
// message: the human lands on the agent panel, and the follow-up queue
// strip under that terminal is already showing the card they just sent,
// with the reason it is waiting.
export async function sendToMainAgent(workspaceId: string, card: CardView): Promise<string | null> {
  if (card.kind === "note") return "Notes are not runnable";
  // Checked before composing: composing reads the card file, and "no
  // agent" is the more useful message when both are true.
  if (!mainAgentSessionId(workspaceId)) return NO_MAIN_AGENT;
  // The same develop gate a dedicated run passes, because the conflict is
  // about the CARD, not about which agent reads it: the main agent would
  // be handed the body of a file being rewritten as it read it.
  const developing = developingBlocker(workspaceId, card.id);
  if (developing) return developing;
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
    prompt = composeTaskPrompt(
      path,
      card.title,
      stripFrontmatter(file.content).trim(),
      resolved.paths,
      null,
      resolved.withheld
    );
  } else {
    prompt = composePlanPrompt(path, resolved.paths, null, resolved.withheld);
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
  // Re-launch replays the ORIGINAL prompt, which for a card being
  // developed is the very text the develop agent is replacing -- so it is
  // the launch with the most to lose from ignoring this gate, not the
  // least.
  const developing = developingBlocker(workspaceId, path);
  if (developing) return developing;
  // Through the card's OWN agent, not the workspace's, because the
  // command being replayed is the one that card LAUNCHED with -- and
  // `sessionIdArgs` below has to describe that binary. Resolving the
  // workspace's agent here would hand codex's replay claude's
  // `--session-id`, which is garbage in its argv.
  const agent = agentForCard(workspaceId, cardViewForPath(get(gavinTrees)[workspaceId], path));
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
  // Re-launch is "run this again from the beginning", so the baseline is
  // resolved again too -- in the same directory the remembered command
  // was launched in, which is where it is about to run again.
  const baseSha = await baseShaForLaunch(binding.launchCwd ?? binding.cwd);
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
    baseSha,
  });
  return null;
}
