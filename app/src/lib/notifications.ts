import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type SessionStatus = "idle" | "working" | "waiting_for_input";

// Requested at most once per app run -- after a denied (or not-yet-decided)
// result, this stays true so a later notification-worthy transition
// doesn't re-prompt the OS permission dialog every single time. If the
// user later grants it via OS settings, isPermissionGranted() picks that
// up on its own on the next call; this flag only ever gates
// requestPermission() itself, not the isPermissionGranted() check.
let permissionRequested = false;

/**
 * @internal - for testing only
 */
export async function __resetForTesting(): Promise<void> {
  permissionRequested = false;
}

async function ensurePermission(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  if (permissionRequested) return false;
  permissionRequested = true;
  return (await requestPermission()) === "granted";
}

function isNotificationWorthy(previousStatus: SessionStatus | undefined, newStatus: SessionStatus): boolean {
  if (newStatus === "waiting_for_input") return true;
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
  prefs: NotifyPrefs
): Promise<void> {
  if (!isNotificationWorthy(previousStatus, newStatus)) return;

  // Per-workspace toggles (D38), checked before permission so a silenced
  // workspace never prompts for OS permission either.
  const enabled = newStatus === "waiting_for_input" ? prefs.needsInput : prefs.finished;
  if (!enabled) return;

  // Suppressed whenever gavin is the OS-frontmost window at all, regardless
  // of which pane is internally focused -- being in front of the app
  // already means the in-app status dot/badge is enough; checked before
  // touching permission state so a suppressed notification never
  // needlessly prompts for permission either.
  if (await getCurrentWindow().isFocused()) return;

  if (!(await ensurePermission())) return;

  const body = newStatus === "waiting_for_input" ? `${label} needs your input` : `${label} finished`;
  sendNotification({ title: "gavin", body });
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
