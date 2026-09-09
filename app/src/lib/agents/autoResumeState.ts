// The unattended half of recovery: what actually fires when an agent
// breaks and nobody is watching.
//
// Every judgement lives in autoResume.ts (pure, tested) and every claim
// in resumeClaim.ts. This module is the wiring -- who owns the failed
// session, whether its owner consented, the timer, the reachability
// gate, and the resume itself -- shaped after orchestrationState's
// scheduler: registered once at startup, owned by the module that owns
// the effect, not by whichever component happens to be mounted.

import { get, writable } from "svelte/store";
import { pauseFor } from "$lib/agents/agentPauseState";
import { mayLaunch } from "$lib/agents/launchQueue";
import {
  autoResumeDecision,
  isImmediateRefailure,
  resumeNotificationBody,
  resumeSkippedBody,
  staggerDelays,
  type AutoResumeDecision,
  type ResumeRecord,
} from "$lib/agents/autoResume";
import { claimKey, resumeClaims } from "$lib/agents/resumeClaim";
import { featureBlockedReason } from "$lib/core/daemonCompat";
import {
  daemonCompat,
  layoutState,
  resolvedAgentFor,
  setSessionFailureHook,
} from "$lib/core/layoutState";
import { sessionLabel } from "$lib/core/paths";
import { kanbanState } from "$lib/board/kanbanState";
import { gavinTrees } from "$lib/core/gavinState";
import { orchestrations, resumeStep } from "$lib/orchestration/orchestrationState";
import { resumeCard } from "$lib/cards/cardRunActions";
import { cardViewForPath, slugStatus } from "$lib/core/planBoard";
import { cardIndex, doneColumn, effectiveStatus, planIndex, stageMode } from "$lib/orchestration/orchestration";
import type { Rail, Step } from "$lib/orchestration/orchestration";
import type { SessionStatus } from "$lib/core/notifications";

/// What gavin has done about a run without being asked, by the thing it
/// belongs to: a rail step id, or a card's file path.
///
/// In memory, and deliberately so: the DURABLE half of the trail is
/// `resumeAttempts` on the run row, which survives a reload and a daemon
/// restart and is what lets a green rail still say it was not green all
/// along. This store carries the DETAIL -- when it broke, when it came
/// back, in whose words -- for as long as the window that watched it
/// happen is open.
export const resumeTrail = writable<Record<string, ResumeRecord>>({});

/// Timers armed and not yet fired, by the FAILED session's id.
const armed = new Map<string, { timer: ReturnType<typeof setTimeout>; baseDelay: number; key: string }>();

/// When each resumed session was started, by its NEW session id. Read
/// only to recognise an immediate second failure, which is evidence
/// about the network rather than about that one run.
const resumedAt = new Map<string, number>();

/// Set while waiting for `online`, so a wave that armed during an outage
/// re-checks rather than spending its attempts into a dead interface.
let waitingForOnline = false;

/// Injected so tests can drive the clock and the timers without a real
/// twenty-second wait. Production values are the module defaults.
interface Clock {
  now: () => number;
  online: () => boolean;
  random: () => number;
}

let clock: Clock = {
  now: () => Date.now(),
  // A gate, not a guarantee: `navigator.onLine` says a route exists,
  // never that the API is up. It earns the right to try; it never
  // predicts success -- which is what `isImmediateRefailure` is for.
  online: () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
  random: () => Math.random(),
};

/// @internal - for testing only
export function __setAutoResumeClock(next: Partial<Clock>): void {
  clock = { ...clock, ...next };
}

// ---- Who owns a failed session ---------------------------------------------

type Owner =
  | { kind: "step"; workspaceId: string; rail: Rail; step: Step }
  | { kind: "card"; workspaceId: string; path: string }
  | null;

/// A rail step outranks a card binding, and a card step has BOTH -- the
/// rail launches through the card-run path, so the same session is named
/// in both places. The rail is the richer owner: it carries the consent,
/// the stage the step sits in and the siblings that decide whether a
/// parallel stage can be resumed at all.
function ownerOf(sessionId: string): Owner {
  const orchs = get(orchestrations);
  for (const [workspaceId, orch] of Object.entries(orchs)) {
    const run = orch.stepRuns.find((r) => r.sessionId === sessionId);
    if (!run) continue;
    for (const rail of orch.rails) {
      for (const stage of rail.stages) {
        const step = stage.steps.find((t) => t.id === run.stepId);
        if (step) return { kind: "step", workspaceId, rail, step };
      }
    }
  }
  for (const [workspaceId, board] of Object.entries(get(kanbanState))) {
    const binding = board?.cardSessions.find((cs) => cs.sessionId === sessionId);
    if (binding) return { kind: "card", workspaceId, path: binding.path };
  }
  return null;
}

