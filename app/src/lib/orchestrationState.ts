// The reactive half of orchestration: the per-workspace store, its
// persistence, and the tick that executes nextActions. Every decision
// lives in orchestration.ts; this module only holds state and performs
// effects. Shaped after kanbanState.ts on purpose -- same optimistic
// mutate, same rollback-unless-superseded, same pendingSaves guard
// against a refresh clobbering an in-flight save.

import { writable, derived, get, type Readable } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as backend from "$lib/backend";
import {
  nextActions,
  firstUnfinishedStageId,
  cardIndex,
  doneColumn,
  addRail,
  renameRail,
  setRailAutoResume,
  setRailTrigger,
  bindRail,
  deleteRail,
  deleteRails,
  addStage,
  addStep,
  addToolStep,
  removeStep,
  railStateOf,
  addCardAsStage,
  addToolAsStage,
  dropImpossibleSteps,
  setStepParams,
  moveStepIntoStage,
  moveStepToNewStage,
  splitStageIntoSequence,
  setStageMode,
  renameStage,
  moveStageToIndex,
  removeStage,
  isToolStep,
  stepParams,
  stepStateOf,
  findCardPlacement,
  sendCardToRail,
  pageToSpawnForRail,
  firstColumnOf,
  nestedChildrenOf,
  railCardsToMove,
  railDoneStepIds,
  removeSteps,
  isStageRunning,
  stepAttentions,
  findStep,
  insertStageWithSteps,
  startRailVerdict,
  startRailTargetWorkspace,
  conflictCheckout,
  railRunsDiffer,
} from "$lib/orchestration";
import type {
  Action,
  CardEntry,
  Orchestration,
  Rail,
  RailState,
  RailTrigger,
  StageMode,
  StepAttention,
  StepState,
  Step,
  ToolSummary,
} from "$lib/orchestration";
import { composeOrganizePrompt, composeRailPrompt } from "$lib/orchestrationPrompts";
import { findTool, gavinActionOf, resolveToolBody, resolveToolParam } from "$lib/orchestrationTools";
import type { Tool } from "$lib/orchestrationTools";
import {
  buildUntilScript,
  exhaustedReason,
  isPrStep,
  retrySourceFor,
  stageIdOfStep,
  untilLogPath,
  withRetryPrefix,
} from "$lib/orchestrationLoop";
import { currentPrReports, prReportFor, prReports, requestPr, startPrPolling } from "$lib/prState";
import { failingChecksNote, prExhaustedReason } from "$lib/pullRequest";
import { stepsFromTemplate } from "$lib/orchestrationGroups";
import type { GroupTemplate } from "$lib/orchestrationGroups";
import { libraryFor, toolRecords } from "$lib/toolsState";
import { kanbanState, cardSessionFor, linkCardSessionAction } from "$lib/board/kanbanState";
import { breakOutChildren, guardCompletion } from "$lib/cards/cardCompletion";
import { gavinTrees, patchPlanField } from "$lib/gavinState";
import { gitStore, refresh as refreshGit } from "$lib/gitState";
import { branchResolvable } from "$lib/git";
import { isGavinOwnPath } from "$lib/gitTracking";
import {
  layoutState,
  agentForCard,
  resolvedAgentFor,
  armFailureDetection,
  baseShaForLaunch,
  cardReviewed,
  conversationIdForLaunch,
  createSessionOnPage,
  createSessionOnNewPage,
  handleAgentSessionSpawned,
  sessionExits,
  setOrchestrationAgent,
  setSessionName,
  workspaceRootPath,
} from "$lib/layoutState";
import { decoyEditedSteps } from "$lib/worktreeCards";
import { allSessionIds } from "$lib/panes/layout";
import {
  composeTaskPrompt,
  composePlanPrompt,
  buildRunCommand,
  buildResumeCommand,
  noPromptReason,
  provisionalSessionName,
  buildToolCommand,
  runStatusNeeded,
} from "$lib/cards/cardRun";
import { stripFrontmatter } from "$lib/cards/planChecklist";
import { slugStatus } from "$lib/planBoard";
import {
  maybeNotifyReviewWait,
  setRailNotificationVoice,
  type SessionStatus,
} from "$lib/notifications";
import {
  ORGANIZE_LABEL,
  orchestrationAgentOver,
  reorganizeLabel,
} from "$lib/orchestrationAgent";
import { sessionLiveness } from "$lib/workspace";
import { developingBlocker } from "$lib/cards/developingCardsState";
import { DEVELOPING_STALL } from "$lib/cards/developingCards";
import { unreviewedStallReason } from "$lib/cards/cardReview";
import type { OrchestrationAgentRecord } from "$lib/workspace";
import { pasteToMainAgent, resolveAttachmentsForRun, revealSession } from "$lib/cards/cardRunActions";
import { activePaused, mayStartWork, nowStore } from "$lib/agentPauseState";
import {
  holdOrQueue,
  launchHolding,
  mayLaunch,
  type OrchestrationIntent,
} from "$lib/launchQueue";

export const orchestrations = writable<Record<string, Orchestration>>({});

export const saveErrors = writable<Record<string, string>>({});

export function dismissSaveError(workspaceId: string): void {
  saveErrors.update((e) => {
    if (!(workspaceId in e)) return e;
    const { [workspaceId]: _removed, ...rest } = e;
    return rest;
  });
}

/// Which conflict badge is hovered, app-wide. Hovering a box row lights
/// its chips; hovering a chip lights its rows. Ephemeral UI state, never
/// persisted -- which is why it lives here and not in the plan.
export const highlightedConflict = writable<number | null>(null);

/// Which steps a rail's own worktree has had its CARD written in, per
/// workspace and by step id -- the decoy edit (worktreeCards.ts).
///
/// Stored rather than derived, because unlike every other input to
/// `stepAttentions` this one is not in any store: it is a question about
/// files in a checkout nobody watches, and only a git call can answer
/// it. `startDecoyWatch` below is what fills it.
///
/// An absent workspace means "not looked at", never "clean". That
/// distinction is the whole reason the mark fires on presence only and
/// never on absence.
export const decoyEditsByWorkspace = writable<Record<string, ReadonlySet<string>>>({});

/// Read as EMPTY_SET, and shared so the derived below hands the same
/// object to every unswept workspace rather than a fresh one per tick.
const EMPTY_DECOYS: ReadonlySet<string> = new Set<string>();

/// Every running step that wants a human, per workspace (see
/// stepAttentions). Derived rather than stored: it is a live read of the
/// scheduler's own inputs, so it can never drift from what the rail is
/// actually doing, and it costs nothing when it turns out to be wrong.
///
/// Four surfaces read this one computation -- the step chip and card,
/// the rail header, the sidebar recap and the Orchestration hub tab --
/// which is the reason it lives here rather than in whichever of them
/// happens to be mounted. That is the same mistake startScheduler was
/// written to undo.
///
/// Every workspace, not just the active one: the sidebar shows a recap
/// per workspace, and a rail that needs you in the workspace you are not
/// looking at is exactly the one you would otherwise miss.
export const stepAttentionsByWorkspace: Readable<Record<string, Map<string, StepAttention>>> =
  derived(
    [orchestrations, kanbanState, gavinTrees, toolRecords, layoutState, decoyEditsByWorkspace, nowStore],
    ([$orchestrations, $kanban, $trees, $tools, $layout, $decoys, $now]) => {
      const statuses = new Map(Object.entries($layout.sessionStatusById));
      // `stale` is a function of the clock, so the clock has to be an
      // input: a derived store re-runs on a store change and never on
      // the passage of time. nowStore is the app's ONE ticker (30s) --
      // see agentPauseState -- so this costs no new timer and no new
      // idea of what time it is.
      const since = new Map(
        Object.entries($layout.statusSinceById ?? {}).map(([id, stamp]) => [id, stamp.at])
      );
      const out: Record<string, Map<string, StepAttention>> = {};
      for (const [workspaceId, orch] of Object.entries($orchestrations)) {
        const board = $kanban[workspaceId];
        if (!board) continue;
        out[workspaceId] = stepAttentions(
          orch,
          board,
          $trees[workspaceId],
          libraryFor($tools, workspaceId),
          statuses,
          $decoys[workspaceId] ?? EMPTY_DECOYS,
          since,
          $now
        );
      }
      return out;
    }
  );

/// How often each running step's own checkout is asked what it changed.
/// The same cadence as the pause clock and the PR sweep: a decoy write
/// is a mistake that has already happened, so nothing is lost by hearing
/// about it half a minute late, and this is a git call per running step.
const DECOY_POLL_MS = 30_000;

let decoyTimer: ReturnType<typeof setInterval> | null = null;
const decoyInFlight = new Set<string>();

/// Ask every running card step's checkout what this run has changed in
/// it, and record the ones that changed the step's own CARD.
///
/// `git_run_changes` rather than `git status`, and the difference
/// matters: the baseline is the commit the run started on, so a decoy
/// edit the agent went on to COMMIT is still reported. A plain status
/// would show it for as long as it stayed uncommitted and then go quiet
/// while the rail stayed just as wedged.
///
/// Only rails with a worktree, and only steps that are running: an
/// unbound rail has no second copy of anything, and a step that is not
/// running has no session to explain. A workspace where nothing is
/// running therefore makes no git calls at all.
///
/// Every unknown is silence, not a mark. No baseline (a run launched
/// before v26, outside a repo, or on an unborn HEAD), a failed git call,
/// a workspace whose root gavin does not know -- none of them can
/// produce a mark, so a sweep that hits one simply says nothing about
/// that step until the next one. Warn-only and thirty seconds apart:
/// nothing is stalled or persisted on the strength of this, so a mark
/// that flickers off for one sweep costs nothing, and a mark invented
/// out of an unanswered question would cost the human a search.
export async function refreshDecoyEdits(workspaceId: string): Promise<void> {
  if (decoyInFlight.has(workspaceId)) return;
  const orch = get(orchestrations)[workspaceId];
  if (!orch) return;
  // The repository root where known, the workspace's bound root
  // otherwise: run changes come back root-relative, so the two have to
  // be measured from the same place. A workspace root INSIDE a larger
  // repo simply matches nothing, which is the safe direction.
  const rootPath = get(gitStore)[workspaceId]?.repo?.root ?? workspaceRootPath(workspaceId);
  if (!rootPath) return;
  const board = get(kanbanState)[workspaceId];
  const work: Array<{ rail: Rail; cwd: string; baseSha: string }> = [];
  for (const rail of orch.rails) {
    if (!rail.worktreePath) continue;
    for (const step of rail.stages.flatMap((stage) => stage.steps)) {
      if (isToolStep(step) || stepStateOf(orch, step.id) !== "running") continue;
      const binding = board ? cardSessionFor(board, step.cardPath) : null;
      if (!binding?.baseSha) continue;
      work.push({
        rail,
        cwd: binding.launchCwd ?? rail.worktreePath,
        baseSha: binding.baseSha,
      });
    }
  }
  if (work.length === 0) {
    // Nothing running means nothing to say, and a set left behind would
    // keep marking a step whose run is over.
    setDecoyEdits(workspaceId, EMPTY_DECOYS);
    return;
  }
  decoyInFlight.add(workspaceId);
  try {
    const found = new Set<string>();
    await Promise.all(
      work.map(async ({ rail, cwd, baseSha }) => {
        const changes = await backend.gitRunChanges(cwd, baseSha).catch(() => null);
        if (!changes || changes.notARepo || changes.baseMissing) return;
        for (const id of decoyEditedSteps(rail, rootPath, changes.files)) found.add(id);
      })
    );
    setDecoyEdits(workspaceId, found);
  } finally {
    decoyInFlight.delete(workspaceId);
  }
}

function setDecoyEdits(workspaceId: string, ids: ReadonlySet<string>): void {
  decoyEditsByWorkspace.update((all) => {
    const current = all[workspaceId];
    // Same set, same object: this store feeds a derived one that four
    // surfaces render, and a fresh Set every thirty seconds would redraw
    // all of them to say nothing.
    if (current && current.size === ids.size && [...ids].every((id) => current.has(id))) {
      return all;
    }
    return { ...all, [workspaceId]: ids };
  });
}

/// Start the decoy sweep. Module-level and self-paced for the reason
/// `startScheduler` documents: a poll owned by whichever component
/// happens to be mounted stops the moment the human navigates away, and
/// a rail wedged on a decoy write is exactly what they navigated away
/// from.
export function startDecoyWatch(): () => void {
  stopDecoyWatch();
  const sweep = () => {
    for (const workspaceId of Object.keys(get(orchestrations))) {
      void refreshDecoyEdits(workspaceId);
    }
  };
  decoyTimer = setInterval(sweep, DECOY_POLL_MS);
  sweep();
  return stopDecoyWatch;
}

export function stopDecoyWatch(): void {
  if (decoyTimer !== null) clearInterval(decoyTimer);
  decoyTimer = null;
}

const pendingSaves = new Map<string, number>();

export async function fetchOrchestration(workspaceId: string): Promise<void> {
  if (workspaceId in get(orchestrations)) return;
  try {
    const orch = dropImpossibleSteps(await backend.getOrchestration(workspaceId));
    orchestrations.update((s) => ({ ...s, [workspaceId]: orch }));
  } catch {
    // Leave it unset; the tab renders its loading state and the next
    // mount retries.
    return;
  }
  // Outside the catch, so a scheduler failure is never mistaken for a
  // failed load. The plan is the one scheduler input the scheduler does
  // not subscribe to (see tickInputStores), so its arrival has to say so
  // itself -- without this, a rail left running across a restart waits
  // for some unrelated push before it notices it has work.
  await tick(workspaceId);
}

