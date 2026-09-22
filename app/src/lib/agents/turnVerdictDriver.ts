// The turn verdict's DRIVER: when to ask, whether to ask at all, and what
// to do with an answer that never comes.
//
// `turnVerdict.ts` is the policy and can be argued with in a test;
// `turnVerdictState.ts` is the map the answers land in. This file is the
// wiring between the daemon's status stream and those two, and it holds
// the four gates that decide whether a single byte ever leaves the
// machine. They are worth stating together, because the feature's whole
// claim is that it is safe to turn on:
//
//  1. **The human said so.** `enabled` is false until somebody set it,
//     and a key alone is not consent (`typesafe.rs`).
//  2. **There is a key.** No key, no request -- and the key lives in the
//     Rust host, so nothing here has ever seen it.
//  3. **The daemon can answer.** A daemon older than v39 has no
//     `SessionScreen` request. The app skips the verdict rather than
//     judging a turn on the empty string it would otherwise hold, which
//     is what `FEATURE_MIN_VERSION.turnVerdict` exists to make possible.
//  4. **The session is gavin's work, not the human's terminal.** Only a
//     session bound to a card run or standing behind a rail step is
//     asked about. A tab the human opened to type in is theirs, and its
//     screen is not gavin's to send anywhere.
//
// It reaches the status stream through a hook (`setSessionStatusHook`)
// rather than an import, and is started from the orchestration listeners
// rather than at load, for the reason autoResumeState is: it reads
// `orchestrations` and `kanbanState`, both of which read layoutState, so
// a static import from layoutState would close a cycle -- and it must
// not be imported statically by orchestrationState either, which is why
// the map it writes lives in a file of its own. Started once per window;
// a session is only ever asked about by the window whose workspace it
// belongs to, because the bindings gate 4 reads are the ones that window
// loaded.
//
// Everything else is the supersession discipline this codebase already
// insists on: an answer that arrives for a turn that is over is dropped,
// identified by a per-session token rather than by comparing objects
// (Svelte 5 proxies `$state`, so identity is never a valid guard).

import { get } from "svelte/store";

import * as backend from "$lib/core/backend";
import {
  agentForCard,
  daemonCompat,
  resolvedAgentFor,
  setSessionStatusHook,
} from "$lib/core/layoutState";
import { featureBlockedReason } from "$lib/core/daemonCompat";
import type { SessionStatus } from "$lib/core/notifications";
import { kanbanState } from "$lib/board/kanbanState";
import { gavinTrees } from "$lib/core/gavinState";
import { cardIndex, findStep } from "$lib/orchestration/orchestration";
import { orchestrations } from "$lib/orchestration/orchestrationState";
import { parseVerdictAnswers, readTurn, screenTail, verdictRequest } from "$lib/agents/turnVerdict";
import {
  PENDING_BACKSTOP_MS,
  loadTypesafeSettings,
  turnVerdictById,
  typesafeSettings,
  __resetForTesting as resetStores,
} from "$lib/agents/turnVerdictState";

/// The supersession token per session. Bumped on every new request and on
/// every clear; an answer whose token is stale is dropped.
///
/// A counter rather than an object comparison, per CLAUDE.md: Svelte 5
/// proxies `$state`, so `before !== after` is always true and identity
/// guards silently never fire.
const tokens = new Map<string, number>();

/// Why no verdict will be taken for this session, or null when one will.
///
/// One function for all four gates, in the order they are cheapest to
/// answer and most useful to hear: the daemon gate is also what the
/// Settings switch shows through `featureBlockedReason`, so the panel and
/// the driver can never disagree about whether the feature is live.
export function turnVerdictSkip(sessionId: string): string | null {
  const blocked = featureBlockedReason(get(daemonCompat), "turnVerdict");
  if (blocked) return blocked;
  const settings = get(typesafeSettings);
  if (!settings?.enabled) return "The TypeSafe turn verdict is off.";
  if (!settings.hasKey) return "No TypeSafe API key is set.";
  if (!ownerOf(sessionId)) {
    return "Only a session running a card or a rail step is judged, never a terminal you opened.";
  }
  return null;
}

/// The workspace this session is doing gavin's work in, and the card it
/// is doing it for when there is one.
interface Owner {
  workspaceId: string;
  cardPath: string | null;
}

/// Null is the answer for a bare terminal, the workspace's own Home
/// agent, a hidden commit run and a standalone tool run -- everything
/// whose screen is the human's business rather than a step gavin is
/// waiting on. Deliberately derived from the BINDINGS rather than from a
/// flag set at launch: a binding is the same fact every other surface
/// reads to decide a session is a run, and a launch-time register would
/// be a second list to keep in step.
function ownerOf(sessionId: string): Owner | null {
  for (const [workspaceId, board] of Object.entries(get(kanbanState))) {
    const bound = board?.cardSessions.find((cs) => cs.sessionId === sessionId);
    if (bound) return { workspaceId, cardPath: bound.path };
  }
  for (const [workspaceId, orch] of Object.entries(get(orchestrations))) {
    const run = orch?.stepRuns.find((r) => r.sessionId === sessionId);
    if (run) return { workspaceId, cardPath: findStep(orch, run.stepId)?.cardPath ?? null };
  }
  return null;
}

