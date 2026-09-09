// The live side of `doneSessionReclaim.ts`: the one watcher that closes
// an idle agent of a done card when memory runs short, and the manual
// close the pressure banner offers.
//
// Every judgement -- which sessions, in what order, on which trigger,
// how fast -- lives in the pure module. What lives here is what those
// functions cannot: the stores they read, the close itself, the pacing
// clock, and the notice that tells the human what gavin did while they
// were looking elsewhere.
//
// ## Why a module-level watcher
//
// The same reason `startLaunchQueue` and `startMemoryPoll` are: a close
// that only happens while one particular tab is mounted is a close that
// never happens on the day it matters -- the human is on another
// workspace, or the window is behind the editor, and the machine is
// swapping. Started once by bootstrap, after the queue whose drain this
// is making room for.
//
// ## Why `closeSession` and not the daemon's kill
//
// `closeSession` is the app's one close path: it kills through the
// daemon, then takes the tab out of its tree and the maps in the order
// ClosedTabs documents. Calling the daemon directly would leave a dead
// tab on the page until the next reload -- the sessions manager has to
// do its own `handleSessionExited` for exactly that reason -- and would
// bypass the error strip that reports a refused kill.

import { derived, get, writable, type Readable } from "svelte/store";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { askConfirm } from "$lib/dialog";
import {
  heldRailCount,
  mayReclaim,
  reclaimCandidates,
  reclaimNoticeBody,
  reclaimNowPrompt,
  reclaimTrigger,
  type ReclaimCandidate,
  type ReclaimReason,
  type ReclaimRecord,
} from "$lib/sessions/doneSessionReclaim";
import { gavinTrees } from "$lib/gavinState";
import { kanbanState } from "$lib/board/kanbanState";
import { launchConfigStore, launchGateVerdict, launchQueue } from "$lib/launchQueue";
import { closeSession, layoutState } from "$lib/layoutState";
import { agentSessions, memoryPressure, systemMemory } from "$lib/memoryState";
import { orchestrations } from "$lib/orchestrationState";
import { closeTabsNow } from "$lib/tabActions";
import { findSessionLocation } from "$lib/workspace";

/// Every close the wall has made by itself this app run, oldest first.
///
/// In memory, like `resumeTrail`: the durable trace is the card's
/// binding, whose session no longer exists, and the tab that is no
/// longer there. This carries the detail -- what, when, how much, why --
/// for as long as the window that did it is open.
export const reclaimLog = writable<ReclaimRecord[]>([]);

/// The sessions the banner's manual close would end right now, with no
/// grace: a human looking at the tabs is the grace period. A store
/// rather than a call because the banner is mounted for the whole of a
/// critical spell and its button has to appear and disappear as agents
/// finish and cards move.
export const reclaimableNow: Readable<ReclaimCandidate[]> = derived(
  [layoutState, kanbanState, gavinTrees, agentSessions],
  ([state, boards, trees, agents]) =>
    reclaimCandidates({ state, boards, trees, agents, nowMs: Date.now(), graceMs: 0 })
);

// ---- The pacing ---------------------------------------------------------

let lastReclaimMs: number | null = null;
let lastReclaimSessions = 0;
/// One close at a time. `closeSession` awaits a daemon round trip, and a
/// second pass entering while the first is mid-await would close two
/// against one sample -- the burst the pacing exists to prevent.
let reclaiming = false;
let recheck: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;

/// Whether the fleet has shrunk since the last close -- the poll has
/// seen it go. Counted rather than identified, like the drain's
/// `lastLaunchObserved`: "the fleet is smaller" is the fact the next
/// decision needs, not the id of the row that left.
function lastReclaimObserved(): boolean {
  return Object.keys(get(agentSessions)).length < lastReclaimSessions;
}

/// Re-checks after the spacing, because nothing else emits on that
/// clock. One timer at a time.
function armRecheck(): void {
  if (recheck) clearTimeout(recheck);
  recheck = setTimeout(() => {
    recheck = null;
    void pass();
  }, 5_000);
}