/// Re-reads from SQLite. Skipped while a save is in flight, and checked
/// again afterwards for saves that started meanwhile.
export async function refreshOrchestration(workspaceId: string): Promise<void> {
  if ((pendingSaves.get(workspaceId) ?? 0) > 0) return;
  try {
    const orch = dropImpossibleSteps(await backend.getOrchestration(workspaceId));
    if ((pendingSaves.get(workspaceId) ?? 0) > 0) return;
    orchestrations.update((s) => ({ ...s, [workspaceId]: orch }));
  } catch {
    // Keep showing what we have.
    return;
  }
  await tick(workspaceId);
}

/// Every plan edit goes through here: apply optimistically, persist the
/// whole plan, roll back on failure unless a later mutation already
/// replaced it (reference check -- and that later save carries this
/// change anyway, since the plan is persisted wholesale).
///
/// Returns the failure message as well as recording it in `saveErrors`:
/// the tab reads the store, but a caller on ANOTHER tab (a card menu on
/// the board) has its own error strip and would otherwise fail silently.
export async function mutatePlan(
  workspaceId: string,
  mutate: (orch: Orchestration) => Orchestration
): Promise<string | null> {
  const current = get(orchestrations)[workspaceId];
  if (!current) return null;
  const updated = mutate(current);
  orchestrations.update((s) => ({ ...s, [workspaceId]: updated }));
  pendingSaves.set(workspaceId, (pendingSaves.get(workspaceId) ?? 0) + 1);
  try {
    await backend.setOrchestration(workspaceId, updated.rails, updated.conflictNotes);
    dismissSaveError(workspaceId);
    return null;
  } catch (e) {
    orchestrations.update((s) => (s[workspaceId] === updated ? { ...s, [workspaceId]: current } : s));
    const message = String(e instanceof Error ? e.message : e);
    saveErrors.update((err) => ({ ...err, [workspaceId]: message }));
    return message;
  } finally {
    pendingSaves.set(workspaceId, (pendingSaves.get(workspaceId) ?? 1) - 1);
  }
}

async function mutateRunState(
  workspaceId: string,
  apply: (orch: Orchestration) => Orchestration,
  persist: () => Promise<void>
): Promise<void> {
  const current = get(orchestrations)[workspaceId];
  if (!current) return;
  const updated = apply(current);
  orchestrations.update((s) => ({ ...s, [workspaceId]: updated }));
  pendingSaves.set(workspaceId, (pendingSaves.get(workspaceId) ?? 0) + 1);
  try {
    await persist();
    dismissSaveError(workspaceId);
  } catch (e) {
    orchestrations.update((s) => (s[workspaceId] === updated ? { ...s, [workspaceId]: current } : s));
    saveErrors.update((err) => ({
      ...err,
      [workspaceId]: String(e instanceof Error ? e.message : e),
    }));
  } finally {
    pendingSaves.set(workspaceId, (pendingSaves.get(workspaceId) ?? 1) - 1);
  }
}

export function setRailRunAction(
  workspaceId: string,
  railId: string,
  state: RailState,
  currentStageId: string | null
): Promise<void> {
  return mutateRunState(
    workspaceId,
    (orch) => ({
      ...orch,
      railRuns: [
        ...orch.railRuns.filter((r) => r.railId !== railId),
        { railId, state, currentStageId },
      ],
    }),
    () => backend.setRailRun(railId, state, currentStageId)
  );
}

export function setStepRunAction(
  workspaceId: string,
  stepId: string,
  state: StepState,
  sessionId: string | null,
  reason: string | null,
  /// The agent CLI's own id for the conversation this run IS, and the
  /// directory it was launched in. Recorded on the RUN rather than the
  /// tab deliberately: the session that failed is closed or replaced
  /// long before the human decides what to do about it, and the
  /// conversation has to outlive it.
  ///
  /// `launchCwd` is not the session's cwd. `record.cwd` follows OSC 7
  /// and drifts the moment the agent `cd`s -- a repo root, then a
  /// worktree -- and a resume has to run where the WORK is.
  conversationId: string | null = null,
  launchCwd: string | null = null,
  /// How many times gavin has resumed this run BY ITSELF -- the budget
  /// for unattended recovery, bounded at one.
  ///
  /// null LEAVES the stored count alone, exactly as `conversationId`
  /// does, because most transitions of a step (a stall, a done, a rail
  /// reset) say nothing about the budget and must not spend or refund
  /// it. A LAUNCH passes 0: a new conversation is a new run, so its
  /// budget is fresh. An automatic resume passes the incremented count.
  resumeAttempts: number | null = null
): Promise<void> {
  return mutateRunState(
    workspaceId,
    (orch) => {
      // The optimistic copy has to mirror the daemon's COALESCE, or a
      // null-carrying stall would blank the budget in the store while
      // SQLite kept it -- and the next failure would read zero and
      // resume a run that has already had its one attempt.
      const previous = orch.stepRuns.find((r) => r.stepId === stepId);
      return {
        ...orch,
        stepRuns: [
          ...orch.stepRuns.filter((r) => r.stepId !== stepId),
          {
            stepId,
            state,
            sessionId,
            reason,
            conversationId: conversationId ?? previous?.conversationId ?? null,
            launchCwd: launchCwd ?? previous?.launchCwd ?? null,
            resumeAttempts: resumeAttempts ?? previous?.resumeAttempts ?? null,
          },
        ],
      };
    },
    () =>
      backend.setStepRun(stepId, state, sessionId, reason, conversationId, launchCwd, resumeAttempts)
  );
}

function railOwning(orch: Orchestration, stepId: string): Rail | null {
  return orch.rails.find((r) => r.stages.some((s) => s.steps.some((t) => t.id === stepId))) ?? null;
}

/// A rail's page while it is being made, so a second launch WAITS for it
/// rather than racing it. Keyed by rail id and cleared when the page is
/// bound.
const spawningPages = new Map<string, Promise<unknown>>();

/// The rail's page, then the session on it. The ONE seam every launch
/// that makes a session goes through -- card launch, tool launch, step
/// resume, worktree setup -- so a rail's own page is a launch-time
/// invariant. A run row reaches the store by more routes than Start: an
/// agent writing SetRailRun straight to the daemon socket, a rail left
/// running across a restart, a push for a workspace not loaded yet.
/// Before this seam, every such rail launched onto the workspace's
/// ACTIVE page (createSessionOnPage's null fallback) and kept doing so
/// for every later stage, retry and resume -- twenty tabs on "Page 1".
///
/// A running rail gets a page of its OWN, named after it (spec O16): its
/// agents get a home they can be found in rather than piling onto the
/// workspace's active page with everyone else's. Only when the rail has
/// no live page binding -- an explicit one is never overridden, and a
/// rail that already has a page just gains a tab on it.
///
/// The page is built AROUND this session (createSessionOnNewPage), not
/// beside it. Making the page first and landing the session on it
/// afterwards is what opened every rail page on a blank shell nobody
/// asked for, first in the tab strip for the life of the page: createPage
/// spawns the shells itself, so the agent the page existed for arrived as
/// tab two. It is also why ARMING no longer spawns the page ahead of the
/// first launch -- at that moment there is no session to build it around,
/// and a page with no tabs is not something this app can draw. A rail
/// that runs nothing needs no page.
///
/// Not a stall when the page cannot be made: the binding stays null and
/// the session takes the Agents-page fallback (spec §4.3 step 4). A page
/// is where agents land, not a precondition for running them.
async function createSessionOnRailPage(
  workspaceId: string,
  railId: string,
  cwd: string,
  command: string | null
): Promise<string | null> {
  // One page per rail even under a double Start: making it is an await
  // long enough for a second launch to arrive while the rail is still
  // unbound, and two pages named after one rail is exactly what
  // pageToSpawnForRail's deduping exists to prevent. The second caller
  // WAITS for the first instead of giving up on a page -- giving up used
  // to drop that session on the Agents page -- and what it waits for
  // resolves only once the binding is WRITTEN, so the rail it re-reads
  // below is the bound one.
  const pending = spawningPages.get(railId);
  if (pending) await pending;
  else {
    const sessionId = await spawnRailPageFor(workspaceId, railId, cwd, command);
    if (sessionId) return sessionId;
  }
  const pageId =
    get(orchestrations)[workspaceId]?.rails.find((r) => r.id === railId)?.pageId ?? null;
  return createSessionOnPage(workspaceId, pageId, cwd, command);
}

/// The rail's page and its first tab in one act, or null when the rail
/// already has a page (or is gone). The session's own cwd is the page's
/// -- a rail's launch already carries its checkout, spelled the way
/// executeToolLaunch spells it -- so the page is the rail's in the way
/// that matters, not just by name.
///
/// Everything from the lookup to the spawningPages write runs in ONE
/// synchronous turn, deliberately: an await before that write would let
/// a simultaneous launch read the map before the first wrote it, and
/// both would then spawn a page. That is why the caller's guard above is
/// a plain map read and not an `await spawningPages.get(...)`.
async function spawnRailPageFor(
  workspaceId: string,
  railId: string,
  cwd: string,
  command: string | null
): Promise<string | null> {
  const rail = get(orchestrations)[workspaceId]?.rails.find((r) => r.id === railId);
  if (!rail) return null;
  const pages = get(layoutState).workspaces.find((w) => w.id === workspaceId)?.pages ?? [];
  const name = pageToSpawnForRail(rail, pages);
  if (name === null) return null;
  const spawning = spawnRailPage(workspaceId, railId, name, cwd, command);
  spawningPages.set(railId, spawning.catch(() => null));
  try {
    return (await spawning)?.sessionId ?? null;
  } finally {
    spawningPages.delete(railId);
  }
}

/// Bound only once the page exists, and awaited by whoever the guard
/// above is holding -- a waiter that resumed on a half-written binding
/// would find its rail naming a page the layout does not have yet, read
/// that as the closed-page case, and spawn a second one.
async function spawnRailPage(
  workspaceId: string,
  railId: string,
  name: string,
  cwd: string,
  command: string | null
): Promise<{ pageId: string; sessionId: string } | null> {
  const made = await createSessionOnNewPage(workspaceId, name, cwd, command, {
    // The human is on the Orchestration tab -- they pressed Start there.
    // The page appears in the sidebar and the rail's chip names it;
    // taking the screen as well would be a jump they did not ask for,
    // and unbearable when arming several rails in a row.
    activate: false,
  });
  if (made) await mutatePlan(workspaceId, (orch) => bindRail(orch, railId, { pageId: made.pageId }));
  return made;
}

/// A session on the rail's page that is not a step: the `[worktree] setup`
/// a freshly forked worktree runs when a rail is bound to it. It goes
/// through the same seam every step launch does, because the alternative
/// is the one this seam exists to prevent — the setup for THIS rail's
/// worktree landing as another tab on the workspace's active page, beside
/// everyone else's work, while the rail's own page sits empty.
///
/// No run row and no step: nothing in the plan is running, so the rail
/// stays idle and its Start still begins at the first stage.
export async function runOnRailPage(
  workspaceId: string,
  railId: string,
  cwd: string,
  command: string
): Promise<void> {
  await createSessionOnRailPage(workspaceId, railId, cwd, command);
}

export async function startRail(workspaceId: string, railId: string): Promise<void> {
  const orch = get(orchestrations)[workspaceId];
  const rail = orch?.rails.find((r) => r.id === railId);
  if (!rail) return;
  const stageId = firstUnfinishedStageId(rail, orch);
  if (!stageId) return;
  // No page is spawned here. The rail's page is made by its first launch
  // (createSessionOnRailPage), around the session that launch creates --
  // arming it earlier meant opening a blank shell to have something to
  // put on the page, and that shell then sat first in the tab strip
  // forever. A rail that arms and launches nothing needs no page.
  await setRailRunAction(workspaceId, railId, "running", stageId);
  await tick(workspaceId);
}

export async function pauseRail(workspaceId: string, railId: string): Promise<void> {
  const orch = get(orchestrations)[workspaceId];
  const current = orch?.railRuns.find((r) => r.railId === railId)?.currentStageId ?? null;
  await setRailRunAction(workspaceId, railId, "paused", current);
}

/// Resume picks up where the pause left off -- but only if that stage is
/// still there. A stage swept out from under a PAUSED rail (an edit, a
/// reorganize, a "Clear done" that landed while it was paused) leaves
/// `currentStageId` naming nothing, and nextActions, finding no stage to
/// point at, would call the rail COMPLETE and idle it. So a stale id is
/// dropped and the rail re-arms at the first unfinished stage, exactly
/// as Start would. `clearDoneStepsAction` does the same repair for the
/// running case, where it can do it at the moment of the write.
export async function resumeRail(workspaceId: string, railId: string): Promise<void> {
  const orch = get(orchestrations)[workspaceId];
  const rail = orch?.rails.find((r) => r.id === railId);
  if (!rail) return;
  const current = orch.railRuns.find((r) => r.railId === railId)?.currentStageId ?? null;
  // A page closed while the rail sat paused is replaced by the first
  // launch after this, for the same reason Start spawns none.
  const stageId =
    current && rail.stages.some((s) => s.id === current)
      ? current
      : firstUnfinishedStageId(rail, orch);
  await setRailRunAction(workspaceId, railId, "running", stageId);
  await tick(workspaceId);
}

/// Clears run state for the rail. Never touches card statuses -- the
/// board is the human's record, not the scheduler's scratch space.
export async function resetRail(workspaceId: string, railId: string): Promise<void> {
  const orch = get(orchestrations)[workspaceId];
  const rail = orch?.rails.find((r) => r.id === railId);
  if (!rail) return;
  for (const stage of rail.stages) {
    for (const step of stage.steps) {
      // `0`, not the usual null: this is a run starting over, and the
      // one counter a re-launch does NOT rewrite is an `until` step's
      // loop budget (see executeToolLaunch). Every other step is zeroed
      // by its own launch anyway, so passing it here changes nothing for
      // them -- and a rail Reset that left a spent budget behind would
      // give the loop one attempt and then stall.
      await setStepRunAction(workspaceId, step.id, "pending", null, null, null, null, 0);
    }
  }
  await setRailRunAction(workspaceId, railId, "idle", null);
}

