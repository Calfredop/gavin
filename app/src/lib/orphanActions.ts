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

import { confirm, message } from "@tauri-apps/plugin-dialog";
import { get } from "svelte/store";
import * as backend from "./backend";
import { layoutState, handleOrphanEnded } from "./layoutState";
import { describeOrphan, endOrphanConfirm, endOrphanOutcome } from "./orphan";

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
  if (!(await confirm(endOrphanConfirm(orphan), { title: "gavin", kind: "warning" }))) return;

  let result: { ended: boolean; stillRunning: boolean };
  try {
    result = await backend.endOrphan(sessionId);
  } catch (e) {
    await message(`Couldn't end ${describeOrphan(orphan)}: ${e}`, {
      title: "gavin",
      kind: "error",
    });
    return;
  }

  if (!result.stillRunning) handleOrphanEnded(sessionId);
  const note = endOrphanOutcome(orphan, result);
  if (note) await message(note, { title: "gavin", kind: "warning" });
}
