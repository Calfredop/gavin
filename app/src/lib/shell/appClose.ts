// The question the window asks before it closes, and the actions that
// hang off it.
//
// Closing the window has never stopped anything: the daemon outlives the
// app, so every terminal, agent and hidden run carries on and comes back
// when the app is reopened. That is the useful default -- it is what
// makes a restart cheap -- but it is not always what the human means by
// "quit", and the window that asked could only ever answer for itself.
// Since a workspace can be given a window of its own, destroying the
// main window left the others standing and the app running; and there
// was no way at all to say "and stop the daemon" from here.
//
// So the prompt is a ladder and the human picks one rung: this window,
// every window, every window and the sessions with them, or all of that
// and the daemon too. One question, four outcomes. Two prompts in a row
// -- "close?" then "and kill?" -- is how a human learns to dismiss the
// second without reading it, which is exactly the prompt that must not
// be dismissed unread.
//
// The ladder opens on the rung that changes nothing and never anywhere
// else: a prompt that opens further up is a default-on tick-box wearing
// a different hat, and ending a day's agents on a reflexive Enter is not
// a default, it is a trap.

import * as backend from "$lib/core/backend";
import { DAEMON_SUBJECT, grantForAnsweredPrompt } from "$lib/core/confirmGate";
import {
  askConfirmPicked,
  showAlert,
  type AlertOptions,
  type ConfirmOptions,
  type ConfirmPicker,
} from "$lib/core/dialog";
import type { ManagedSession, ManagedSessions } from "$lib/sessions/sessionsManager";

/// How far a close reaches. The order is the ladder's order, and it is
/// a severity order: every rung does what the one before it does.
export type CloseScope = "window" | "windows" | "sessions" | "daemon";

/// What a rung does, beyond destroying the window that asked -- which
/// every rung does, and so is not a field here.
export interface CloseActions {
  closeOtherWindows: boolean;
  endSessions: boolean;
  stopDaemon: boolean;
}

/// The rung, as the three switches it stands for.
///
/// `stopDaemon` never travels alone. The daemon owns the PTYs, so
/// stopping it ends every session whether or not anyone swept them --
/// but the sweep still runs first, because endEverySession() reaches an
/// orphan through the registry row that stopping the daemon takes away
/// with it. The other order leaves a live process editing the checkout
/// with nothing left that knows how to end it.
export function closeActionsFor(scope: CloseScope): CloseActions {
  return {
    closeOtherWindows: scope !== "window",
    endSessions: scope === "sessions" || scope === "daemon",
    stopDaemon: scope === "daemon",
  };
}

/// The prompt, as data, so its wording is readable from a test rather
/// than only from the running window's modal.
///
/// Each rung carries its own consequence, because a ladder whose rungs
/// are only named makes the human infer the cost -- and stating the
/// cost is the one thing this prompt exists to do.
export function closeWindowPrompt(): ConfirmOptions & {
  picker: ConfirmPicker & { default: string };
} {
  return {
    title: "Close gavin?",
    confirmLabel: "Close",
    cancelLabel: "Keep open",
    picker: {
      label: "How far should closing reach?",
      expanded: true,
      default: "window",
      options: [
        {
          value: "window",
          label: "Close this window",
          detail: "Your terminal sessions keep running — reopen the app to resume them.",
        },
        {
          value: "windows",
          label: "Close every gavin window",
          detail: "Your terminal sessions keep running here too; only the windows go.",
        },
        {
          value: "sessions",
          label: "Close every window and end the sessions",
          danger: true,
          detail:
            "Ends every terminal session. Anything already written to disk stays, and nothing that was done is undone.",
        },
        {
          value: "daemon",
          label: "Close everything and stop the daemon",
          danger: true,
          detail:
            "Ends every terminal session, then stops the daemon holding them. Nothing of gavin is left running.",
        },
      ],
    },
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

/// Stops the daemon, and says so when it would not go.
///
/// The stop is gated: `confirm_gate.rs` refuses a `stop_daemon` that no
/// prompt minted a token for, and the ladder IS that prompt -- picking
/// the rung that says it is the answer the gate exists to record.
async function stopTheDaemon(): Promise<(AlertOptions & { lines: string[] }) | null> {
  try {
    await backend.stopDaemon(await grantForAnsweredPrompt("stop_daemon", [DAEMON_SUBJECT]));
    return null;
  } catch (e) {
    return {
      title: "The daemon is still running",
      lines: [
        String(e),
        "The window closes anyway. Your sessions are still there — reopen the app to reach them.",
      ],
      dismissLabel: "Close anyway",
    };
  }
}

/// Asks, performs everything the chosen rung reaches, and answers
/// whether the window should now go.
///
/// The work happens HERE rather than after the caller destroys the
/// window, because a destroyed window has no frontend left to await it:
/// the sessions would outlive the very close meant to end them, and the
/// other windows would be left for nobody to close.
///
/// Nothing below the chosen rung is skipped when something above it
/// fails. The human asked to leave, and a close that stopped halfway
/// because one window would not go is a close that stranded them.
export async function confirmWindowClose(): Promise<boolean> {
  const answer = await askConfirmPicked(closeWindowPrompt());
  if (!answer.confirmed) return false;
  const actions = closeActionsFor(answer.picked as CloseScope);
  if (actions.closeOtherWindows) {
    await backend.closeAllWorkspaceWindows().catch(() => {});
  }
  if (actions.endSessions) {
    const alert = survivingSessionsAlert(await endEverySession());
    if (alert) await showAlert(alert);
  }
  if (actions.stopDaemon) {
    const alert = await stopTheDaemon();
    if (alert) await showAlert(alert);
  }
  return true;
}