/// A stalled step returns to pending with its reason cleared; the next
/// tick re-reads the card and re-checks the worktree rather than
/// replaying the old command (spec §6.2).
export async function retryStep(workspaceId: string, stepId: string): Promise<void> {
  // `0` for the same reason resetRail passes it: a Retry is a fresh
  // attempt, and an `until` step's loop budget is the one count no
  // launch clears.
  await setStepRunAction(workspaceId, stepId, "pending", null, null, null, null, 0);
  await tick(workspaceId);
}

/// Reopen a stalled step's OWN conversation, in place, rather than
/// running it again from the beginning.
///
/// Rule 2's retry -- what `retryStep` does -- re-derives the blocker and
/// launches a FRESH agent with a fresh prompt, which is right for a step
/// that never started and wrong for one whose agent broke mid-turn: the
/// checkout already carries the first attempt's edits, and a second
/// from-scratch run over them is the bug the interrupted-runs card
/// exists to prevent. The step's `conversationId` and `launchCwd` were
/// recorded at launch for exactly this.
///
/// Returns an error string, or null. Nothing here throws: a resume that
/// cannot happen leaves the step stalled with a reason, which is where
/// it already was.
export async function resumeStep(
  workspaceId: string,
  stepId: string,
  /// Whether GAVIN decided this, rather than the human pressing a
  /// button. Only an automatic resume spends the persisted budget: a
  /// human may press Resume as often as they like, and bounding that
  /// was never what the budget is for.
  options: { automatic?: boolean } = {}
): Promise<string | null> {
  const orch = get(orchestrations)[workspaceId];
  const rail = orch ? railOwning(orch, stepId) : null;
  const step = rail?.stages.flatMap((s) => s.steps).find((t) => t.id === stepId);
  const run = orch?.stepRuns.find((r) => r.stepId === stepId);
  if (!orch || !rail || !step || !run) return "This step is no longer on any rail";

  // Through the CARD's own agent where there is a card -- its
  // `agent:`/`model:` if it names either, else its complexity level --
  // so a resume reopens the conversation with the same binary that
  // started it. A tool step has no card and resolves to the workspace's
  // agent, which is what it launched with.
  const resumingCard = isToolStep(step)
    ? null
    : (cardIndex(get(gavinTrees)[workspaceId]).get(step.cardPath)?.plan ?? null);
  const agent = agentForCard(workspaceId, resumingCard);
  const command = buildResumeCommand(agent.launchCommand, agent.resumeArgs, run.conversationId);
  if (!command) {
    // Either the profile verified no resume argv, or this run predates
    // the conversation id. Both mean the same thing and neither is an
    // error worth a stall of its own: reopening is not available, and
    // Retry (a fresh run) is the honest alternative.
    return "This run has no conversation to reopen — use Retry to start it again";
  }

  // The LAUNCH cwd, not the session's: `cwd` on a session follows OSC 7
  // and drifts the moment the agent moves into a worktree, and the
  // resumed agent has to run where the work is.
  const cwd = run.launchCwd ?? rail.worktreePath ?? null;
  if (!cwd) return "Nothing recorded where this run was launched, so it cannot be reopened there";

  let sessionId: string | null;
  try {
    sessionId = await createSessionOnRailPage(workspaceId, rail.id, cwd, command);
  } catch (e) {
    return `Couldn't reopen the conversation: ${e instanceof Error ? e.message : e}`;
  }
  if (!sessionId) return "Couldn't reopen the conversation";
  void armFailureDetection(sessionId, agent.failurePatterns);

  const entry = cardIndex(get(gavinTrees)[workspaceId]).get(step.cardPath);
  const label = entry?.plan.title ?? step.cardPath;
  const provisional = provisionalSessionName(label);
  if (provisional) {
    try {
      await setSessionName(sessionId, provisional);
    } catch {
      // Cosmetic only; the agent is already running.
    }
  }

  // A CARD step's binding has to follow, or the board keeps pointing at
  // the broken session while the rail points at the live one -- and the
  // card's own Resume would then reopen a conversation that is already
  // open. The SAME conversation id: resuming appends to that transcript
  // rather than rotating it (measured), so the id stays the handle.
  if (!isToolStep(step) && entry) {
    await linkCardSessionAction(workspaceId, {
      path: step.cardPath,
      sessionId,
      cwd,
      command,
      conversationId: run.conversationId ?? null,
      launchCwd: cwd,
      resumeAttempts: options.automatic ? (run.resumeAttempts ?? 0) + 1 : (run.resumeAttempts ?? null),
      // Carried, never re-resolved: this is the same run continuing, and
      // a baseline moved to the resume's HEAD would credit everything
      // the first attempt did to nobody.
      baseSha: cardSessionFor(get(kanbanState)[workspaceId], step.cardPath)?.baseSha ?? null,
    });
  }

  await setStepRunAction(
    workspaceId,
    stepId,
    "running",
    sessionId,
    null,
    run.conversationId ?? null,
    cwd,
    options.automatic ? (run.resumeAttempts ?? 0) + 1 : null
  );

  // Rule 5 paused the rail when the step stalled, and a resumed step on
  // a paused rail would finish and then advance nothing. Only the rail
  // this step belongs to, and only from `paused`: a rail the human left
  // idle stays idle -- reopening one step is not starting the rail.
  if (railStateOf(get(orchestrations)[workspaceId], rail.id) === "paused") {
    const current = get(orchestrations)[workspaceId].railRuns.find(
      (r) => r.railId === rail.id
    )?.currentStageId;
    // The stage this STEP sits in when the rail has no current one -- a
    // step id would be accepted here and name nothing, leaving the rail
    // running at a stage that does not exist.
    const owning = rail.stages.find((g) => g.steps.some((t) => t.id === stepId))?.id ?? null;
    await setRailRunAction(workspaceId, rail.id, "running", current ?? owning);
  }
  await tick(workspaceId);
  return null;
}

/// The human's override for a step whose completion signal never
/// arrives: file it done and let the rail move on, rather than deleting
/// the session and the step to unwedge the rail (which is what this bug
/// cost before there was a button for it).
///
/// The session id is kept, exactly as executeActions' own markDone keeps
/// it: the step is finished, but its transcript stays reachable from the
/// chip. Nothing is killed either -- a live session the human has judged
/// finished is still theirs to read, and to keep using.
export async function markStepDone(workspaceId: string, stepId: string): Promise<void> {
  const sessionId =
    get(orchestrations)[workspaceId]?.stepRuns.find((r) => r.stepId === stepId)?.sessionId ?? null;
  await setStepRunAction(workspaceId, stepId, "done", sessionId, null);
  await tick(workspaceId);
}

/// "Skip and proceed" -- the OTHER honest answer to a step that is not
/// going to finish, and the one Mark done was being misused for.
///
/// Mark done says the work happened; a human who only wants the rail to
/// move on had to say that anyway, and every surface downstream then
/// counted a step nobody ran as delivered work -- the rail recap, the
/// stage tally, the prompt an orchestration agent reads. `skipped` is a
/// terminal state that says the opposite out loud: the rail is past this
/// step BECAUSE someone decided it would not run.
///
/// Two halves, and the second is the "and proceed":
///
/// 1. The run row goes `skipped`, keeping the session id and the session
///    itself, exactly as markStepDone does. The human has judged the step
///    not worth finishing, not the transcript not worth reading -- and
///    killing a live agent is a decision they can still make from the
///    session itself, which is where it belongs.
/// 2. A PAUSED rail is put back to `running`. Rule 5 pauses a rail
///    around a stall, so the step most worth skipping sits on a rail
///    that would otherwise skip it and then advance nothing -- the same
///    trap resumeStep documents. Only from `paused`: a rail the human
///    left idle stays idle, because skipping one step is not starting a
///    rail.
export async function skipStep(workspaceId: string, stepId: string): Promise<void> {
  const orch = get(orchestrations)[workspaceId];
  const sessionId = orch?.stepRuns.find((r) => r.stepId === stepId)?.sessionId ?? null;
  const rail = orch ? railOwning(orch, stepId) : null;
  // The reason goes with it: whatever stalled the step is no longer the
  // reason the rail is where it is, and a bubble still quoting it would
  // describe a decision nobody made.
  await setStepRunAction(workspaceId, stepId, "skipped", sessionId, null);

  if (rail && railStateOf(get(orchestrations)[workspaceId], rail.id) === "paused") {
    const current = get(orchestrations)[workspaceId].railRuns.find(
      (r) => r.railId === rail.id
    )?.currentStageId;
    // The stage this STEP sits in when the rail has no current one -- a
    // step id would be accepted here and name nothing, leaving the rail
    // running at a stage that does not exist (see resumeStep).
    const owning = rail.stages.find((g) => g.steps.some((t) => t.id === stepId))?.id ?? null;
    await setRailRunAction(workspaceId, rail.id, "running", current ?? owning);
  }
  await tick(workspaceId);
}

/// What a check step wrote, or "". Its own session's scrollback would be
/// the obvious source and is not usable: an xterm `Terminal` exists only
/// where a pane built one, and a rail's page is routinely one the human
/// never opened. So the check tees to a file (see buildUntilScript) and
/// both readers -- the retried prompt and the exhausted stall reason --
/// read that.
///
/// Never throws. A missing or unreadable log means the quote is dropped,
/// not that the loop breaks.
async function readCheckLog(untilStepId: string): Promise<string> {
  try {
    const file = await backend.readFileForViewer(untilLogPath(untilStepId));
    return file.exists ? file.content : "";
  } catch {
    return "";
  }
}

/// The check output that must OPEN this step's prompt, or null when this
/// launch is not part of a loop.
///
/// Derived from the plan and the run rows rather than remembered: see
/// retryLogFor. A note held in a variable between the re-arm and the
/// launch would be lost by exactly the app reload this design survives.
async function retryNoteFor(
  workspaceId: string,
  rail: Rail,
  stepId: string
): Promise<string | null> {
  const orch = get(orchestrations)[workspaceId];
  const library = libraryFor(get(toolRecords), workspaceId);
  // null is "still loading", not "no tools": guessing here would drop
  // the failure from the prompt and send the agent back in blind.
  if (!orch || !library) return null;
  const source = retrySourceFor(rail, stepId, orch, new Map(library.map((t) => [t.id, t.kind])));
  if (!source) return null;
  // A pull-request loop has no log: the failure is in the live report
  // the poll already holds, which is the same reading the chips beside
  // this rail are drawn from. Derived at launch time for the reason
  // retrySourceFor gives -- nothing is remembered between the re-arm and
  // the launch, so a reload in between changes nothing.
  if (source.kind === "pr") {
    const tree = get(gavinTrees)[workspaceId];
    const checkout = conflictCheckout(rail, tree);
    const report = prReportFor(currentPrReports(), checkout, rail.branch);
    const note = report ? failingChecksNote(report) : "";
    return note.trim() ? note : null;
  }
  try {
    const file = await backend.readFileForViewer(source.path);
    return file.exists && file.content.trim() ? file.content : null;
  } catch {
    return null;
  }
}

/// Run a `gavin` tool: an action the app performs itself, with no
/// session, no checkout and no exit code (tools spec T9). It resolves
/// synchronously, so the step never passes through `running` -- there is
/// nothing to watch and no verdict to wait for, and every rule that
/// reconciles a dead session is therefore silent about it.
///
/// Returns whether the tick that ran it should run AGAIN, for the same
/// reason executeSwitchBranch does: this step is DONE by the time it
/// returns, and the pass that scheduled it decided the stage's fate
/// before that was true. Nothing else would ever say so -- a session's
/// exit or status is what ticks after every other launch, and this one
/// starts no session. `orchestrations` is deliberately not a scheduler
/// input, so the write below wakes nothing by itself.
///
/// The target rail defaults to this one's own workspace but need not be:
/// `startRailTargetWorkspace` reads the step's `workspace` parameter, and
/// `workspaceId` below stays the CALLING rail's -- every other write in
/// this function (the stall, the step's own `done`) still belongs to it,
/// only the armed rail moves to `targetWorkspaceId`.
async function executeGavinAction(
  workspaceId: string,
  rail: Rail,
  step: Step,
  tool: Tool
): Promise<boolean> {
  const stall = (reason: string): Promise<void> =>
    setStepRunAction(workspaceId, step.id, "stalled", null, reason);

  // A tool the human duplicated and re-pointed, or one shipped by a
  // NEWER gavin whose plan this daemon still holds. Naming the body is
  // what makes that second case diagnosable.
  if (gavinActionOf(tool) !== "start-rail") {
    await stall(`“${tool.body.trim()}” is not an action this version of gavin knows`);
    return false;
  }

  const target = startRailTargetWorkspace(
    get(layoutState).workspaces,
    workspaceId,
    resolveToolParam(tool, stepParams(step), "workspace")
  );
  if (target.kind === "refuse") {
    await stall(target.reason);
    return false;
  }
  const targetWorkspaceId = target.workspaceId;

  // The target may be a workspace this app has never fetched -- the
  // sidebar warms every ROOTED workspace's plan for its own recap, but a
  // step can still race that on a cold start. Same guard
  // sendCardToRailAction uses, for the same reason: fetch on demand
  // rather than stalling on a plan that simply has not landed yet.
  if (!get(orchestrations)[targetWorkspaceId]) await fetchOrchestration(targetWorkspaceId);
  const orch = get(orchestrations)[targetWorkspaceId];
  if (!orch) return false;
  const verdict = startRailVerdict(orch, rail.id, resolveToolParam(tool, stepParams(step), "rail"));
  if (verdict.kind === "refuse") {
    await stall(verdict.reason);
    // A stall is rule 5's business and it already paused this rail;
    // re-ticking would only re-read a rail that is going nowhere.
    return false;
  }

  // Done BEFORE the target is armed, and that order is load-bearing:
  // startRail ticks, this workspace's tick is already in flight, so the
  // call only queues a replay -- which then re-reads this step. Left
  // pending, it would be launched a second time.
  await setStepRunAction(workspaceId, step.id, "done", null, null);
  // A rail already running, or with nothing left to run, is a no-op and
  // not a failure -- the same posture builtin:commit takes on a clean
  // tree. Calling startRail on either would REWIND it (see
  // startRailVerdict), which is the one outcome worse than doing nothing.
  if (verdict.kind === "start") await startRail(targetWorkspaceId, verdict.railId);
  return true;
}

