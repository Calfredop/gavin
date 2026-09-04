// Starting, picking and discarding a best-of-N run: the side-effecting
// half of bestOfN.ts.
//
// Nothing here composes a prompt or names a branch -- the pure module
// did that, and the human already agreed to the result in the dialog.
// What this file owns is the ORDER, because every step of a run creates
// something real and the order is what makes a failure survivable:
//
//   gates first (they are free), then the status write, then the
//   worktrees, then the sessions -- and every failure past the gates
//   undoes what it made.
//
// The gates run before the status write for the reason launchCard states:
// a refused launch must leave the card exactly where it was, or the human
// has to put it back by hand after a run that never happened.

import { get } from "svelte/store";
import * as backend from "./backend";
import {
  candidatesError,
  composeCandidatePrompt,
  losersOf,
  pickConfirm,
  abandonConfirm,
  runPageName,
  type BestOfNRun,
  type CandidatePlan,
  type RunCandidate,
} from "./bestOfN";
import { putRun, dropRun, bestOfNRuns, runForCard } from "./bestOfNState";
import {
  armFailureDetection,
  candidateAgentFor,
  conversationIdForLaunch,
  createTiledPage,
  layoutState,
  setSessionName,
  switchWorkspaceView,
  workspaceRootPath,
} from "./layoutState";
import { buildRunCommand, composePlanPrompt, composeTaskPrompt, noPromptReason, provisionalSessionName, runStatusNeeded } from "./cardRun";
import { developingBlocker } from "./developingCardsState";
import { resolveAttachmentsForRun } from "./cardRunActions";
import { cardSessionState } from "./columnRunAction";
import { discardWorktrees, forkWorktree } from "./gitState";
import { kanbanState, cardSessionFor, linkCardSessionAction } from "./kanbanState";
import { gavinTrees, patchPlanField, patchPlanPath } from "./gavinState";
import { setupPlan } from "./worktreeSetup";
import { stripFrontmatter } from "./planChecklist";
import { closeTabsNow } from "./tabActions";
import { askConfirmChecked } from "./dialog";
import type { CardView } from "./planBoard";

/// Launch a run: one worktree and one agent per candidate, all on one
/// tiled page named for the card. Returns an error string for the
/// board's error strip, or null.
///
/// `plans` comes from the dialog rather than being derived here, so the
/// branches and folders created are exactly the ones the human read
/// before pressing the button -- deriving them again at launch would
/// make the dialog a preview of something else.
export async function startBestOfN(
  workspaceId: string,
  card: CardView,
  plans: readonly CandidatePlan[],
  /// What every candidate forks from (`forkBase`). Required rather than
  /// defaulted to null: letting git pick would fork from whatever the
  /// Git tab happens to be pointed at, which is the one thing a
  /// comparison between agents cannot afford to vary.
  from: string | null
): Promise<string | null> {
  if (card.kind === "note") return "Notes are not runnable";

  const setError = candidatesError(plans.map((p) => p.candidate));
  if (setError) return setError;

  // A card can only carry one run: the record is keyed by card, so a
  // second one would REPLACE the first and leave three folders and three
  // branches with nothing in the app still pointing at them.
  if (runForCard(get(bestOfNRuns)[workspaceId], card.id)) {
    return "This card already has a best-of-N run — pick a candidate or discard it first";
  }
  const existing = get(kanbanState)[workspaceId];
  if (cardSessionState(get(layoutState), cardSessionFor(existing, card.id)) === "live") {
    return "This card has a live agent — jump to it, or stop it, before starting a run";
  }
  // And the same develop gate every other launch passes -- with N times
  // the reason: this one forks the card's prompt into several worktrees
  // at once, so a file mid-rewrite would be copied into all of them.
  const developing = developingBlocker(workspaceId, card.id);
  if (developing) return developing;

  // Every candidate's agent is resolved and gated BEFORE anything is
  // created: an agent that takes no prompt refuses the whole run, and
  // finding that out after two worktrees exist would leave the human to
  // clean them up.
  const agents = plans.map((plan) => candidateAgentFor(workspaceId, plan.candidate));
  const blocked = agents.findIndex((a) => a.promptArgs === null);
  if (blocked !== -1) return noPromptReason(agents[blocked].label);

  const resolved = await resolveAttachmentsForRun(workspaceId, card.attachments ?? []);
  if ("error" in resolved) return resolved.error;

  // Status FIRST, exactly as a board Run does it: running a Done card
  // un-archives it out of `plans/done/`, and every candidate's prompt has
  // to name where the file ends up rather than where it was.
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

  // `[worktree] setup` runs in every candidate's checkout, chained ahead
  // of its agent on one line. A fresh worktree has no node_modules and no
  // .env; an agent started in one before its setup is an agent debugging
  // the checkout instead of the card.
  const gavinRoot = get(gavinTrees)[workspaceId]?.rootPath ?? workspaceRootPath(workspaceId) ?? "";
  const setup = gavinRoot ? await backend.worktreeSetup(gavinRoot).catch(() => []) : [];

  const launches = plans.map((plan, i) => {
    const agent = agents[i];
    const conversationId = conversationIdForLaunch(agent);
    const command = buildRunCommand(
      agent.launchCommand,
      agent.promptArgs,
      composeCandidatePrompt(prompt, plan.label, plans.length),
      agent.sessionIdArgs,
      conversationId
    );
    // Unreachable -- the gate above returned already -- but the null is
    // the whole point of buildRunCommand's signature.
    const line = command === null ? null : setupPlan(setup, command)?.line ?? command;
    return { plan, agent, conversationId, command, line };
  });
  const nullCommand = launches.find((l) => l.line === null);
  if (nullCommand) return noPromptReason(nullCommand.agent.label);

  // The worktrees, one at a time: `git worktree add` writes to the same
  // repository metadata each time, and a failure has to name the
  // candidate it belongs to.
  const created: CandidatePlan[] = [];
  for (const plan of plans) {
    const forked = await forkWorktree(workspaceId, {
      path: plan.worktreePath,
      branch: plan.branch,
      from,
      newBranch: true,
    });
    if (!forked.ok) {
      await rollback(workspaceId, created);
      // This is the sentence the BOARD shows, so it names the candidate
      // AND quotes git. Pointing at the Git tab instead was no help to a
      // human standing in front of a card modal.
      return `Couldn't create the worktree for ${plan.label} — ${forked.error}`;
    }
    created.push(plan);
  }

  const page = await createTiledPage(
    workspaceId,
    runPageName(card.title),
    launches.map((l) => ({ cwd: l.plan.worktreePath, command: l.line as string }))
  );
  if (!page) {
    await rollback(workspaceId, created);
    return "Couldn't start the candidates' sessions";
  }

  const candidates: RunCandidate[] = launches.map((l, i) => ({
    sessionId: page.sessionIds[i],
    label: l.plan.label,
    profileId: l.plan.candidate.profileId,
    model: l.plan.candidate.model,
    branch: l.plan.branch,
    worktreePath: l.plan.worktreePath,
    command: l.command as string,
    conversationId: l.conversationId,
  }));

  for (const [i, candidate] of candidates.entries()) {
    void armFailureDetection(candidate.sessionId, agents[i].failurePatterns);
    // The candidate's label, not the card's title: on a page of N panes
    // running one card, the card is the one thing every tab has in
    // common and the agent is the only thing that tells them apart. The
    // agent's own gavin_name_session replaces this, and its prompt tells
    // it to keep the label at the front (candidatePromptSuffix).
    const name = provisionalSessionName(candidate.label);
    if (name) await setSessionName(candidate.sessionId, name);
  }

  putRun(workspaceId, {
    cardPath: path,
    cardTitle: card.title,
    pageId: page.pageId,
    startedAt: Date.now(),
    candidates,
  });

  // The run IS the thing to watch, and it was started from a hub tab
  // that shows none of it. createTiledPage has already made its page the
  // active one; this is what puts the terminal view in front of it.
  await switchWorkspaceView(workspaceId, "terminal");
  return null;
}