/// Whether the card this run was working on already reached the done
/// column. An agent can finish its edits and die before reporting them,
/// and re-running finished work is the failure mode this whole family of
/// cards exists to stop -- so it is checked before the cause, exactly as
/// `deadSessionAction` ranks a done card above an exit.
function cardIsFinished(workspaceId: string, cardPath: string): boolean {
  const board = get(kanbanState)[workspaceId];
  const done = board ? doneColumn(board) : null;
  if (!done) return false;
  const cards = cardIndex(get(gavinTrees)[workspaceId]);
  const entry = cards.get(cardPath);
  if (!entry) return false;
  const status = effectiveStatus(entry, planIndex(cards));
  return status !== null && slugStatus(status) === slugStatus(done.name);
}

/// The reason a PARALLEL stage cannot be resumed automatically, or null.
///
/// One interruption fails every step of a stage at once, and they all
/// become resumable in the same instant. Resuming more than one is
/// strictly worse than the same-worktree conflict `detectConflicts`
/// already warns about: each returning agent holds a transcript
/// describing the checkout as of the moment IT was cut off, while its
/// siblings kept editing right up to that same moment, and the staleness
/// is per-agent and invisible to each of them.
///
/// So a parallel stage resumes as a UNIT or not at all, and the only
/// unit gavin can put back safely is a unit of one. Two or more failed
/// members stay stalled with this sentence, which is today's behaviour
/// and therefore not a regression -- and the human who wants it anyway
/// still has the button, twice.
///
/// Deliberately NOT resolved by serialising the stage on resume: the
/// human chose parallel, and quietly converting it to a sequence during
/// recovery changes what their rail means.
///
/// A `sequence` stage runs one member at a time, so it can never trip
/// this and needs no case of its own.
function parallelStageBlocker(rail: Rail, step: Step): string | null {
  const stage = rail.stages.find((s) => s.steps.some((t) => t.id === step.id));
  if (!stage || stageMode(stage) !== "parallel" || stage.steps.length < 2) return null;
  const orch = Object.values(get(orchestrations)).find((o) =>
    o.rails.some((r) => r.id === rail.id)
  );
  const failures = get(layoutState).failureReasonById;
  const broken = stage.steps.filter((t) => {
    const sessionId = orch?.stepRuns.find((r) => r.stepId === t.id)?.sessionId;
    return sessionId ? failures[sessionId] !== undefined : false;
  });
  if (broken.length < 2) return null;
  return (
    `${broken.length} steps of this parallel stage broke together, and putting them all back ` +
    `would return each agent to a shared checkout its siblings had moved on from`
  );
}

// ---- The decision, assembled ------------------------------------------------

function decide(
  owner: NonNullable<Owner>,
  sessionId: string,
  previousStatus: SessionStatus | undefined
): AutoResumeDecision {
  const state = get(layoutState);
  const reason = state.failureReasonById[sessionId] ?? null;
  const agent = resolvedAgentFor(owner.workspaceId);
  // The budget cannot be persisted against an older daemon -- it drops
  // the field on the floor -- and a budget that resets on every write is
  // not a budget. Refused here as well as greyed out on both consent
  // surfaces, because a workspace that opted in against a NEWER daemon
  // and then fell back to an older one would otherwise loop.
  const tooOld = featureBlockedReason(get(daemonCompat), "autoResume");

  if (owner.kind === "step") {
    const orch = get(orchestrations)[owner.workspaceId];
    const run = orch?.stepRuns.find((r) => r.stepId === owner.step.id);
    return autoResumeDecision({
      consented: owner.rail.autoResume === true,
      reason,
      causes: agent.failureCauses,
      previousStatus,
      attempts: run?.resumeAttempts,
      conversationId: run?.conversationId,
      workFinished: owner.step.cardPath ? cardIsFinished(owner.workspaceId, owner.step.cardPath) : false,
      blocked: tooOld ?? parallelStageBlocker(owner.rail, owner.step),
    });
  }

  const board = get(kanbanState)[owner.workspaceId];
  const binding = board?.cardSessions.find((cs) => cs.path === owner.path);
  const workspace = state.workspaces.find((w) => w.id === owner.workspaceId);
  return autoResumeDecision({
    consented: workspace?.autoResumeRuns === true,
    reason,
    causes: agent.failureCauses,
    previousStatus,
    attempts: binding?.resumeAttempts,
    conversationId: binding?.conversationId,
    workFinished: cardIsFinished(owner.workspaceId, owner.path),
    blocked: tooOld,
  });
}

/// Whether this owner opted in at all. A workspace that never asked for
/// auto-resume must not be told, every time an agent breaks, that gavin
/// declined to do something it was never allowed to do.
function consented(owner: NonNullable<Owner>): boolean {
  if (owner.kind === "step") return owner.rail.autoResume === true;
  return get(layoutState).workspaces.find((w) => w.id === owner.workspaceId)?.autoResumeRuns === true;
}