/// Launch a TOOL step (tools spec §3). Nothing card-shaped happens here:
/// no card_sessions binding and no "In Progress" write, because a tool
/// is not a card and has no status to keep.
/// Returns whether the tick should run again -- true only for a `gavin`
/// action, which finishes its step inside this call (see below). Every
/// other tool leaves a session running, and its own end is what ticks.
async function executeToolLaunch(
  workspaceId: string,
  rail: Rail,
  step: Step
): Promise<boolean> {
  // null is "not fetched yet", NOT "empty" -- stalling here would turn a
  // cold start into a stalled rail. Leaving the step `pending` and
  // writing nothing is safe: the tab re-ticks when the library lands
  // (its $effect watches toolRecords), and nextActions will re-issue
  // this same launch. nextActions makes the matching choice, passing a
  // null library through launchBlocker rather than blocking on it.
  const library = libraryFor(get(toolRecords), workspaceId);
  if (library === null) return false;

  const tool = findTool(library, step.toolId as string);
  if (!tool) {
    await setStepRunAction(workspaceId, step.id, "stalled", null, "tool is no longer in the library");
    return false;
  }

  // Before the checkout: a gavin action needs neither, and stalling one
  // on an unbound rail with no root would be a refusal about something
  // it was never going to touch.
  if (tool.kind === "gavin") {
    return await executeGavinAction(workspaceId, rail, step, tool);
  }

  // A `pr` step launches NOTHING. gavin does the waiting itself, off the
  // poll behind the rail's PR chips, and the step is over when GitHub
  // says so (nextActions rule 3f).
  //
  // It still goes `running`, unlike a `gavin` action, and that is the
  // whole difference between the two kinds: waiting is a state, and a
  // step that resolved inside its launch could not wait at all. What it
  // does NOT do is take a session id, so every rule that reconciles a
  // dead session steps around it.
  if (tool.kind === "pr") {
    if (!rail.branch) {
      // launchBlocker refuses this before the launch; re-derived here
      // for the same reason executeToolLaunch re-derives the others --
      // the pass that scheduled this ran against a library that may not
      // have loaded, and an unbound rail must never leave a step
      // waiting on a pull request that cannot exist.
      await setStepRunAction(
        workspaceId,
        step.id,
        "stalled",
        null,
        "this rail binds no branch, so there is no pull request to wait for"
      );
      return false;
    }
    // Warm the poll before the first tick asks: without this the step
    // would wait a poll cycle for its own report to exist.
    requestPr(conflictCheckout(rail, get(gavinTrees)[workspaceId]), rail.branch);
    // `null`, not 0, for exactly the reason the `until` kind passes null
    // below: the same field carries the LOOP budget, and zeroing it here
    // would make the budget unspendable and the loop unbounded.
    await setStepRunAction(workspaceId, step.id, "running", null, null, null, null, null);
    return false;
  }

  // A `review` step launches nothing either, and waits on a PERSON. Like
  // the wait above it goes `running` and takes no session, so every rule
  // that reconciles a dead session steps around it (nextActions rule
  // 3g); unlike it, nothing gavin can poll will ever end it. The step is
  // over when the human presses Skip or Mark done on the chip, which are
  // the same two buttons every running step already offers.
  //
  // No branch is checked, and no cwd is resolved. A review needs
  // neither: it is a hold on the rail, and refusing to hold an UNBOUND
  // rail would be a refusal about something the step was never going to
  // touch. (launchBlocker's last test still applies, as it does to every
  // kind: a rail whose worktree has been removed stalls before it gets
  // here. That one is not about what the step touches -- the checkout
  // the human was going to review is gone.)
  if (tool.kind === "review") {
    // 0, not null: the `resumeAttempts` field carries a LOOP's budget
    // (see orchestrationLoop.ts) and this step neither loops nor
    // auto-resumes, so it starts from a clean count like every other
    // non-looping step. Leaving a stale count behind would make the
    // rail header claim a retry that is not happening.
    await setStepRunAction(workspaceId, step.id, "running", null, null, null, null, 0);
    // The rail may well be running unattended on a tab nobody is
    // looking at, and a gate that summons nobody is a gate that stops
    // the rail until somebody happens to check. Rides the workspace's
    // `needsInput` toggle, because "come and look at this" is exactly
    // what that toggle answers for.
    const ws = get(layoutState).workspaces.find((w) => w.id === workspaceId);
    void maybeNotifyReviewWait(rail.name, tool.name, {
      needsInput: ws?.notifyNeedsInput ?? true,
      finished: ws?.notifyFinished ?? true,
    });
    return false;
  }

  // The rail's checkout, NOT a card's contextFolder -- there is no card.
  const tree = get(gavinTrees)[workspaceId];
  const cwd = rail.worktreePath ?? (tree && !tree.rootMissing ? tree.rootPath : null);
  if (!cwd) {
    await setStepRunAction(
      workspaceId,
      step.id,
      "stalled",
      null,
      "no worktree bound and the workspace has no root"
    );
    return false;
  }

  const body = resolveToolBody(tool, stepParams(step));
  const agent = resolvedAgentFor(workspaceId);
  // Only an AGENT tool gets a conversation: a command, script or until
  // step is a shell, and its verdict is its exit code (tools spec T5).
  const conversationId = tool.kind === "agent" ? conversationIdForLaunch(agent) : null;
  // Only an agent's prompt is prefixed. A `command` or `script` tool's
  // body is shell source, and pasting a paragraph of test output in
  // front of it would not retry the step, it would break it -- which is
  // exactly what "a shell step is simply re-run" means.
  const prompt =
    tool.kind === "agent"
      ? withRetryPrefix(body, await retryNoteFor(workspaceId, rail, step.id))
      : body;
  const command =
    tool.kind === "agent"
      ? buildRunCommand(agent.launchCommand, agent.promptArgs, prompt, agent.sessionIdArgs, conversationId)
      : tool.kind === "until"
        ? // `script`, not `command`: the wrapper needs bash (pipefail,
          // and a brace group around a body that may be several lines),
          // and buildToolCommand's script shape is the one that runs its
          // body through `bash -c`. The human's login shell here is zsh.
          buildToolCommand("script", buildUntilScript(body, untilLogPath(step.id)), tool.name)
        : buildToolCommand(tool.kind, body, tool.name);
  // Only an `agent` tool can land here: a command or script tool builds
  // its own line and never asks the profile for one. Stalled rather
  // than failed, and the reason names the agent -- a rail that stops
  // saying "could not start" would send the human looking at the tool.
  if (command === null) {
    await setStepRunAction(
      workspaceId,
      step.id,
      "stalled",
      null,
      noPromptReason(agent.label)
    );
    return false;
  }

  const sessionId = await createSessionOnRailPage(workspaceId, rail.id, cwd, command);
  if (!sessionId) {
    await setStepRunAction(workspaceId, step.id, "stalled", null, `could not start ${tool.name}`);
    return false;
  }
  // A command tool's PTY can close in well under a second, so the tab
  // needs a name the moment it appears or it is unidentifiable. Best
  // effort: a nameless tab is cosmetic, not a reason to stall a step
  // whose session is already running.
  if (tool.kind === "agent") {
    void armFailureDetection(sessionId, agent.failurePatterns);
  }
  try {
    // The store, not backend.setSessionName: the backend command only
    // persists the name to config and pushes nothing back, so a tab named
    // that way keeps its cwd label until the app restarts.
    await setSessionName(sessionId, tool.name);
  } catch {
    // Cosmetic only.
  }
  // 0, not null: this is a NEW conversation, so it is a new run, and a
  // new run gets a fresh auto-resume budget. Carrying the old count
  // forward would let one relaunched step inherit a spent budget.
  //
  // The `until` kind is the exception, and it has to be: the same field
  // holds its LOOP budget (see orchestrationLoop.ts), and a loop re-runs
  // the check every time round. Zeroing it here would make the budget
  // unspendable and the loop unbounded. Every path that means "start
  // over" -- resetRail, retryStep, an exhausted stall -- writes 0
  // explicitly instead.
  await setStepRunAction(
    workspaceId,
    step.id,
    "running",
    sessionId,
    null,
    conversationId,
    cwd,
    tool.kind === "until" ? null : 0
  );
  return false;
}

/// Deliberately the EXISTING card-run path, so the board and the tab can
/// never disagree about what is running (spec §4.3).
/// Returns whether the tick should run again -- see executeToolLaunch.
async function executeLaunch(workspaceId: string, stepId: string): Promise<boolean> {
  const orch = get(orchestrations)[workspaceId];
  const rail = railOwning(orch, stepId);
  const step = rail?.stages.flatMap((s) => s.steps).find((t) => t.id === stepId);
  if (!rail || !step) return false;

  if (isToolStep(step)) {
    return await executeToolLaunch(workspaceId, rail, step);
  }

  const entry = cardIndex(get(gavinTrees)[workspaceId]).get(step.cardPath);
  if (!entry) {
    await setStepRunAction(workspaceId, stepId, "stalled", null, "card file is missing");
    return false;
  }

  // A card being developed stalls its step rather than running it: the
  // develop agent is rewriting the card file, so the prompt this step
  // would compose is about to stop being true. A stall and not a failure
  // -- the sweep frees the card when the develop run ends, and the rail
  // picks the step up on the next tick with the card the human actually
  // asked for.
  const developing = developingBlocker(workspaceId, step.cardPath);
  if (developing) {
    await setStepRunAction(workspaceId, stepId, "stalled", null, DEVELOPING_STALL);
    return false;
  }

  // The same gate a board Run uses, and for the same reason -- but here
  // the refusal STALLS the step instead of starting it. A rail that ran
  // a card with a dead attachment would carry the damage into every
  // stage after it, so the reason lands on the chip and rule 5 pauses
  // the rail, exactly as a failed launch does.
  const resolved = await resolveAttachmentsForRun(workspaceId, entry.plan.attachments ?? []);
  if ("error" in resolved) {
    await setStepRunAction(workspaceId, stepId, "stalled", null, resolved.error);
    return false;
  }

  // Resolved BEFORE the prompt, which is a change of order with a
  // reason: a bound rail launches its agent in a checkout that carries
  // its own copy of the card, and the prompt has to say so (see
  // cardHomeNote). An agent that writes the copy leaves the board where
  // it was and this step running forever.
  const cwd = rail.worktreePath ?? entry.contextFolder;
  // The card file, for both kinds now. A plan step's prompt only names
  // the file, but the body is still what its agent goes on to execute --
  // and it is still what the human has to have read before a rail hands
  // it over unattended.
  const file = await backend.readFileForViewer(step.cardPath);
  if (!file.exists) {
    await setStepRunAction(workspaceId, stepId, "stalled", null, "card file is missing");
    return false;
  }
  const body = stripFrontmatter(file.content).trim();
  // The first-Run review (AG-01), as a rail can ask it: it cannot. A
  // scheduler tick runs with nobody necessarily watching this window, and
  // a modal raised from one would hold the rail open behind whatever is
  // in front of it. So the step STALLS and names the card, rule 5 pauses
  // the rail, and `stepAttentions` marks it -- the same shape the
  // attachment gate above takes, and the same shape a `review` step takes
  // for the same reason: the rail is waiting on a person.
  //
  // The human answers it on the card, where the body can actually be
  // read; Retry then starts the step.
  if (
    !cardReviewed(workspaceId, step.cardPath, {
      title: entry.plan.title,
      body,
      attachments: entry.plan.attachments ?? [],
    })
  ) {
    await setStepRunAction(
      workspaceId,
      stepId,
      "stalled",
      null,
      unreviewedStallReason(entry.plan.title)
    );
    return false;
  }
  let prompt: string;
  if (entry.plan.kind === "task") {
    prompt = composeTaskPrompt(
      step.cardPath,
      entry.plan.title,
      body,
      resolved.paths,
      cwd,
      resolved.withheld
    );
  } else {
    prompt = composePlanPrompt(step.cardPath, resolved.paths, cwd, resolved.withheld);
  }
  // A card step re-run by a loop opens with what failed. Null except on
  // a retry, and then this is the whole difference between "do the card"
  // and "the check you have to pass says this".
  prompt = withRetryPrefix(prompt, await retryNoteFor(workspaceId, rail, stepId));

  // The card picks its own agent, exactly as it does for a board Run: a
  // rail is a different way to schedule the same card, not a different
  // kind of work. Its `agent:`/`model:` win where it names either, its
  // complexity level answers otherwise, and a card that says neither
  // falls back to the workspace's agent -- so a rail of plain cards
  // behaves as it always has.
  const agent = agentForCard(workspaceId, entry.plan);
  const conversationId = conversationIdForLaunch(agent);
  const command = buildRunCommand(
    agent.launchCommand,
    agent.promptArgs,
    prompt,
    agent.sessionIdArgs,
    conversationId
  );
  if (command === null) {
    await setStepRunAction(workspaceId, stepId, "stalled", null, noPromptReason(agent.label));
    return false;
  }
  const baseSha = await baseShaForLaunch(cwd);
  const sessionId = await createSessionOnRailPage(workspaceId, rail.id, cwd, command);
  if (!sessionId) {
    await setStepRunAction(workspaceId, stepId, "stalled", null, "could not start the agent");
    return false;
  }
  void armFailureDetection(sessionId, agent.failurePatterns);

  // Named before the agent has drawn a frame, same as a board Run and the
  // tool step above: the agent's own gavin_name_session refines this, but
  // it is the first call it makes and the first to break when the gavin
  // tools are unreachable. Best effort -- the agent is already running,
  // so a failed rename is not worth stalling a live step over.
  const provisional = provisionalSessionName(entry.plan.title);
  if (provisional) {
    try {
      await setSessionName(sessionId, provisional);
    } catch {
      // Cosmetic only.
    }
  }
  await linkCardSessionAction(workspaceId, {
    path: step.cardPath,
    sessionId,
    cwd,
    command,
    conversationId,
    launchCwd: cwd,
    // The rail's checkout as it stood before this step ran. Resolved
    // above, before the session, for the reason baseShaForLaunch
    // documents: a step that has started cannot be asked where it began.
    baseSha,
  });
  // See executeToolLaunch: a fresh conversation is a fresh budget.
  await setStepRunAction(workspaceId, stepId, "running", sessionId, null, conversationId, cwd, 0);
  if (runStatusNeeded(entry.plan.status)) {
    try {
      await backend.setPlanFrontmatterField(step.cardPath, "status", "In Progress");
      patchPlanField(workspaceId, step.cardPath, "status", "In Progress");
    } catch {
      // The agent is running; a failed status write is not worth
      // stalling the step over. The card's own agent will set it.
    }
  }
  return false;
}