/// The profile id the session's agent runs as: the card's own where the
/// card names one (or its complexity level attributes one), the
/// workspace's otherwise -- the same resolution every launch route makes.
/// Context for the model rather than a gate: every question names
/// `agent_cli` so the model knows whose chrome it is reading, and the
/// screens it was measured on were labelled with the CLI that drew them.
function agentCliFor(owner: Owner): string {
  const plan = owner.cardPath
    ? cardIndex(get(gavinTrees)[owner.workspaceId]).get(owner.cardPath)?.plan
    : undefined;
  return (plan ? agentForCard(owner.workspaceId, plan) : resolvedAgentFor(owner.workspaceId))
    .profileId;
}

/// A session has gone quiet. Take a second opinion, or do not.
///
/// Fire-and-forget by contract: the caller is a status hook that must
/// not block, and every failure below is the same null the policy
/// already treats as "today's answer". Nothing here ever throws at its
/// caller.
export function noteQuietTransition(sessionId: string): void {
  if (turnVerdictSkip(sessionId) !== null) {
    // Not even a `read` entry: a session nobody asked about must look
    // exactly like one from a build without this feature, so that every
    // consumer's "no entry" path is the one that runs.
    clearTurnVerdict(sessionId);
    return;
  }
  const token = (tokens.get(sessionId) ?? 0) + 1;
  tokens.set(sessionId, token);
  // Marked pending BEFORE the first await, which is the point: the hook
  // that calls this fires before layoutState emits the status (see
  // handleSessionStatusChanged), and the scheduler reads this map
  // synchronously on that emission. A step that completed while the
  // request was in flight is a step the answer can never reach.
  turnVerdictById.update((m) => ({ ...m, [sessionId]: { state: "pending" } }));

  const backstop = setTimeout(() => settle(sessionId, token, null), PENDING_BACKSTOP_MS);
  void (async () => {
    try {
      const screen = await backend.sessionScreen(sessionId);
      // Re-checked after the await: the human may have typed, the daemon
      // may have gone, and the answer would be about a different turn.
      if (tokens.get(sessionId) !== token) return;
      const owner = ownerOf(sessionId);
      const agentCli = owner ? agentCliFor(owner) : "unknown";
      const body = await backend.typesafeAsk(verdictRequest(agentCli, screen));
      settle(sessionId, token, readTurn(parseVerdictAnswers(body), screenTail(screen)));
    } catch {
      // Every failure is one failure: an older daemon, a dead socket, a
      // refused key, a 500, a body this build cannot parse. They all mean
      // today's answer, and the consumers cannot tell them apart because
      // there is nothing useful they could do differently.
      settle(sessionId, token, null);
    } finally {
      clearTimeout(backstop);
    }
  })();
}

function settle(sessionId: string, token: number, reading: ReturnType<typeof readTurn>): void {
  if (tokens.get(sessionId) !== token) return;
  turnVerdictById.update((m) => ({ ...m, [sessionId]: { state: "read", reading } }));
}

/// Forgets this session's verdict.
///
/// Called when a session starts talking again: the verdict was about ONE
/// turn, and holding it past the next keystroke would stall a rail behind
/// a question the human has already answered. Bumps the token too, so an
/// answer still in flight for the turn just ended is dropped rather than
/// landing on the next one.
export function clearTurnVerdict(sessionId: string): void {
  tokens.set(sessionId, (tokens.get(sessionId) ?? 0) + 1);
  turnVerdictById.update((m) => {
    if (!(sessionId in m)) return m;
    const next = { ...m };
    delete next[sessionId];
    return next;
  });
}

/// The status hook. The second opinion is taken at exactly the
/// transition the daemon would otherwise call the end of a turn -- and
/// at no other, because that is the only moment the screen shows a turn
/// that is over rather than one in progress. `failed` rides with `idle`:
/// the daemon already has a reason for that one, and the verdict is what
/// can NAME the reason for the five profiles whose pattern table is
/// empty.
///
/// Any other status CLEARS the entry. A verdict is about one turn, and a
/// session that has started talking again has moved past it -- holding
/// the old reading would stall a rail behind a question the human has
/// already answered.
///
/// Guarded on a real CHANGE for the reason `statusSinceById` is: the
/// daemon re-reports a status it has already sent (a re-Attach, a
/// heuristic re-fire), and paying for a verdict on each of those would be
/// a request per bell rather than a request per turn.
function onSessionStatus(
  sessionId: string,
  status: SessionStatus,
  previousStatus: SessionStatus | undefined
): void {
  if (status === "idle" || status === "failed") {
    if (previousStatus !== status) noteQuietTransition(sessionId);
  } else {
    clearTurnVerdict(sessionId);
  }
}

/// Starts listening. Returns its own teardown, the way `startAutoResume`
/// does, so the orchestration listeners register it and their teardown
/// unwinds it. Also the moment the toggle and key state are first read
/// from the host: before this, `typesafeSettings` is null, which gates
/// off.
export function startTurnVerdict(): () => void {
  void loadTypesafeSettings();
  setSessionStatusHook(onSessionStatus);
  return () => {
    setSessionStatusHook(null);
    // Every token bumped, so an answer still in flight lands nowhere,
    // and the map emptied: nothing is listening for the turns it
    // described.
    for (const [id, token] of tokens) tokens.set(id, token + 1);
    turnVerdictById.set({});
  };
}

/// Test seam, matching `orchestrationState.__resetForTesting`.
export function __resetForTesting(): void {
  tokens.clear();
  resetStores();
}
