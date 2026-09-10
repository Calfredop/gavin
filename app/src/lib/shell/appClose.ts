// The question the window asks before it closes, and the one action that
// hangs off it.
//
// Closing the window has never stopped anything: the daemon outlives the
// app, so every terminal, agent and hidden run carries on and comes back
// when the app is reopened. That is the useful default -- it is what
// makes a restart cheap -- but it is not always what the human means by
// "quit", and up to now there was no way to say the other thing from
// here. The Sessions manager could end them one panel at a time, which
// is the wrong instrument for "I am done for the day".
//
// So the prompt carries both answers at once, through dialog.ts's
// tick-box (ConfirmCheck): one question, two outcomes. Two prompts in a
// row -- "close?" then "and kill?" -- is how a human learns to dismiss
// the second without reading it, which is exactly the prompt that must
// not be dismissed unread.
//
// The box is OFF by default and stays off: it makes the action strictly
// more destructive than the title says, and a default-on tick-box that
// ends a day's agents on a reflexive Enter is not a default, it is a
// trap.

import * as backend from "$lib/core/backend";
import { askConfirmChecked, showAlert, type AlertOptions, type ConfirmCheck, type ConfirmOptions } from "$lib/core/dialog";
import type { ManagedSession, ManagedSessions } from "$lib/sessions/sessionsManager";

/// The prompt, as data, so its wording is readable from a test rather
/// than only from the running window's modal.
export function closeWindowPrompt(): ConfirmOptions & { check: ConfirmCheck } {
  return {
    title: "Close this window?",
    lines: [
      "Your terminal sessions keep running — reopen the app to resume them.",
      "Tick the box to end them instead. Anything already written to disk stays, and nothing that was done is undone.",
    ],
    confirmLabel: "Close window",
    cancelLabel: "Keep open",
    check: { label: "End every terminal session too", default: false },
  };
}

/// What "end every terminal session" reaches, out of everything the
/// daemon is holding.
///
/// An exited row is a record with nothing behind it, so killing it buys
/// nothing -- UNLESS it left an orphan, a process that outlived the
/// daemon and is still editing the checkout. That one is the whole
/// reason a human ticks the box, and it is the one case where the
/// session the app would skip is the session that matters.
export function sessionsToEnd(sample: ManagedSessions): ManagedSession[] {
  return sample.sessions.filter((s) => s.status !== "exited" || s.orphan !== null);
}

/// What to say when the sweep could not end everything. Null when it
/// did, so the window closes without a word.
///
/// The window closes either way: the human asked for that, and a modal
/// that refused to would strand them. But a process that survived is
/// still editing their checkout after the app is gone, so it cannot pass
/// in silence.
export function survivingSessionsAlert(survived: string[]): (AlertOptions & { lines: string[] }) | null {
  if (survived.length === 0) return null;
  return {
    title: survived.length === 1 ? "One session is still running" : `${survived.length} sessions are still running`,
    lines: [
      survived.join(", "),
      "The window closes anyway. Reopen the app to reach them — the daemon still has them.",
    ],
    dismissLabel: "Close anyway",
  };
}

/// Ends every session the daemon is holding, and reports the ones that
/// refused. Sequential, and no exception escapes: this runs with the
/// window on its way out, so one wedged session must not keep the other
/// twenty alive or leave the close half-done.
///
/// The orphan goes first where there is one, for the reason
/// sessionsManagerActions gives: the surviving process is recorded ON
/// the session's registry row, and killing the session deletes that row,
/// so the other order leaves a live process with nothing left that knows
/// how to end it.
export async function endEverySession(): Promise<string[]> {
  let sample: ManagedSessions;
  try {
    sample = await backend.listManagedSessions();
  } catch {
    // Nothing to enumerate means nothing to report: the daemon is
    // already unreachable, so there is no sweep to have failed.
    return [];
  }
  const survived: string[] = [];
  for (const session of sessionsToEnd(sample)) {
    const label = session.command ?? session.cwd ?? session.id;
    if (session.orphan) {
      try {
        const result = await backend.endOrphan(session.id);
        if (result.stillRunning) {
          survived.push(label);
          continue;
        }
      } catch {
        survived.push(label);
        continue;
      }
    }
    try {
      await backend.killSession(session.id);
    } catch {
      survived.push(label);
    }
  }
  return survived;
}

/// Asks, acts on the tick-box, and answers whether the window should go.
///
/// The sweep happens HERE rather than after the caller destroys the
/// window, because a destroyed window has no frontend left to await the
/// kills -- the sessions would outlive the very close that was meant to
/// end them.
export async function confirmWindowClose(): Promise<boolean> {
  const answer = await askConfirmChecked(closeWindowPrompt());
  if (!answer.confirmed) return false;
  if (answer.checked) {
    const alert = survivingSessionsAlert(await endEverySession());
    if (alert) await showAlert(alert);
  }
  return true;
}