/// Put a rail's checkout on its branch (spec O15). Three steps, and the
/// first two are refusal gates.
///
/// A branch the repo does not HAVE refuses first. `git switch` cannot
/// create one, so such a binding can only ever produce `fatal: invalid
/// reference: <name>` on the rail's chips -- which reads as a gavin
/// fault rather than as the binding it is. It is the branch half of the
/// family launchBlocker already covers ("card file is missing", "tool is
/// no longer in the library", "worktree ... is gone"), and the one that
/// was missing: branchSwitchFor compares rail.branch against the
/// WORKTREE list only, and gavin_set_orchestration takes any string, so
/// an agent-written rail can bind a branch nobody ever made. Refused
/// here rather than in that pure decision because a rail-wide stall has
/// no Action kind to carry it -- the same reason the dirty gate lives
/// here.
///
/// A DIRTY checkout refuses -- deliberately stricter than git, which
/// carries non-conflicting edits across a switch. Uncommitted work
/// migrating into a rail's branch behind the human's back is worse than
/// a stalled rail, and stashing is not gavin's to do: the stash stack is
/// shared with every other checkout of this repo.
///
/// Dirty means THE PROJECT's files, though, not gavin's own. A gavin
/// workspace's checkouts all hold the board, and a worktree cut from a
/// branch that predates it -- or one whose `.gavin-root` is a symlink to
/// the root checkout's, the usual way a fleet of worktrees shares one
/// board -- reports it as an untracked change. That read as the human's
/// work and stalled every bound rail on its first tick, before anything
/// launched, over a file gavin put there itself; the "commit or stash
/// them" it offered was advice the human must not take, since committing
/// the board onto a feature branch is wrong and the stash stack is
/// shared. Nothing is lost by letting it through: a switch does not
/// touch an untracked file, and git refuses on its own the one case
/// where it would (the target branch tracks that very path).
///
/// Every failure stalls the rail's current stage rather than throwing,
/// exactly as a failed launch does, so the reason lands on the chips and
/// rule 5 pauses the rail.
///
/// Returns whether the tick that ran it should run AGAIN: a switch only
/// half-finishes here, since the rail becomes launchable through the
/// refs snapshot this just moved.
async function executeSwitchBranch(
  workspaceId: string,
  railId: string,
  path: string,
  branch: string
): Promise<boolean> {
  // Read off the SAME snapshot branchSwitchFor read the worktrees from,
  // and answer nothing when there is none: unknown must never read as
  // "gone", the cold-start rule launchBlocker and branchSwitchFor both
  // follow. A workspace whose git view was never opened has no snapshot,
  // and stalling every bound rail over that would be the worse bug.
  const refs = get(gitStore)[workspaceId]?.refs ?? null;
  if (refs && !branchResolvable(refs, branch)) {
    await stallStage(
      workspaceId,
      railId,
      `${branch} is not a branch of this repo — create it, or bind this rail to one that exists`
    );
    return false;
  }
  try {
    const status = await backend.gitStatus(path);
    const dirty = [...status.staged, ...status.unstaged].filter((e) => !isGavinOwnPath(e.path));
    if (dirty.length > 0) {
      await stallStage(
        workspaceId,
        railId,
        `${path} has uncommitted changes — commit or stash them before this rail can switch to ${branch}`
      );
      return false;
    }
    await backend.gitCheckout(path, branch, null);
  } catch (e) {
    await stallStage(workspaceId, railId, e instanceof Error ? e.message : String(e));
    return false;
  }
  // Without this the refs snapshot still names the old branch, and the
  // scheduler would ask for this same switch on every tick.
  await refreshGit(workspaceId);
  // Ask for the follow-up ONLY once the snapshot has actually caught up.
  // A refresh that failed leaves the old one in place, and re-ticking on
  // that would re-emit this very switch -- forever, since checking out a
  // branch you are already on succeeds every time.
  const now = get(gitStore)[workspaceId]?.refs?.worktrees.find((w) => w.path === path)?.branch;
  return now === branch;
}

/// Stall every PENDING step of the rail's current stage and pause the
/// rail -- the rail-level equivalent of a failed launch. Steps that are
/// already running are left alone: a stale action must never mark a live
/// agent's step as stalled.
async function stallStage(workspaceId: string, railId: string, reason: string): Promise<void> {
  const orch = get(orchestrations)[workspaceId];
  const rail = orch?.rails.find((r) => r.id === railId);
  if (!orch || !rail) return;
  const current = orch.railRuns.find((r) => r.railId === railId)?.currentStageId ?? null;
  const stage = rail.stages.find((s) => s.id === current);
  for (const step of stage?.steps ?? []) {
    if (stepStateOf(get(orchestrations)[workspaceId], step.id) !== "pending") continue;
    await setStepRunAction(workspaceId, step.id, "stalled", null, reason);
  }
  await setRailRunAction(workspaceId, railId, "paused", current);
}

/// Stall one step, and pause its rail if that rail was advancing.
///
/// Rule 5 stops a rail that is ADVANCING. A rail that is idle or paused
/// has nothing to stop, and the reconciling stalls nextActions issues for
/// a dead session on such a rail must not relabel a rail nobody started
/// as "paused".
async function stallStep(
  workspaceId: string,
  orch: Orchestration,
  stepId: string,
  reason: string,
  /// See setStepRunAction: null leaves the persisted count alone, which
  /// is what every stall but an exhausted loop's wants.
  resumeAttempts: number | null = null
): Promise<void> {
  await setStepRunAction(workspaceId, stepId, "stalled", null, reason, null, null, resumeAttempts);
  const rail = railOwning(orch, stepId);
  if (rail && railStateOf(orch, rail.id) === "running") {
    const current = orch.railRuns.find((r) => r.railId === rail.id)?.currentStageId ?? null;
    await setRailRunAction(workspaceId, rail.id, "paused", current);
  }
}

/// Take a re-run card back OUT of the done column, when it is in it.
///
/// Rule 1 fires before rule 2: a card step whose card sits in the done
/// column is marked done on sight, before anything launches it. So a
/// loop that re-armed such a step would go round its whole budget
/// without the work ever running again -- the card would be filed done,
/// the stage would complete, the check would fail, and round again.
///
/// The write itself is the one executeLaunch already makes at launch
/// (spec §3); this is the same statement one beat earlier, because rule
/// 1 pre-empts the launch that would have made it. And it is true: the
/// check says this work is not finished.
///
/// Only when the card's OWN status says done. A nested task has none --
/// its column is its parent's -- and writing one would un-nest it, which
/// is a far bigger edit than the loop is entitled to make.
async function reopenCardForRerun(workspaceId: string, step: Step): Promise<void> {
  if (isToolStep(step)) return;
  const done = doneColumnName(workspaceId);
  const status = cardIndex(get(gavinTrees)[workspaceId]).get(step.cardPath)?.plan.status ?? null;
  if (!done || status === null || slugStatus(status) !== slugStatus(done)) return;
  try {
    await backend.setPlanFrontmatterField(step.cardPath, "status", "In Progress");
    patchPlanField(workspaceId, step.cardPath, "status", "In Progress");
  } catch {
    // The step is re-armed either way, and the budget bounds the spin. A
    // failed status write is not a reason to leave the rail parked on a
    // check that has just failed.
  }
}

/// Send the rail BACK a step: the check failed and there is budget left.
///
/// Four writes and their order matters. The card comes out of the done
/// column first (see above), or rule 1 would file the step done before
/// rule 2 could launch it. Then the check step goes `pending` carrying
/// the incremented count -- that pair is what says a loop is in flight,
/// and it is what the re-armed step's own launch reads to decide whether
/// to quote the failure in its prompt (retryLogFor). Then the step to
/// re-run goes `pending`, its own count untouched: a launch zeroes it
/// anyway, and leaving it alone is what lets two `until` steps in a row
/// keep their separate budgets. Finally the rail's cursor moves back to
/// the stage holding it.
///
/// The rail stays RUNNING throughout. Spelling this as a stall plus an
/// advance would have paused it in between (rule 5), which is the one
/// thing a loop must not do -- a rail that pauses itself every time a
/// test fails is a rail that never retries anything.
///
/// Returns true so the tick runs again: the pass that scheduled this
/// stopped at the loop-back, so nothing has launched the re-armed step.
async function executeLoopBack(
  workspaceId: string,
  action: Extract<Action, { kind: "loopBack" }>
): Promise<boolean> {
  const orch = get(orchestrations)[workspaceId];
  const rail = orch ? railOwning(orch, action.stepId) : null;
  if (!orch || !rail) return false;
  const previous = rail.stages.flatMap((s) => s.steps).find((t) => t.id === action.previousStepId);
  if (!previous) return false;
  await reopenCardForRerun(workspaceId, previous);
  await setStepRunAction(
    workspaceId,
    action.stepId,
    "pending",
    null,
    null,
    null,
    null,
    action.attempt
  );
  await setStepRunAction(workspaceId, action.previousStepId, "pending", null, null);
  const stageId = stageIdOfStep(rail, action.previousStepId);
  // No stage means the plan changed under the loop. Leaving the cursor
  // where it is beats pointing it at nothing, which nextActions reads as
  // "this rail is complete".
  if (stageId) await setRailRunAction(workspaceId, rail.id, "running", stageId);
  return true;
}

/// Returns whether the tick should run again immediately. Three actions
/// ask for it, and all three change what the scheduler READS rather than
/// only what it has already decided: executeSwitchBranch moves the refs
/// snapshot, a `gavin` tool step finishes inside its own launch -- so the
/// stage's fate was decided before that step was done -- and a loop-back
/// re-points the rail at a stage the pass had already walked past.
export async function executeActions(workspaceId: string, actions: Action[]): Promise<boolean> {
  let again = false;
  for (const action of actions) {
    const orch = get(orchestrations)[workspaceId];
    if (!orch) return again;
    if (action.kind === "launch") {
      // The pause gates STARTS and nothing else. Every other action
      // below is bookkeeping about work that already happened -- marking
      // a finished step done, stalling a dead one, advancing a stage --
      // and holding those would leave the rail describing a state it is
      // no longer in.
      //
      // Skipped, not stalled: a pause is not a failure, and writing
      // `stalled` on the run row would need a human to clear something
      // that clears itself. The action is simply not taken, and the tick
      // that runs when the pause lifts (activePaused is an input below)
      // emits it again -- which is the whole of "resume".
      if (!mayStartWork(workspaceId)) continue;
      // ...and the launch wall, at the same seam and on the same terms.
      // A rail step is NOT queued: the scheduler is the rail's queue,
      // and `launchHolding` is one of this pass's inputs, so the tick
      // that runs when a slot frees emits this action again -- which is
      // the whole of "resume". Queueing it here as well would give one
      // launch two owners.
      if (!mayLaunch()) continue;
      again = (await executeLaunch(workspaceId, action.stepId)) || again;
    } else if (action.kind === "markDone") {
      const sessionId = orch.stepRuns.find((r) => r.stepId === action.stepId)?.sessionId ?? null;
      // The session id is kept deliberately: the step is finished, but
      // its transcript stays reachable from the chip.
      await setStepRunAction(workspaceId, action.stepId, "done", sessionId, null);
      // A step finishing on an IDLE rail -- the reconciling markDone
      // above -- can be the last one that rail owed, and no `complete`
      // follows it: the rail is already idle. So this is the other half
      // of the re-tick `complete` asks for, on the same terms.
      again = armsItself(orch) || again;
    } else if (action.kind === "stall") {
      await stallStep(workspaceId, orch, action.stepId, action.reason);
    } else if (action.kind === "loopExhausted") {
      // The reason has to QUOTE the check, and the check's output is on
      // disk rather than in the plan -- which is the only reason this is
      // an action of its own rather than the `stall` above.
      //
      // The budget is zeroed as it stalls: rule 2 retries a stalled step
      // when the run reaches it again, and a spent count would make every
      // later Resume run the check exactly once and give up.
      //
      // A `pr` step carries its own note: that verdict was reached by
      // reading GitHub, so what failed is already in hand and there is
      // no log on disk to go and find.
      await stallStep(
        workspaceId,
        orch,
        action.stepId,
        action.note !== undefined
          ? prExhaustedReason(action.max, action.note)
          : exhaustedReason(action.max, await readCheckLog(action.stepId)),
        0
      );
    } else if (action.kind === "loopBack") {
      again = (await executeLoopBack(workspaceId, action)) || again;
    } else if (action.kind === "switchBranch") {
      again =
        (await executeSwitchBranch(workspaceId, action.railId, action.path, action.branch)) || again;
    } else if (action.kind === "advance") {
      await setRailRunAction(workspaceId, action.railId, "running", action.stageId);
    } else if (action.kind === "arm") {
      // Exactly what `startRail` writes, minus the human. No page is
      // spawned here either: the rail's page is made by its first
      // LAUNCH, around that session (spec O16).
      await setRailRunAction(workspaceId, action.railId, "running", action.stageId);
      // The pass that decided this read the rail as idle and scheduled
      // nothing else of it, so without another pass the rail would sit
      // armed and empty until some unrelated event ticked.
      again = true;
    } else if (action.kind === "complete") {
      await setRailRunAction(workspaceId, action.railId, "idle", null);
      // A rail finishing is the event a TRIGGER waits for, and
      // `orchestrations` is deliberately not a tick input (see
      // tickInputStores), so nothing else would say so. Only where a
      // trigger exists to care: an extra pure pass per completion is
      // cheap, but it is not free, and a workspace that has never used a
      // trigger should not pay it. It terminates because the replay
      // finds the rail idle with nothing unfinished and completes
      // nothing.
      again = armsItself(orch) || again;
    }
  }
  return again;
}