/// Undo a half-made run. Forced, because the worktrees may already have
/// had a setup command run in them, and best-effort, because a folder
/// left behind here is a folder the human never asked for.
async function rollback(workspaceId: string, created: readonly CandidatePlan[]): Promise<void> {
  if (created.length === 0) return;
  await discardWorktrees(
    workspaceId,
    created.map((p) => ({ path: p.worktreePath, branch: p.branch })),
    true
  );
}

/// Keep one candidate and throw the rest away. Returns an error string,
/// or null -- including for a cancelled prompt, which is not a failure.
///
/// The winner's session becomes the card's ordinary binding, with the
/// command and conversation id it was launched with, so everything the
/// board offers a bound card (jump, re-launch, resume) works on it
/// afterwards. Its worktree and branch stay exactly where they are:
/// merging is the human's action, on the Git tab, and always was.
export async function pickCandidate(
  workspaceId: string,
  run: BestOfNRun,
  winnerSessionId: string
): Promise<string | null> {
  const winner = run.candidates.find((c) => c.sessionId === winnerSessionId);
  if (!winner) return "That candidate is no longer part of this run";
  const losers = losersOf(run, winnerSessionId);

  const answer = await askConfirmChecked(pickConfirm(winner, losers));
  if (!answer.confirmed) return null;

  await closeLosers(losers);
  // The binding lands BEFORE the deletion: it is the only step that
  // records the human's choice, and a git failure must not cost them the
  // pick as well as the cleanup.
  await linkCardSessionAction(workspaceId, {
    path: run.cardPath,
    sessionId: winner.sessionId,
    cwd: winner.worktreePath,
    command: winner.command || null,
    conversationId: winner.conversationId,
    launchCwd: winner.worktreePath,
    resumeAttempts: 0,
  });
  const removed = await removeLosers(workspaceId, losers, answer.checked);
  dropRun(workspaceId, run.cardPath);
  return removed;
}

/// Throw the whole run away. The card keeps whatever status it has: the
/// run wrote In Progress when it started, and a human who discarded
/// three attempts has not thereby decided the card is not being worked.
export async function abandonRun(workspaceId: string, run: BestOfNRun): Promise<string | null> {
  const answer = await askConfirmChecked(abandonConfirm(run.candidates));
  if (!answer.confirmed) return null;
  await closeLosers(run.candidates);
  const removed = await removeLosers(workspaceId, run.candidates, answer.checked);
  dropRun(workspaceId, run.cardPath);
  return removed;
}

/// Sessions first, always. An agent still writing into a folder that is
/// being deleted produces a half-removed worktree and a confusing git
/// error, and it is the one failure here that can lose the winner's
/// cleanup too.
async function closeLosers(losers: readonly RunCandidate[]): Promise<void> {
  await closeTabsNow(losers.map((c) => c.sessionId));
}

async function removeLosers(
  workspaceId: string,
  losers: readonly RunCandidate[],
  deleteBranches: boolean
): Promise<string | null> {
  if (losers.length === 0) return null;
  const ok = await discardWorktrees(
    workspaceId,
    losers.map((c) => ({ path: c.worktreePath, branch: c.branch || null })),
    deleteBranches
  );
  return ok ? null : "Some candidate folders could not be removed — see the Git tab for git's message";
}
