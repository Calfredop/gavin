import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";

/// What the daemon says a session is doing.
///
/// `failed` (v21) is a live process at a prompt, exactly like `idle` --
/// the agent stopped because something BROKE rather than because its
/// turn ended, and those two used to be byte-identical two seconds of
/// silence. `unknown` is a status this build does not recognise, written
/// by a NEWER daemon into the same registry.
export type SessionStatus = "idle" | "working" | "waiting_for_input" | "failed" | "unknown";

const KNOWN_STATUSES: readonly SessionStatus[] = [
  "idle",
  "working",
  "waiting_for_input",
  "failed",
  "unknown",
];

/// Every status string that crosses from Rust, run through one door.
///
/// The daemon's `SessionStatus::from_str` used to map anything it did
/// not recognise to `idle`, and that default is exactly backwards here:
/// `idle` is the ONE value orchestration reads as "the turn ended, mark
/// the step done and advance the rail". A future "the agent broke"
/// status invented by a v22 daemon would, on that default, advance a
/// rail on the strength of not being understood. Unknown means unknown,
/// and every consumer has to say what it does with that.
///
/// Not gated by daemon version: `StatusChanged` carries the status as a
/// plain string, so `min_version_for` -- which gates request TYPES --
/// is structurally blind to it. This function is the whole protection
/// on the app's side of the wire.
export function parseSessionStatus(raw: string): SessionStatus {
  return (KNOWN_STATUSES as readonly string[]).includes(raw) ? (raw as SessionStatus) : "unknown";
}


// Requested at most once per app run -- after a denied (or not-yet-decided)
// result, this stays true so a later notification-worthy transition
// doesn't re-prompt the OS permission dialog every single time. If the
// user later grants it via OS settings, isPermissionGranted() picks that
// up on its own on the next call; this flag only ever gates
// requestPermission() itself, not the isPermissionGranted() check.
let permissionRequested = false;

/// What a RAIL says about one of its own step's sessions, when the
/// generic body would be wrong. Returns a replacement body, or null to
/// leave the generic one alone.
///
/// Registered rather than imported, and this is the direction that
/// works: orchestrationState.ts already reads layoutState, so the
/// orchestration layer cannot be imported from here (or from
/// layoutState) without a cycle. This module imports nothing of gavin's
/// at all, which is what keeps that true.
export type StatusVoice = (sessionId: string, status: SessionStatus) => string | null;

let railVoice: StatusVoice | null = null;

/// Called once at startup by initOrchestrationListeners. Passing null
/// clears it, which is what the teardown and the tests do.
export function setRailNotificationVoice(voice: StatusVoice | null): void {
  railVoice = voice;
}

/**
 * @internal - for testing only
 */
export async function __resetForTesting(): Promise<void> {
  permissionRequested = false;
  railVoice = null;
}

async function ensurePermission(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  if (permissionRequested) return false;
  permissionRequested = true;
  return (await requestPermission()) === "granted";
}

function isNotificationWorthy(previousStatus: SessionStatus | undefined, newStatus: SessionStatus): boolean {
  if (newStatus === "waiting_for_input") return true;
  // A run that ended BADLY is at least as worth interrupting for as one
  // that ended well -- and until v21 this was the same transition as the
  // one below, so a network-killed agent sent the human a notification
  // saying it had finished. Notified from any previous status, not only
  // `working`: a failure is news whatever the session was doing, and
  // the daemon only ever writes it at the end of a turn.
  if (newStatus === "failed") return true;
  return previousStatus === "working" && newStatus === "idle";
}

// Called for every status transition a session reports; no-ops unless the
// specific transition is one of the two the design calls out as actually
// worth interrupting the user for. previousStatus is undefined for a
// session's very first-ever status report (its Attach-time baseline) --
// that's never treated as a transition, since there's nothing to
// transition *from*, except waiting_for_input, which is always
// notification-worthy regardless of what (if anything) came before it.
export interface NotifyPrefs {
  needsInput: boolean;
  finished: boolean;
}

export async function maybeNotifyStatusChange(
  sessionId: string,
  previousStatus: SessionStatus | undefined,
  newStatus: SessionStatus,
  label: string,
  prefs: NotifyPrefs,
  /// Why the session failed, when it did (`layoutState.failureReasonById`).
  /// The body of a failure notification is the agent's own sentence:
  /// "stopped" alone tells the human nothing they can act on, and a dead
  /// network and an expired token want opposite responses.
  failureReason?: string
): Promise<void> {
  if (!isNotificationWorthy(previousStatus, newStatus)) return;

  // Per-workspace toggles (D38), checked before permission so a silenced
  // workspace never prompts for OS permission either. A failure rides
  // the `finished` toggle rather than a third one: both say "this run
  // reached an end", which is the thing that toggle answers for.
  const enabled = newStatus === "waiting_for_input" ? prefs.needsInput : prefs.finished;
  if (!enabled) return;

  // Suppressed whenever gavin is the OS-frontmost window at all, regardless
  // of which pane is internally focused -- being in front of the app
  // already means the in-app status dot/badge is enough; checked before
  // touching permission state so a suppressed notification never
  // needlessly prompts for permission either.
  if (await getCurrentWindow().isFocused()) return;

  if (!(await ensurePermission())) return;

  // A rail's own words first. "finished" is the generic body for
  // working -> idle, and for a card step whose agent stopped WITHOUT
  // setting its card's status that word is simply false -- the agent
  // stopped, the work did not finish, and the rail is still waiting on
  // it. Correcting the one notification beats adding a second one
  // beside it: two lines contradicting each other in the same tray is
  // worse than the silence this card was filed about.
  const generic =
    newStatus === "waiting_for_input"
      ? `${label} needs your input`
      : newStatus === "failed"
        ? failureBody(label, failureReason)
        : `${label} finished`;
  sendNotification({ title: "gavin", body: railVoice?.(sessionId, newStatus) ?? generic });
}