/// Whether any rail here starts itself, i.e. whether the pass that just
/// finished a piece of work owes the scheduler another look.
function armsItself(orch: Orchestration): boolean {
  return orch.rails.some((r) => r.trigger);
}

/// The board's done column name, for the rail header's "nothing can
/// complete" warning. Null when the board has no columns at all.
export function doneColumnName(workspaceId: string): string | null {
  const board = get(kanbanState)[workspaceId];
  return board ? (doneColumn(board)?.name ?? null) : null;
}

// One tick at a time per workspace: executing an action mutates the very
// state the next nextActions call reads, so overlapping ticks would
// double-launch.
const ticking = new Set<string>();
// ...but a request that arrives DURING a tick must not be dropped. The
// tick in flight read the plan before that caller's change existed, so
// simply returning would leave the change unscheduled until some
// unrelated event ticked again -- exactly the stall a card dropped onto
// a running stage used to sit in. So the request is remembered and
// replayed once the current pass drains.
const tickAgain = new Set<string>();

export async function tick(workspaceId: string): Promise<void> {
  if (ticking.has(workspaceId)) {
    tickAgain.add(workspaceId);
    return;
  }
  ticking.add(workspaceId);
  let again = false;
  try {
    again = await runTick(workspaceId);
  } finally {
    ticking.delete(workspaceId);
  }
  // Outside the guard, so the replay is a full tick of its own. It
  // terminates: the pass that just ran left every step it launched
  // `running`, so a replay that finds nothing new emits no actions and
  // asks for nothing further.
  // `again` is the branch-switch follow-up: switching a checkout changes
  // what the scheduler READS, not just what it has already decided, so
  // the rail becomes launchable one pass later. Bounded for the same
  // reason the replay is -- a checkout already on its rail's branch asks
  // for no further pass.
  if (tickAgain.delete(workspaceId) || again) await tick(workspaceId);
}

async function runTick(workspaceId: string): Promise<boolean> {
  const orch = get(orchestrations)[workspaceId];
  const board = get(kanbanState)[workspaceId];
  if (!orch || !board) return false;
  const tree = get(gavinTrees)[workspaceId];
  // null, not [] -- an unloaded refs snapshot must not look like "every
  // worktree is gone" and stall every bound rail on a cold start.
  const worktrees = get(gitStore)[workspaceId]?.refs?.worktrees ?? null;
  const live = new Set<string>();
  for (const ws of get(layoutState).workspaces) {
    for (const page of ws.pages) for (const id of allSessionIds(page.layout)) live.add(id);
  }
  // null, not [], for the same reason as worktrees above: an unloaded
  // tool library must not read as "every tool was deleted".
  const tools = libraryFor(get(toolRecords), workspaceId);
  // An agent tool's session never exits, so its verdict is not in
  // sessionExits and never will be -- the daemon's live status is the
  // only thing that says its turn is over (see agentTurnEnded).
  const statuses = new Map(Object.entries(get(layoutState).sessionStatusById));
  // A session the daemon put back as a bare shell is IN `live` above --
  // same id, back in the layout -- so without this the scheduler waits on
  // a shell that will never finish a card. See nextActions rule 3c.
  const interrupted = get(layoutState).interruptedSessionIds;
  // A FAILED session is in `live` too, and goes quiet -- which is `idle`,
  // which rule 3b reads as a finished turn. Without this the rail
  // advances on work that never happened. See nextActions rule 3d.
  const failureReasons = new Map(Object.entries(get(layoutState).failureReasonById));
  // Say that the rails still care, before reading. A `pr` step's poll is
  // demand-driven (prState.ts) precisely so a workspace with nothing
  // waiting spends nothing -- and this is the half that keeps a rail
  // waiting on CI polling while the human is on another tab, which is
  // the whole point of a rail that runs unattended.
  //
  // Every rail carrying a pr step at all, not only one whose step is
  // already running: the report has to be warm by the time the step
  // launches, or its first tick waits a poll cycle for its own answer.
  const kinds = tools ? new Map(tools.map((t) => [t.id, t.kind])) : null;
  for (const rail of orch.rails) {
    if (!rail.branch) continue;
    const wants = rail.stages.some((stage) =>
      stage.steps.some((step) => isPrStep(step, kinds))
    );
    if (wants) requestPr(conflictCheckout(rail, tree), rail.branch);
  }
  return await executeActions(
    workspaceId,
    nextActions(
      orch,
      board,
      tree,
      worktrees,
      live,
      tools,
      get(sessionExits),
      statuses,
      interrupted,
      failureReasons,
      currentPrReports(),
      Math.floor(Date.now() / 1000)
    )
  );
}

// ---- What makes the scheduler run ------------------------------------------
// Until this existed, the only self-firing tick was an $effect in
// OrchestrationHubView. `+page.svelte` renders one hub view at a time,
// and a terminal page renders none of them at all -- so a rail advanced
// only while the Orchestration tab was the active view. Start a rail and
// then go and watch its agent work on its page, which is the natural
// thing to do, and nothing moved: the step's exit landed in
// `sessionExits` and its status in `sessionStatusById` (both listeners
// are global), but nothing read them until the human navigated back,
// where the whole rail caught up at once.
//
// So the trigger lives here instead, subscribed at module level the way
// layoutState.ts rides `gavinTrees` -- owned by the module that owns the
// tick, not by whichever component happens to be mounted.

/// Every store `runTick` reads EXCEPT `orchestrations`. Listing the rest
/// in full rather than a chosen subset is the point: a scheduler that
/// misses an input is exactly the bug above in a subtler form. Ticking on
/// an emission that changed nothing costs one pure `nextActions` pass,
/// and a burst of them collapses -- the `ticking` guard turns every
/// emission raised while a pass is in flight into the single replay
/// `tickAgain` already performs.
///
/// `orchestrations` is left out because it is the tick's OUTPUT as well
/// as its input: a save that keeps failing (a daemon refusing writes
/// across a version skew) rolls the plan back, and a tick riding that
/// rollback would re-emit the same action and retry forever. The plan
/// ARRIVING ticks explicitly instead, from each of the three places it
/// can arrive: a fetch, a refresh, and the daemon's push.
///
/// Read when the scheduler starts, not at module scope: importing this
/// module must not require every store it will eventually subscribe to
/// to exist yet.
function tickInputStores(): Readable<unknown>[] {
  // activePaused, not activePause: the verdict rides a thirty-second
  // clock and would tick the scheduler twice a minute forever, while the
  // deduped flag emits exactly twice per pause -- once when starts stop,
  // once when they may resume.
  // prReports is here for the same reason sessionExits is: it is how a
  // `pr` step's verdict ARRIVES. Without it a rail waiting on CI would
  // sit until some unrelated event ticked -- which is exactly the bug
  // this whole module-level scheduler was written to fix, in a new place.
  return [
    kanbanState,
    gavinTrees,
    gitStore,
    toolRecords,
    layoutState,
    sessionExits,
    activePaused,
    // The deduped flag, not `launchGateVerdict`: the verdict rides a
    // five-second poll and would tick the scheduler twelve times a
    // minute for the life of the app, while this emits exactly twice per
    // hold -- once when starts stop, once when they may resume.
    launchHolding,
    prReports,
  ];
}

let stopScheduler: (() => void) | null = null;

/// Ticks the ACTIVE workspace whenever anything the scheduler reads
/// changes. Deliberately still one workspace: a single mounted hub view
/// is what this replaces, and ticking every loaded workspace -- running
/// rails in workspaces the human is not looking at -- is a separate
/// change to make deliberately. Returns its own teardown; started by
/// initOrchestrationListeners, which bootstrap registers and teardown
/// unwinds.
export function startScheduler(): () => void {
  stopScheduler?.();
  const unsubscribes = tickInputStores().map((store) =>
    store.subscribe(() => {
      // Null while the app is still connecting, and on a window with no
      // workspace at all; either way there is nothing to tick.
      const workspaceId = get(layoutState).activeWorkspaceId;
      // Not recursion, even though a pass writes to `layoutState` itself
      // when it creates a step's session: an emission raised while a
      // pass is in flight collapses into `tick`'s single replay.
      if (workspaceId) void tick(workspaceId);
    })
  );
  const stop = () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    // Guarded: a later start owns the field, and this teardown arriving
    // afterwards must not clear the live scheduler out of it.
    if (stopScheduler === stop) stopScheduler = null;
  };
  stopScheduler = stop;
  return stop;
}

/// The rail's own words for one of its step's sessions, when the
/// generic notification body would be wrong (see setRailNotificationVoice).
///
/// The one case: a CARD step whose agent went idle without ever moving
/// its card to the done column. That transition already notified, as
/// "<label> finished" -- and "finished" is exactly what did not happen.
/// The agent stopped; the work is still undone and the rail is still
/// waiting on it.
///
/// Only the marks that mean "this step is not going to finish".
/// `asking` already says "needs your input", which is right, and an
/// agent TOOL step going idle really has finished, because
/// agentTurnEnded marks it done on that same tick.
///
/// `decoy-edit` gets a sentence of its own rather than the generic one.
/// It is the same silence to the daemon and a completely different
/// thing to the human: the work may well be done, in a file the board
/// will never read, and "stopped without finishing its card" would send
/// them to restart an agent that would make the same mistake again.
export function railStatusVoice(sessionId: string, status: SessionStatus): string | null {
  if (status !== "idle") return null;
  // Reads the same derived map the chips do, and the layout store it
  // rides has already been updated with this very status by the time
  // handleSessionStatusChanged calls the notifier -- so the mark here is
  // the one the human is about to see on the rail.
  const byWorkspace = get(stepAttentionsByWorkspace);
  for (const [workspaceId, marks] of Object.entries(byWorkspace)) {
    const orch = get(orchestrations)[workspaceId];
    if (!orch) continue;
    for (const run of orch.stepRuns) {
      if (run.sessionId !== sessionId) continue;
      const mark = marks.get(run.stepId);
      if (mark !== "turn-ended" && mark !== "stale" && mark !== "decoy-edit") continue;
      const step = findStep(orch, run.stepId);
      const label = step ? cardTitleFor(workspaceId, step) : null;
      return mark === "decoy-edit"
        ? `${label ?? "a rail step"} edited its worktree's copy of the card, so the board never saw it`
        : `${label ?? "a rail step"} stopped without finishing its card`;
    }
  }
  return null;
}

/// The card's own title for a notification body -- the session's name is
/// a shell label and would not tell the human which card stalled. Falls
/// back to the file name, which is the only honest thing left when the
/// tree has not loaded.
function cardTitleFor(workspaceId: string, step: Step): string | null {
  if (isToolStep(step)) return null;
  const entry = cardIndex(get(gavinTrees)[workspaceId]).get(step.cardPath);
  return entry?.plan.title ?? step.cardPath.split("/").pop() ?? null;
}