/// One pass: close at most ONE session, then arm a re-check.
///
/// At most one because the trigger is about the machine as it is now,
/// and every close changes that. The candidate list is re-read on every
/// pass rather than kept: an agent can start a turn between two passes,
/// and a list frozen ten seconds ago would close it.
async function pass(): Promise<void> {
  if (reclaiming) return;
  const verdict = get(launchGateVerdict);
  const reason = reclaimTrigger({
    config: get(launchConfigStore),
    pressure: get(memoryPressure),
    queued: get(launchQueue).length,
    railsHeld: heldRailCount(get(orchestrations), verdict.allowed),
  });
  if (!reason) return;
  if (!mayReclaim({ lastReclaimMs, nowMs: Date.now(), lastReclaimObserved: lastReclaimObserved() })) {
    armRecheck();
    return;
  }
  const [next] = reclaimCandidates({
    state: get(layoutState),
    boards: get(kanbanState),
    trees: get(gavinTrees),
    agents: get(agentSessions),
    nowMs: Date.now(),
  });
  if (!next) return;
  reclaiming = true;
  try {
    lastReclaimMs = Date.now();
    lastReclaimSessions = Object.keys(get(agentSessions)).length;
    await closeSession(next.sessionId);
    // `closeSession` reports a refused kill to the error strip and
    // returns rather than throwing, so "it is no longer on any page" is
    // the only honest test of whether the close happened -- and a close
    // that did not happen must not be announced as one.
    if (!findSessionLocation(get(layoutState), next.sessionId)) record(next, reason);
  } catch {
    // The close path has already reported its own failure. The pacing
    // still counts the attempt, so a refusing session is not hammered
    // every two seconds for the rest of the spell.
  } finally {
    reclaiming = false;
  }
  armRecheck();
}

/// Starts the watcher. Module-level, like `startLaunchQueue`, and for
/// the reason the header gives. Returns its own teardown.
///
/// Subscribed to every store the trigger reads, and to `systemMemory`
/// as well: it is the CLOCK, replaced by the poller every two to five
/// seconds, which is what makes the grace period and the spacing tick
/// without a timer of their own.
export function startDoneSessionReclaim(): () => void {
  stopDoneSessionReclaim();
  const inputs = derived(
    [launchConfigStore, memoryPressure, systemMemory, launchQueue, orchestrations, launchGateVerdict],
    (values) => values
  );
  unsubscribe = inputs.subscribe(() => void pass());
  return stopDoneSessionReclaim;
}

export function stopDoneSessionReclaim(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (recheck) clearTimeout(recheck);
  recheck = null;
}

// ---- The notice ---------------------------------------------------------
//
// One OS notification per BURST, not per close. Under critical pressure
// the watcher closes a session every ten seconds or so until the kernel
// relaxes, and five notifications in a minute is how a notification
// stops being read. Each close re-arms the timer; the body is written
// when it fires, over everything since the last one.

/// Longer than the spacing between closes, so a burst lands as one line.
const NOTICE_DELAY_MS = 15_000;

let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let unannounced: ReclaimRecord[] = [];

function record(candidate: ReclaimCandidate, reason: ReclaimReason): void {
  const entry: ReclaimRecord = {
    sessionId: candidate.sessionId,
    label: candidate.label,
    cardTitle: candidate.cardTitle,
    rssBytes: candidate.rssBytes,
    atMs: Date.now(),
    reason,
  };
  reclaimLog.update((log) => [...log, entry]);
  unannounced.push(entry);
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    const batch = unannounced;
    unannounced = [];
    void sendReclaimNotice(reclaimNoticeBody(batch));
  }, NOTICE_DELAY_MS);
}

let permissionRequested = false;

async function ensurePermission(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  if (permissionRequested) return false;
  permissionRequested = true;
  return (await requestPermission()) === "granted";
}

/// Deliberately NOT suppressed when the window is focused, for the
/// reason `sendAutoResumeNotice` gives: a tab that vanished by itself is
/// the state this exists to explain, and nothing on screen explains it.
/// Never allowed to reject -- the close has already happened.
async function sendReclaimNotice(body: string): Promise<void> {
  try {
    if (!(await ensurePermission())) return;
    sendNotification({ title: "gavin", body });
  } catch {
    // A notification is the pointer, never the record.
  }
}

// ---- The manual close -----------------------------------------------------

/// The pressure banner's button: close every idle agent of a done card,
/// after asking once with all of them named. Returns how many were
/// closed, or zero when the human declined or there was nothing.
///
/// Through `closeTabsNow`, like the banner's other close: the asking is
/// done here with the app's own prompt, and `closeTabs` would ask again.
/// Not recorded in the log -- the log is what gavin did by itself, and
/// this is what the human did.
export async function reclaimDoneSessionsNow(): Promise<number> {
  const candidates = get(reclaimableNow);
  if (candidates.length === 0) return 0;
  if (!(await askConfirm(reclaimNowPrompt(candidates)))) return 0;
  await closeTabsNow(candidates.map((c) => c.sessionId));
  return candidates.length;
}

/// Test-only reset, so one suite's closes cannot be another's.
export function __resetDoneSessionReclaimForTesting(): void {
  stopDoneSessionReclaim();
  reclaiming = false;
  lastReclaimMs = null;
  lastReclaimSessions = 0;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = null;
  unannounced = [];
  permissionRequested = false;
  reclaimLog.set([]);
}