// ---- Firing -----------------------------------------------------------------

function ownerLabel(owner: NonNullable<Owner>, sessionId: string): string {
  const state = get(layoutState);
  const path = owner.kind === "step" ? owner.step.cardPath : owner.path;
  const entry = path ? cardIndex(get(gavinTrees)[owner.workspaceId]).get(path) : undefined;
  return entry?.plan.title ?? sessionLabel(state.sessionNames, state.cwdBySessionId, sessionId);
}

async function notify(body: string): Promise<void> {
  const { sendAutoResumeNotice } = await import("$lib/agents/autoResumeNotify");
  await sendAutoResumeNotice(body);
}

/// Cancels every timer still waiting. Used when a resume that already
/// fired broke again straight away: reachability was a gate, not a
/// promise, and the rest of the wave would spend its single attempt each
/// on the same dead network.
function abortWave(why: string, exceptSessionId?: string): void {
  for (const [sessionId, entry] of [...armed]) {
    if (sessionId === exceptSessionId) continue;
    clearTimeout(entry.timer);
    resumeClaims.release(entry.key);
    armed.delete(sessionId);
  }
  if (why) void notify(why);
}

/// How long a deferred resume waits before looking again.
///
/// A cap, not a schedule: the pause knows when it lifts, and this only
/// stops that turning into one very long `setTimeout` -- the timer a
/// closed laptop does not honour, and the reason every instant in this
/// feature is absolute rather than a countdown.
const PAUSE_RECHECK_MS = 60_000;

async function fire(sessionId: string, previousStatus: SessionStatus | undefined): Promise<void> {
  const entry = armed.get(sessionId);
  armed.delete(sessionId);
  if (!entry) return;

  const owner = ownerOf(sessionId);
  if (!owner) {
    resumeClaims.release(entry.key);
    return;
  }

  // Re-decided, not trusted from arm time. Between the two, a sibling in
  // the same parallel stage may have failed (making this one unsafe), the
  // human may have pressed Resume themselves, or the card may have
  // reached the done column -- and the delay exists precisely so that
  // burst has time to land.
  const decision = decide(owner, sessionId, previousStatus);
  if (decision.kind !== "resume") {
    resumeClaims.release(entry.key);
    void notify(resumeSkippedBody(ownerLabel(owner, sessionId), decision.why));
    return;
  }

  // A pause DEFERS a resume; it does not cancel it. Re-armed rather than
  // skipped for the same reason the offline branch below re-arms: the run
  // is still worth resuming, this is simply not the moment. Skipping
  // would let a ten-minute scheduled pause cost a network failure its one
  // recovery, which is a pause deciding something it was never given.
  //
  // The re-arm is capped rather than sleeping until the pause lifts,
  // because a multi-hour `setTimeout` is precisely what does not survive
  // a laptop closing -- so this polls, and each poll re-reads a verdict
  // computed from the wall clock.
  const pause = pauseFor(owner.workspaceId, clock.now());
  if (pause.paused) {
    const wait = pause.until == null ? PAUSE_RECHECK_MS : pause.until - clock.now();
    armWait(sessionId, previousStatus, Math.min(Math.max(wait, 1_000), PAUSE_RECHECK_MS), entry.key);
    return;
  }

  // The launch wall DEFERS a resume, exactly as a pause does and for the
  // same reason: the run is still worth resuming, this is simply not the
  // moment, and spending the one automatic attempt on a launch the gate
  // is going to hold would cost a real failure its recovery.
  //
  // Re-armed rather than queued. An auto-resume is already a timer that
  // re-reads its own conditions, so handing it to the queue as well
  // would give one resume two owners -- the same reason a rail step is
  // not queued.
  if (!mayLaunch()) {
    armWait(sessionId, previousStatus, PAUSE_RECHECK_MS, entry.key);
    return;
  }

  // The gate, checked as late as possible. An interface that is still
  // down means the signal has not really arrived: wait for `online`
  // rather than spending the one attempt on it. Bounded by the timer
  // being re-armed rather than by a loop -- if `online` never fires (the
  // event is not guaranteed in WKWebView), the backoff delay below still
  // gets there.
  if (!clock.online()) {
    armWait(sessionId, previousStatus, entry.baseDelay, entry.key);
    return;
  }

  const failedAt = clock.now();
  const reason = get(layoutState).failureReasonById[sessionId] ?? "";
  const label = ownerLabel(owner, sessionId);
  const error =
    owner.kind === "step"
      ? await resumeStep(owner.workspaceId, owner.step.id, { automatic: true })
      : await resumeCardByPath(owner.workspaceId, owner.path);

  if (error) {
    // The caller that takes a claim and then fails to launch gives it
    // back, or the human's own press does nothing for the next minute.
    resumeClaims.release(entry.key);
    void notify(resumeSkippedBody(label, error));
    return;
  }

  const record: ResumeRecord = {
    cause: decision.cause,
    reason,
    failedAt,
    resumedAt: clock.now(),
  };
  const trailKey = owner.kind === "step" ? owner.step.id : owner.path;
  resumeTrail.update((t) => ({ ...t, [trailKey]: record }));
  // The NEW session, so an immediate second failure is recognised as one.
  const replacement =
    owner.kind === "step"
      ? get(orchestrations)[owner.workspaceId]?.stepRuns.find((r) => r.stepId === owner.step.id)
          ?.sessionId
      : get(kanbanState)[owner.workspaceId]?.cardSessions.find((cs) => cs.path === owner.path)
          ?.sessionId;
  if (replacement) resumedAt.set(replacement, record.resumedAt);
  void notify(resumeNotificationBody(label, record));
}