/// Must be registered BEFORE the first watchGavinRoot call: Tauri events
/// emitted with no listener are lost, not buffered. layoutState.bootstrap()
/// registers this beside initGavinListeners, and starts the scheduler
/// with it -- both belong to the app, not to a tab.
///
/// The payload REPLACES the plan but preserves whatever run state this
/// app already holds: the daemon's copy can lag an optimistic local write
/// by a round trip.
///
/// It no longer follows that the agent never authors run state.
/// `gavin_start_rail` arms a rail through the daemon, which pushes the
/// row it just wrote -- and the merge below would drop it, leaving the
/// rail idle on screen with a `running` row in SQLite until some later
/// read. So when the push DISAGREES about a rail's run state, re-read
/// rather than merge: `refreshOrchestration` asks the daemon (skipping
/// while a save is in flight, and re-checking after), which is right in
/// both directions -- a push that crossed a local write still lands on
/// what the daemon actually holds now.
export async function initOrchestrationListeners(): Promise<UnlistenFn> {
  const unlisten = await listen<[string, Orchestration]>("orchestration-changed", (event) => {
    const [workspaceId, incoming] = event.payload;
    let runStateMoved = false;
    orchestrations.update((m) => {
      const current = m[workspaceId];
      if (!current) return { ...m, [workspaceId]: incoming };
      runStateMoved = railRunsDiffer(current, incoming);
      // The preserved run state may name steps the agent just deleted.
      // The daemon has already dropped those rows; this keeps the
      // in-memory copy honest without waiting for the next fetch.
      const railIds = new Set(incoming.rails.map((r) => r.id));
      const stepIds = new Set(
        incoming.rails.flatMap((r) => r.stages.flatMap((s) => s.steps.map((t) => t.id)))
      );
      return {
        ...m,
        [workspaceId]: {
          rails: incoming.rails,
          conflictNotes: incoming.conflictNotes,
          railRuns: current.railRuns.filter((r) => railIds.has(r.railId)),
          stepRuns: current.stepRuns.filter((r) => stepIds.has(r.stepId)),
        },
      };
    });
    if (runStateMoved) void refreshOrchestration(workspaceId);
    // A plan arrival like any other (an agent editing rails over MCP),
    // so it ticks like the other two: a step added to the stage a rail
    // is running must start, not wait for the human to come back. This
    // is also the ONLY thing that starts a rail armed in a workspace the
    // human is not looking at -- the scheduler ticks the active one.
    void tick(workspaceId);
  });
  const stop = startScheduler();
  // Started beside the scheduler and owned by the same teardown: the
  // poll behind a `pr` step has to keep running whatever view is
  // mounted, exactly as the tick does.
  const stopPolling = startPrPolling();
  // And beside it for the same reason: a rail whose agent edited the
  // worktree's copy of its card is wedged whatever tab is on screen, and
  // it is the tab NOT on screen where nobody would ever find out.
  const stopDecoys = startDecoyWatch();
  // Started here for the reason the scheduler is: it belongs to the app,
  // not to a tab. An Organize that finishes while the human is reading the
  // board still has to release the button, and the record it clears was
  // loaded from config.json a moment ago -- this first pass is also how a
  // run that outlived the last window gets adopted or written off.
  const stopAgents = startOrchestrationAgentWatch();
  setRailNotificationVoice(railStatusVoice);
  // Registered beside the scheduler, and for the same reason: it is a
  // module-level listener that has to run whatever view is mounted. A
  // rail whose agent breaks while the human is watching its page -- or
  // no page at all -- is exactly the case auto-resume exists for.
  //
  // Dynamically imported to keep the dependency one-way: autoResumeState
  // reads this module (for resumeStep and orchestrations), so a static
  // import here would close a cycle.
  const { startAutoResume } = await import("$lib/autoResumeState");
  const stopAutoResume = startAutoResume();
  return () => {
    stop();
    stopPolling();
    stopDecoys();
    stopAgents();
    stopAutoResume();
    setRailNotificationVoice(null);
    unlisten();
  };
}

/** @internal test-only reset for module-level state */
export function __resetForTesting(): void {
  orchestrations.set({});
  saveErrors.set({});
  // A sweep left running would ask git about the next test's rails.
  stopDecoyWatch();
  decoyEditsByWorkspace.set({});
  decoyInFlight.clear();
  pendingSaves.clear();
  ticking.clear();
  tickAgain.clear();
  // A scheduler left running would tick the next test's stores.
  stopScheduler?.();
  stopAgentWatch?.();
  sweepingAgents = false;
  sweepAgentsAgain = false;
  setRailNotificationVoice(null);
  spawningPages.clear();
  highlightedConflict.set(null);
}

// ---- Plan-edit actions -----------------------------------------------------

/// Returns the new rail's id so the caller can drop it straight into
/// rename mode -- a rail called "New rail" is a placeholder, not a name.
export async function addRailAction(workspaceId: string, name: string): Promise<string> {
  const railId = crypto.randomUUID();
  await mutatePlan(workspaceId, (o) => addRail(o, railId, name));
  return railId;
}

export function renameRailAction(workspaceId: string, railId: string, name: string): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => renameRail(o, railId, name));
}

export function bindRailAction(
  workspaceId: string,
  railId: string,
  patch: { worktreePath?: string | null; branch?: string | null; pageId?: string | null }
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => bindRail(o, railId, patch));
}

/// Turn this rail's auto-resume on or off. See setRailAutoResume: it is
/// part of the plan, not a per-viewer preference.
export function setRailAutoResumeAction(
  workspaceId: string,
  railId: string,
  autoResume: boolean
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => setRailAutoResume(o, railId, autoResume));
}

/// Set or clear this rail's start condition, then LOOK: a trigger whose
/// condition already holds has to arm the rail now, not at whatever
/// unrelated event ticks next. `mutatePlan` writes the plan and
/// `orchestrations` is not a tick input, so the tick has to be asked for
/// here -- the same reason `startRail` and `resumeRail` end with one.
export async function setRailTriggerAction(
  workspaceId: string,
  railId: string,
  trigger: RailTrigger | null
): Promise<string | null> {
  const error = await mutatePlan(workspaceId, (o) => setRailTrigger(o, railId, trigger));
  // Only when the write took. A rolled-back save leaves the store as it
  // was, and ticking on it would be a pass over a plan nobody has.
  if (!error) await tick(workspaceId);
  return error;
}

export function deleteRailAction(workspaceId: string, railId: string): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => deleteRail(o, railId));
}

/// Every finished rail in ONE plan write, for the toolbar's "Clear done".
///
/// One write and not a loop over `deleteRailAction`, for two reasons that
/// both bite. The plan is persisted wholesale, so N calls are N round
/// trips over a plan that shrinks under each of them -- and each one
/// opens its own optimistic-rollback window, so a failure halfway leaves
/// some rails gone and some back, with no single state to roll back to.
///
/// Takes the ids rather than re-deriving them, so what goes is exactly
/// what the confirm named. The plan can reload between the prompt opening
/// and the human pressing; re-deriving here would sweep a rail that
/// finished in that gap and was never on the list they agreed to.
export function deleteRailsAction(
  workspaceId: string,
  railIds: string[]
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => deleteRails(o, railIds));
}

/// Adds the card as its OWN new stage -- a sequential beat, the safe
/// default. Dropping onto an existing stage instead is the deliberate
/// act of joining it or forming a group with it (SP2, grouping spec G3).
export function addStepAsStageAction(workspaceId: string, railId: string, cardPath: string): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => {
    const stageId = crypto.randomUUID();
    return addStep(addStage(o, railId, stageId), stageId, crypto.randomUUID(), cardPath, 0);
  });
}

/// The GROUPING drop: the card joins an existing stage at `index`,
/// making it a sequence group if it held one step. If that stage is the
/// one its rail is running right now, the card starts immediately --
/// unless the group is sequential and something ahead of it is still
/// running, in which case the tick correctly leaves it queued.
export async function addStepToStageAction(
  workspaceId: string,
  stageId: string,
  cardPath: string,
  index: number
): Promise<string | null> {
  const error = await mutatePlan(workspaceId, (o) => addStep(o, stageId, crypto.randomUUID(), cardPath, index));
  if (!error) await startIfStageRunning(workspaceId, stageId);
  return error;
}

export function setStageModeAction(
  workspaceId: string,
  stageId: string,
  mode: StageMode
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => setStageMode(o, stageId, mode));
}

export function renameStageAction(
  workspaceId: string,
  stageId: string,
  name: string | null
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => renameStage(o, stageId, name));
}

/// Moving a whole group. Nothing to start afterwards: a group that lands
/// on a running rail is a later beat unless it IS the current stage, and
/// it cannot be -- the rail was running a stage this move did not touch.
export function moveStageToIndexAction(
  workspaceId: string,
  stageId: string,
  railId: string,
  index: number
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => moveStageToIndex(o, stageId, railId, index));
}

/// Drops the group and every step it held. The cards are untouched: only
/// the steps that pointed at them leave.
export function removeStageAction(workspaceId: string, stageId: string): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => removeStage(o, stageId));
}

/// One stage per member, in order -- the deliberate destruction of a
/// group, as opposed to the conflict repair, which keeps it whole.
export function ungroupStageAction(workspaceId: string, stageId: string): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => splitStageIntoSequence(o, stageId));
}

/// A step dropped onto the stage a rail is CURRENTLY running belongs to a
/// beat already in flight, so it starts at once rather than sitting
/// `pending` until some unrelated change happens to tick the workspace.
/// That wait was the whole bug: the drop looked inert, and the human's
/// only recourse was Pause/Resume.
///
/// The tick is what starts it -- nextActions already launches a pending
/// step on the current stage -- so there is still exactly one launch
/// path, with the same blockers, the same stall reasons and the same
/// rule 1 that skips a card already sitting in the done column. Every
/// other drop target stays queued: a new stage is a later beat, and an
/// idle or paused rail spawns nothing at all (O1).
async function startIfStageRunning(workspaceId: string, stageId: string): Promise<void> {
  const orch = get(orchestrations)[workspaceId];
  if (orch && isStageRunning(orch, stageId)) await tick(workspaceId);
}

export function removeStepAction(workspaceId: string, stepId: string): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => removeStep(o, stepId));
}

/// Moving an existing step onto a running stage is the same gesture as
/// dropping a card there, so it starts the same way. Reading the target
/// AFTER the move is what keeps that safe: were the target the current
/// stage, the step's old stage cannot also have been, so nothing this
/// move emptied can have left the rail parked on a stage that is gone.
export async function moveStepIntoStageAction(
  workspaceId: string,
  stepId: string,
  stageId: string,
  index: number
): Promise<string | null> {
  const error = await mutatePlan(workspaceId, (o) => moveStepIntoStage(o, stepId, stageId, index));
  if (!error) await startIfStageRunning(workspaceId, stageId);
  return error;
}

export function moveStepToNewStageAction(
  workspaceId: string,
  stepId: string,
  railId: string,
  index: number
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => moveStepToNewStage(o, stepId, railId, index));
}

/// Drop an unplaced card into a rail as its own stage at `index`.
export function addCardAsStageAction(
  workspaceId: string,
  railId: string,
  index: number,
  cardPath: string
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => addCardAsStage(o, railId, index, crypto.randomUUID(), cardPath));
}

/// Send a card to a rail from a KANBAN surface -- the composer, a card's
/// context menu, its detail modal. Those surfaces never mount the
/// Orchestration tab, so the plan may not have been fetched yet; fetching
/// here is what makes "send to rail" work on a cold app that has only ever
/// shown the board.
///
/// Returns an error string for the caller's own error strip: the tab's
/// `saveErrors` banner is on a different tab, and a card that quietly
/// failed to land is worse than one that says so.
export async function sendCardToRailAction(
  workspaceId: string,
  railId: string,
  cardPath: string
): Promise<string | null> {
  if (!get(orchestrations)[workspaceId]) await fetchOrchestration(workspaceId);
  if (!get(orchestrations)[workspaceId]) {
    return "Couldn't reach this workspace's orchestration plan";
  }
  return mutatePlan(workspaceId, (o) => sendCardToRail(o, railId, cardPath, crypto.randomUUID()));
}

/// Take a card OFF whatever rail it sits on -- the inverse of
/// sendCardToRailAction, offered from the same surfaces so a mis-send is
/// undone where it was made. A card on no rail is a no-op.
export async function removeCardFromRailAction(
  workspaceId: string,
  cardPath: string
): Promise<string | null> {
  const orch = get(orchestrations)[workspaceId];
  const placement = orch ? findCardPlacement(orch, cardPath) : null;
  if (!placement) return null;
  return mutatePlan(workspaceId, (o) => removeStep(o, placement.stepId));
}

/// Move every card a rail carries into ONE kanban column -- a card's own
/// "Move to …" one rung up, for the human who just watched a rail finish
/// and wants its whole pipeline filed at once. Tool steps have no card
/// and sit it out; a card already in that column is not rewritten.
///
/// Writes are sequential and stop at the first failure, exactly as a
/// plan drop does (planDrop.ts): the watcher push reconciles whatever
/// landed, and the message names the file that refused. Null on success,
/// and on a rail with nothing to move.
export async function moveRailCardsAction(
  workspaceId: string,
  railId: string,
  columnName: string
): Promise<string | null> {
  const rail = get(orchestrations)[workspaceId]?.rails.find((r) => r.id === railId);
  if (!rail) return null;
  const cards = cardIndex(get(gavinTrees)[workspaceId]);
  const paths = railCardsToMove(rail, cards, columnName);
  const columns = get(kanbanState)[workspaceId]?.columns ?? [];
  let current = "";
  try {
    for (const path of paths) {
      current = path;
      // Filing a plan carries its nested tasks with it (cardCompletion.ts).
      // Asked per card rather than once for the rail: the question names
      // the plan and its children, and a rail carrying two such plans is
      // two different answers, not one.
      const entry = cards.get(path);
      if (entry) {
        const decision = await guardCompletion(
          workspaceId,
          {
            title: entry.plan.title,
            kind: entry.plan.kind,
            status: entry.plan.status,
            children: nestedChildrenOf(path, cards).map((c) => ({
              path: c.plan.path,
              title: c.plan.title,
            })),
          },
          columnName,
          columns
        );
        if (decision.error) return decision.error;
        // Declined for THIS card only: the rest of the rail still files.
        if (!decision.proceed) continue;
      }
      await backend.setPlanFrontmatterField(path, "status", columnName);
      patchPlanField(workspaceId, path, "status", columnName);
    }
    return null;
  } catch (e) {
    const fileName = current.split("/").at(-1) ?? current;
    return `Couldn't move ${fileName} to ${columnName}: ${e instanceof Error ? e.message : e}`;
  }
}

/// The `nested-with-parent` repair: give the nested child a status of its
/// own, which un-nests it into the board's first column while keeping the
/// `parent:` link. Both halves of that conflict then stop being one piece
/// of work, and the pair's badge clears without either step leaving a
/// rail -- which is the answer a human who deliberately placed the child
/// was reaching for.
///
/// Null on success and when there is nothing to do (a board with no
/// columns, or a card the tree has lost); a message naming the file
/// otherwise, in the same voice as `moveRailCardsAction`.
export async function breakOutNestedCardAction(
  workspaceId: string,
  cardPath: string
): Promise<string | null> {
  const entry = cardIndex(get(gavinTrees)[workspaceId]).get(cardPath);
  const column = firstColumnOf(get(kanbanState)[workspaceId]?.columns ?? []);
  if (!entry || !column) return null;
  const decision = await breakOutChildren(
    workspaceId,
    [{ path: cardPath, title: entry.plan.title }],
    column.name
  );
  return decision.error;
}

