// Ending a process that outlived the daemon: the write side of orphan.ts,
// kept out of that module so the wording stays a pure, testable
// projection.
//
// One flow, shared by every surface that can show an orphan, so the
// confirmation cannot be softer in one place than another. Killing a
// process gavin no longer hosts is the most destructive thing on this
// surface -- it is outside what the session owns, and there is no undo --
// so it is always confirmed, and the confirmation always names the
// process rather than the category.
//
// Asked through dialog.ts, never @tauri-apps/plugin-dialog: that plugin
// is narrowed to the file picker, and its confirm() rejects at the
// permission layer -- which made this button do nothing at all.

import { get } from "svelte/store";
import * as backend from "$lib/backend";
import { askConfirm, showAlert } from "$lib/dialog";
import { layoutState, handleOrphanEnded } from "$lib/layoutState";
import { describeOrphan, endOrphanConfirm, endOrphanOutcome } from "$lib/orphan";

/// Confirms, asks the daemon to end the session's surviving process, and
/// says what happened when it is worth saying.
///
/// The badge is cleared on `!stillRunning` rather than on `ended`, and
/// the difference is a real case: `ended` false with `stillRunning` false
/// is the daemon reporting it had nothing recorded, which means the
/// app's own state is the stale half. Both readings agree the process is
/// not there, and the badge must go in both.
///
/// A process that is STILL running keeps its badge, deliberately: it
/// ignored SIGTERM, the human is not done, and dropping the warning would
/// be the app reassuring them about something it just watched fail.
export async function endSessionOrphan(sessionId: string): Promise<void> {
  const orphan = get(layoutState).orphanBySessionId[sessionId];
  if (!orphan) return;
  if (!(await askConfirm(endOrphanConfirm(orphan)))) return;

  let result: { ended: boolean; stillRunning: boolean };
  try {
    result = await backend.endOrphan(sessionId);
  } catch (e) {
    await showAlert({
      title: `Couldn’t end ${describeOrphan(orphan)}`,
      lines: [e instanceof Error ? e.message : String(e)],
    });
    return;
  }

  if (!result.stillRunning) handleOrphanEnded(sessionId);
  const note = endOrphanOutcome(orphan, result);
  if (note) await showAlert(note);
}
