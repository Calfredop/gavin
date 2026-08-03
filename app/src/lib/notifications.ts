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
export async function maybeNotifyStatusChange(
  sessionId: string,
  previousStatus: SessionStatus | undefined,
  newStatus: SessionStatus,
  label: string
): Promise<void> {
  if (!isNotificationWorthy(previousStatus, newStatus)) return;

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