/// Take a rail's finished steps OFF it in one plan write -- the header's
/// "Clear done", for the human who wants the rail to show only what is
/// still ahead. What counts as done is railDoneStepIds' business (run
/// state, or the card's own column); the cards themselves are never
/// touched, only the steps that pointed at them.
///
/// A RUNNING rail whose current stage was cleared away would look
/// finished on the next tick -- nextActions has no stage to point at and
/// calls the rail complete -- so the run is repointed at the first
/// unfinished stage that survived, and ticked from there. Null on
/// success, and on a rail with nothing to clear.
export async function clearDoneStepsAction(
  workspaceId: string,
  railId: string
): Promise<string | null> {
  const orch = get(orchestrations)[workspaceId];
  const rail = orch?.rails.find((r) => r.id === railId);
  if (!rail) return null;
  const ids = railDoneStepIds(
    rail,
    orch,
    cardIndex(get(gavinTrees)[workspaceId]),
    doneColumnName(workspaceId)
  );
  if (ids.length === 0) return null;
  const err = await mutatePlan(workspaceId, (o) => removeSteps(o, ids));
  if (err) return err;

  const after = get(orchestrations)[workspaceId];
  const railAfter = after?.rails.find((r) => r.id === railId);
  const run = after?.railRuns.find((r) => r.railId === railId);
  if (!railAfter || !run?.currentStageId) return null;
  if (railAfter.stages.some((s) => s.id === run.currentStageId)) return null;
  await setRailRunAction(workspaceId, railId, run.state, firstUnfinishedStageId(railAfter, after));
  await tick(workspaceId);
  return null;
}

// ---- Tool step actions -----------------------------------------------------
// The card pair's exact shape, one rung over: a tool dropped into a gap
// becomes its own stage (sequential), a tool dropped onto a stage joins
// it or forms a group with it (grouping spec G3).

/// Appends the tool to the rail as its own stage -- what clicking a tool
/// row in the drawer means.
export function addToolAsStepAction(
  workspaceId: string,
  railId: string,
  toolId: string
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => {
    const stageId = crypto.randomUUID();
    return addToolStep(addStage(o, railId, stageId), stageId, crypto.randomUUID(), toolId, 0);
  });
}

export function addToolAsStageAction(
  workspaceId: string,
  railId: string,
  index: number,
  toolId: string
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) =>
    addToolAsStage(o, railId, index, crypto.randomUUID(), toolId)
  );
}

export async function addToolToStageAction(
  workspaceId: string,
  stageId: string,
  toolId: string,
  index: number
): Promise<string | null> {
  const error = await mutatePlan(workspaceId, (o) => addToolStep(o, stageId, crypto.randomUUID(), toolId, index));
  if (!error) await startIfStageRunning(workspaceId, stageId);
  return error;
}

/// A template dropped into a gap: its members become a group of their
/// own, carrying the template's name and mode -- the same sequential
/// drop addToolAsStageAction is for one tool, minting every member at
/// once instead of one step at a time.
export function addTemplateAsStageAction(
  workspaceId: string,
  railId: string,
  index: number,
  template: GroupTemplate
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) =>
    insertStageWithSteps(o, railId, index, {
      id: crypto.randomUUID(),
      position: index,
      mode: template.mode,
      name: template.name,
      steps: stepsFromTemplate(template, () => crypto.randomUUID()),
    })
  );
}

/// A template dropped ONTO a stage: its members join that group at
/// `index`, in order. The group's own name and mode win -- the human
/// arranged that group, and a template merged into it is an addition,
/// not a replacement.
export async function addTemplateToStageAction(
  workspaceId: string,
  stageId: string,
  index: number,
  template: GroupTemplate
): Promise<string | null> {
  const error = await mutatePlan(workspaceId, (o) => {
    const minted = stepsFromTemplate(template, () => crypto.randomUUID());
    // Two passes because addToolStep places a step and setStepParams gives
    // it its overrides -- one mutatePlan, so it is still one write.
    const placed = minted.reduce(
      (acc, step, i) => addToolStep(acc, stageId, step.id, step.toolId as string, index + i),
      o
    );
    return minted.reduce((acc, step) => setStepParams(acc, step.id, step.toolParams ?? {}), placed);
  });
  if (!error) await startIfStageRunning(workspaceId, stageId);
  return error;
}

/// The overrides arrive already pruned of values equal to the tool's own
/// defaults (StepParamsDialog does it), so a later edit to a default
/// still reaches a step that never deliberately overrode it.
export function setStepParamsAction(
  workspaceId: string,
  stepId: string,
  params: Record<string, string>
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => setStepParams(o, stepId, params));
}

/// The repair for a parallel-stage conflict: tell the group to run its
/// members one at a time. A mode flip rather than the old split, so the
/// group the human built survives the fix -- ungrouping is a separate,
/// deliberate act.
export function makeStageSequentialAction(workspaceId: string, stageId: string): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => setStageMode(o, stageId, "sequence"));
}

// ---- the tab's own agent runs ----------------------------------------------
//
// Organize and a rail's Reorganize each spawn a DEDICATED session (the
// shape "Develop into a plan…" uses) instead of pasting into the
// workspace's main agent. Two things follow, and both are the point:
// the request no longer needs the human to have started the Home agent,
// and the run has an identity -- which is what lets a second press be
// told there is a first one still thinking.
//
// One slot per WORKSPACE, not per rail: both prompts end in a write of
// the whole plan (they tell the agent to send every rail it was not asked
// about back exactly as it read it), so two runs at once do not divide
// the work, they overwrite each other.

/// Spawns the run, records it, and lands the human in its tab. The error
/// string is for the tab's own strip; null means it started.
async function launchOrchestrationAgent(
  workspaceId: string,
  record: Omit<OrchestrationAgentRecord, "sessionId">,
  prompt: string,
  /// The drain calling back in with an intent that has already cleared
  /// the launch wall. Asking again there would re-queue it for ever.
  queued = false
): Promise<string | null> {
  const ws = get(layoutState).workspaces.find((w) => w.id === workspaceId);
  if (!ws) return "That workspace is gone";
  // Re-read HERE rather than trusting the button's derived value: the
  // buttons are rendered from the same slot, but a run started from
  // another window (or by the press before this one, mid-await) is only
  // visible on a fresh read.
  if (ws.orchestrationAgent) {
    return `${ws.orchestrationAgent.label} is already running — jump to its tab instead of starting a second`;
  }
  // The workspace ROOT, never a rail's worktree: a worktree is a
  // different checkout with a different (or absent) `.gavin-root`, and
  // the gavin tools resolve which workspace they are talking about from
  // where they run. A reorganize launched in the rail's own checkout
  // would rewrite somebody else's board.
  const root = ws.rootPath || null;
  if (!root) return "This workspace has no root folder — set one on the Settings tab first";

  // The launch wall. Generate and Reorganize are ordinary agent runs
  // with an ordinary process tree, so they queue like one -- checked
  // AFTER the slot guard above, because "one of these at a time per
  // workspace" is a different rule and refusing is the right answer to
  // it, while a full machine is something to wait out.
  if (!queued && holdOrQueue({
    kind: "orchestration",
    workspaceId,
    label: record.label,
    prompt,
    agentLabel: record.label,
    railId: record.railId ?? null,
  })) {
    return null;
  }

  const agent = resolvedAgentFor(workspaceId);
  const command = buildRunCommand(agent.launchCommand, agent.promptArgs, prompt);
  // The same refusal every other launch gives a no-prompt profile,
  // returned as the button's error rather than thrown past it.
  if (command === null) return noPromptReason(agent.label);
  let sessionId: string;
  try {
    sessionId = await backend.createSession(root, command);
  } catch (e) {
    return `Couldn't start the agent: ${e instanceof Error ? e.message : e}`;
  }
  handleAgentSessionSpawned(workspaceId, sessionId);
  // Written down BEFORE the jump, because the window may not survive the
  // run: an unrecorded session is one the next window has no way to tell
  // apart from any other agent on the Agents page.
  await setOrchestrationAgent(workspaceId, { ...record, sessionId });
  // Then jump. Like Develop, this run writes no card status and binds no
  // card, so the board and the rails show nothing at all until it
  // finishes -- left where they were, the human would be watching a tab
  // that says nothing about the request they just made. Before the
  // rename below, so a failed rename (cosmetic) cannot swallow the jump.
  await revealSession(sessionId);
  const provisional = provisionalSessionName(record.label);
  if (provisional) await setSessionName(sessionId, provisional);
  return null;
}

/// The GENERATE request: the cards nobody has placed, plus a summary of
/// what the tab currently shows, so the agent starts from the same
/// picture the human is looking at -- it still calls
/// gavin_get_orchestration for the authoritative read.
export function requestOrganize(
  workspaceId: string,
  unplaced: CardEntry[],
  conflictSummary: string[]
): Promise<string | null> {
  const orch = get(orchestrations)[workspaceId] ?? null;
  return launchOrchestrationAgent(
    workspaceId,
    { railId: null, label: ORGANIZE_LABEL },
    composeOrganizePrompt(orch, unplaced, conflictSummary)
  );
}

/// The same skill, aimed at ONE rail (the button in its header). Reads
/// the rail out of the store rather than taking it from the caller, so a
/// rail deleted between render and click is caught here instead of
/// launching an agent at work that no longer exists.
export function requestRailReorganize(
  workspaceId: string,
  railId: string,
  cards: Map<string, CardEntry>,
  tools: ToolSummary[],
  conflictSummary: string[]
): Promise<string | null> {
  const orch = get(orchestrations)[workspaceId];
  const rail = orch?.rails.find((r) => r.id === railId);
  if (!orch || !rail) return Promise.resolve("That rail is gone");
  return launchOrchestrationAgent(
    workspaceId,
    { railId, label: reorganizeLabel(rail.name) },
    composeRailPrompt(orch, rail, cards, tools, conflictSummary)
  );
}

/// Puts the human in front of the run holding the slot -- what both
/// buttons do while one is going, instead of going dead.
///
/// A record whose session has left the layout reveals nothing and is left
/// alone: the sweep below owns clearing it, and a jump that quietly
/// deleted the record would hide the very run the human was asking about
/// if the reveal merely raced a page rebuild.
export async function revealOrchestrationAgent(workspaceId: string): Promise<void> {
  const record = get(layoutState).workspaces.find((w) => w.id === workspaceId)?.orchestrationAgent;
  if (!record) return;
  await revealSession(record.sessionId);
}

let sweepingAgents = false;
let sweepAgentsAgain = false;
let stopAgentWatch: (() => void) | null = null;

/// Frees the slot of every run that is over (orchestrationAgentOver).
///
/// A module-level subscription, NOT the hub tab's `$effect`: a run
/// finishing while the human is on some other tab still has to release
/// the button, and the same sweep is what ADOPTS a run at startup -- the
/// record loads with the workspaces, and the first pass over it decides
/// whether last night's agent is still thinking or long gone. There is no
/// separate adoption path, because there is no separate question.
///
/// Deliberately tolerant of arriving early: `interruptedSessionIds` and
/// `sessionStatusById` are seeded from Attach baselines that land after
/// bootstrap, so a first pass can read a killed run as live. The next
/// emission corrects it -- which is why this is a subscription and not a
/// one-shot at startup.
export function startOrchestrationAgentWatch(): () => void {
  stopAgentWatch?.();
  const unsubscribe = layoutState.subscribe(() => void sweepOrchestrationAgents());
  const stop = () => {
    unsubscribe();
    // Guarded: a later start owns the field, and this teardown arriving
    // afterwards must not clear the live watch out of it.
    if (stopAgentWatch === stop) stopAgentWatch = null;
  };
  stopAgentWatch = stop;
  return stop;
}

async function sweepOrchestrationAgents(): Promise<void> {
  // Clearing writes `layoutState`, which re-enters this subscription --
  // and so does anything else that lands during the persist. Collapsed
  // into a single replay (the shape `tick` already uses): re-entrant
  // passes only raise the flag, and the pass in flight runs once more
  // afterwards so a change that arrived mid-await is never the one nobody
  // looked at.
  if (sweepingAgents) {
    sweepAgentsAgain = true;
    return;
  }
  sweepingAgents = true;
  try {
    do {
      sweepAgentsAgain = false;
      for (const ws of get(layoutState).workspaces) {
        const record = ws.orchestrationAgent;
        if (!record) continue;
        // Re-read per workspace: the clear before this one persisted, and
        // liveness has to be judged against the state that came back.
        const state = get(layoutState);
        const status = state.sessionStatusById[record.sessionId];
        if (orchestrationAgentOver(sessionLiveness(state, record.sessionId), status)) {
          await setOrchestrationAgent(ws.id, null);
        }
      }
    } while (sweepAgentsAgain);
  } finally {
    sweepingAgents = false;
    sweepAgentsAgain = false;
  }
}

/// The queue's way back in: run a Generate/Reorganize intent that has
/// already cleared the gate.
///
/// The PROMPT travels with the intent rather than being recomposed. It
/// is a snapshot of the board at the moment the human asked -- which
/// cards were unplaced, which rails conflicted -- and rebuilding it
/// after a wait would send the agent a different request from the one it
/// was queued for.
export async function launchQueuedOrchestrationAgent(
  intent: OrchestrationIntent
): Promise<void> {
  await launchOrchestrationAgent(
    intent.workspaceId,
    { label: intent.agentLabel, railId: intent.railId },
    intent.prompt,
    true
  );
}