/// A failure notification's body. Separate so the tray and the surfaces
/// that show the same fact cannot drift apart, and so the no-reason case
/// -- a v21 daemon that pushed the status and lost the reason -- still
/// says something true rather than an empty tail.
export function failureBody(label: string, reason: string | undefined): string {
  const said = reason?.trim();
  return said ? `${label} stopped — ${said}` : `${label} stopped: its agent did not finish`;
}

// ---- a rail's manual-review gate -------------------------------------------

/// What a review gate says in the tray. Names the RAIL and the step,
/// because a fleet can have several rails stopped at once and the body
/// is the only part of the notification the human reads before deciding
/// whether to get up.
export function reviewWaitBody(railName: string, stepName: string): string {
  const rail = railName.trim() || "a rail";
  const step = stepName.trim() || "a review step";
  return `${rail} is waiting for you — ${step}`;
}

/// Called once, when a rail reaches a `review` step and stops there.
///
/// A step of its own kind of silence: there is no session, so no status
/// ever changes and `maybeNotifyStatusChange` above can never speak for
/// it. Without this, a rail running unattended would stop at its gate
/// and tell nobody -- which is the whole failure the gate exists to
/// avoid, arrived at from the other side.
///
/// Gated by `needsInput` rather than `finished`: nothing finished, and
/// the sentence is "come and look at this", which is the fact that
/// toggle answers for. Suppressed while gavin is frontmost, exactly as a
/// status change is -- the rail draws a "needs you" badge and the step a
/// Skip button, and a tray notification for something already on screen
/// is noise.
export async function maybeNotifyReviewWait(
  railName: string,
  stepName: string,
  prefs: NotifyPrefs
): Promise<void> {
  // Before the window and before permission, so a silenced workspace
  // neither queries one nor prompts for the other.
  if (!prefs.needsInput) return;
  if (await getCurrentWindow().isFocused()) return;
  if (!(await ensurePermission())) return;
  sendNotification({ title: "gavin", body: reviewWaitBody(railName, stepName) });
}

// ---- the Git tab's hidden commit run ---------------------------------------

/// What a "Commit via agent" run turned out to have done. Only the three
/// outcomes `watchAgentCommit` actually reaches: a run abandoned by a
/// worktree switch, or one whose session died with the last window,
/// reaches no verdict at all and so has nothing to announce.
export type AgentCommitVerdict =
  | { kind: "committed" }
  | { kind: "failed"; exitCode: number }
  | { kind: "left-dirty"; changes: number };

/// Deliberately short. The notification is the POINTER -- the Git tab's
/// banner is the record, and it keeps the agent's own closing words. A
/// body long enough to quote them would be truncated by the OS anyway.
export function agentCommitBody(label: string, verdict: AgentCommitVerdict): string {
  switch (verdict.kind) {
    case "committed":
      return `${label}: changes committed`;
    case "failed":
      return `${label}: commit agent failed (exit ${verdict.exitCode})`;
    case "left-dirty":
      return `${label}: commit agent left ${verdict.changes} change${verdict.changes === 1 ? "" : "s"} uncommitted`;
  }
}

/// Called once per commit run that reaches a verdict. A hidden run is
/// the one piece of work in this app with no tab, no page and no status
/// dot -- the human clicks a button and walks away -- so the verdict
/// has to travel to them rather than wait on a tab.
///
/// Gated by the workspace's `finished` toggle: a hidden run is a session
/// finishing, and a workspace silenced for that stays silenced. It gets
/// no toggle of its own; one button does not earn a third checkbox.
///
/// `gitTabOnScreen` is the one thing this module cannot know, and it is
/// why the suppression rule here is NARROWER than the one for session
/// status above. There, any focused window means the in-app dot is
/// visible; here, the verdict shows on exactly one tab, so a human who
/// is in the app but looking at anything else is precisely the case
/// that was announced nowhere.
export async function maybeNotifyAgentCommit(
  label: string,
  verdict: AgentCommitVerdict,
  prefs: NotifyPrefs,
  gitTabOnScreen: boolean
): Promise<void> {
  // Checked before anything else so a silenced workspace neither
  // queries the window nor prompts for OS permission.
  if (!prefs.finished) return;
  if (gitTabOnScreen && (await getCurrentWindow().isFocused())) return;
  if (!(await ensurePermission())) return;
  sendNotification({ title: "gavin", body: agentCommitBody(label, verdict) });
}