async function resumeCardByPath(workspaceId: string, path: string): Promise<string | null> {
  const card = cardViewForPath(get(gavinTrees)[workspaceId], path);
  if (!card) return "the card file is gone";
  return resumeCard(workspaceId, card, { automatic: true });
}

/// Arms (or re-arms) a resume, staggered against everything else already
/// waiting.
function armWait(
  sessionId: string,
  previousStatus: SessionStatus | undefined,
  baseDelay: number,
  key: string
): void {
  const existing = [...armed.values()].map((a) => a.baseDelay);
  const delays = staggerDelays([...existing, baseDelay], clock.random);
  const delay = delays[delays.length - 1];
  const timer = setTimeout(() => void fire(sessionId, previousStatus), delay);
  armed.set(sessionId, { timer, baseDelay, key });
  ensureOnlineWatch();
}

/// One `online` listener for the whole module, and only while something
/// is waiting. It does not fire the resumes itself -- their timers do
/// that, and re-check reachability when they land. It exists so a wave
/// armed during an outage is re-checked promptly rather than at the end
/// of a sixty-second backoff.
function ensureOnlineWatch(): void {
  if (waitingForOnline || typeof window === "undefined") return;
  waitingForOnline = true;
  window.addEventListener(
    "online",
    () => {
      waitingForOnline = false;
    },
    { once: true }
  );
}

// ---- The entry point --------------------------------------------------------

function onSessionFailed(
  sessionId: string,
  _reason: string,
  previousStatus: SessionStatus | undefined
): void {
  // A resume that broke again within seconds says the network is not
  // actually back. That is evidence about the WAVE, not a second
  // independent failure, so it cancels everything still waiting rather
  // than letting each sibling spend its single attempt on the same dead
  // interface.
  const startedAt = resumedAt.get(sessionId);
  if (startedAt !== undefined && isImmediateRefailure(startedAt, clock.now())) {
    abortWave(
      "A resumed agent broke again straight away, so gavin stopped resuming the others — the connection is not back."
    );
    return;
  }

  const owner = ownerOf(sessionId);
  if (!owner) return;
  const decision = decide(owner, sessionId, previousStatus);
  if (decision.kind !== "resume") {
    // Silence unless the human asked gavin to act here. A workspace that
    // never opted in must not be told, at every failure, about something
    // it never asked for -- but one that DID opt in has to hear why
    // nothing happened, or a stalled rail is indistinguishable from a
    // forgotten one.
    if (consented(owner)) {
      void notify(resumeSkippedBody(ownerLabel(owner, sessionId), decision.why));
    }
    return;
  }

  // Nothing may fire a resume for a session that already has one in
  // flight -- the automatic one landing at the same moment the human
  // presses the button is the likeliest double-fire of the lot, since
  // the notification that prompts them arrives exactly when this does.
  const key = claimKey(resolvedAgentFor(owner.workspaceId).profileId, sessionId);
  if (!resumeClaims.tryClaim(key)) return;
  armWait(sessionId, previousStatus, decision.delayMs, key);
}

/// Starts listening. Returns its own teardown, the way `startScheduler`
/// does, so bootstrap registers it and teardown unwinds it.
export function startAutoResume(): () => void {
  setSessionFailureHook(onSessionFailed);
  return () => {
    setSessionFailureHook(null);
    abortWave("");
  };
}

/// @internal - for testing only
export function __resetAutoResume(): void {
  abortWave("");
  armed.clear();
  resumedAt.clear();
  waitingForOnline = false;
  resumeTrail.set({});
  resumeClaims.clear();
  clock = {
    now: () => Date.now(),
    online: () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
    random: () => Math.random(),
  };
}
