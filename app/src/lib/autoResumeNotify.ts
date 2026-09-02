// The one OS notification auto-resume sends, kept apart from
// notifications.ts on purpose.
//
// That module answers a different question -- "is this status TRANSITION
// worth interrupting for" -- and every one of its rules is about a
// session changing state. What auto-resume announces is not a
// transition: it is a decision gavin took while nobody was looking, and
// it has to travel even though the session it concerns has already been
// replaced by another one.
//
// It rides the workspace's `finished` toggle in spirit -- both say "a run
// reached an end" -- but it has no workspace to consult by the time it
// fires, and gating it on one would silence the single line explaining
// why a rail is suddenly running again. A human who opted into
// auto-resume asked for exactly this.

import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

let permissionRequested = false;

/// @internal - for testing only
export function __resetForTesting(): void {
  permissionRequested = false;
}

async function ensurePermission(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  if (permissionRequested) return false;
  permissionRequested = true;
  return (await requestPermission()) === "granted";
}

/// Deliberately NOT suppressed when the window is focused, unlike a
/// status change. The in-app dot answers "what is this session doing";
/// nothing on screen answers "gavin restarted this by itself", and a
/// human watching a rail come back to life with no explanation is the
/// state this whole feature has to avoid.
///
/// Never allowed to reject: the resume has already happened by the time
/// this runs, and a tray that refuses (no permission, no plugin) must
/// not turn a successful recovery into an unhandled rejection.
export async function sendAutoResumeNotice(body: string): Promise<void> {
  try {
    if (!(await ensurePermission())) return;
    sendNotification({ title: "gavin", body });
  } catch {
    // A notification is the pointer, never the record.
  }
}
