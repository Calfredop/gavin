// What the app says about a session whose agent outlived the daemon.
//
// Pure, so the wording -- which is the whole deliverable here -- is
// testable without a terminal, a daemon or a DOM. Every surface that
// mentions a restored, interrupted or orphaned session reads its copy
// from this file, so the three states cannot be described differently in
// two places.
import type { DaemonCompat } from "./daemonCompat";
import { FEATURE_MIN_VERSION } from "./daemonCompat";

/// A process the daemon found still running with no tab in front of it.
/// The pid is for the human to recognise in Activity Monitor; the
/// command is what makes a confirmation nameable. Deliberately no
/// identity token -- ending it goes back through the daemon, which
/// re-probes, so the app never holds enough to signal a process itself.
export type OrphanProcess = {
  pid: number;
  command: string | null;
};

/// Which of the three things a restored tab's badge is saying.
///
/// Ordered by how much work is at stake: a `restored` shell lost
/// scrollback, an `interrupted` one lost a run, an `orphaned` one lost a
/// run that is STILL EDITING THE CHECKOUT. Only the last has an action.
export type BadgeTone = "restored" | "interrupted" | "orphaned";

export type RestoredBadge = {
  tone: BadgeTone;
  title: string;
  /// Whether this badge offers to end a surviving process. Only ever
  /// true for `orphaned` -- there is nothing to end in the other two.
  canEnd: boolean;
};

/// Names a process the way a human can act on: the command if there is
/// one, always the pid, because the pid is what Activity Monitor shows
/// and the pid is the fallback if gavin's own button fails them.
export function describeOrphan(orphan: OrphanProcess): string {
  const command = orphan.command?.trim();
  return command ? `${command} (pid ${orphan.pid})` : `pid ${orphan.pid}`;
}

/// Whether this daemon has actually LOOKED for surviving processes.
///
/// The distinction the whole reporting half turns on, and the trap
/// `setupProgress` hit: absence of an orphan is not the same as absence
/// of a survivor. A daemon below v22 never probes, so "no orphan
/// reported" from it is unknown, not negative -- and copy that asserts
/// the process is gone would be stating something nobody measured.
///
/// `null` (not connected yet) counts as knowing, for the same reason
/// `featureBlockedReason` returns null there: the app must not
/// pre-emptively hedge everything it says during startup.
export function orphanDetectionAvailable(c: DaemonCompat | null): boolean {
  return c === null || c.daemonVersion >= FEATURE_MIN_VERSION.orphanDetection;
}

/// The badge over a tab whose shell came back after a daemon restart, or
/// null when there is nothing to show.
///
/// `restored` still decides whether the badge is THERE at all, exactly as
/// it always did -- it is a note about the screen, and typing dismisses
/// it. The other two only decide what it SAYS.
///
/// The interrupted wording splits on whether the daemon probed. On v21+
/// "no orphan" is a measurement and the copy can say the agent's process
/// is gone; below that it is silence, and the copy says so rather than
/// promising a clean stop the daemon never checked for.
export function restoredBadge(args: {
  restored: boolean;
  interrupted: boolean;
  orphan: OrphanProcess | null;
  compat: DaemonCompat | null;
}): RestoredBadge | null {
  const { restored, interrupted, orphan, compat } = args;
  if (orphan) {
    return {
      tone: "orphaned",
      title:
        `The daemon restarted while an agent was working here, and the agent DID NOT STOP. ` +
        `${describeOrphan(orphan)} is still running in this folder with nothing in front of it. ` +
        `This tab is a plain shell. Click to end that process.`,
      canEnd: true,
    };
  }
  if (!restored) return null;
  if (interrupted) {
    return {
      tone: "interrupted",
      title: orphanDetectionAvailable(compat)
        ? "The daemon restarted while an agent was working here. It was stopped and NOT restarted, and its process is gone — this is a plain shell in the same folder."
        : "The daemon restarted while an agent was working here. It was stopped and NOT restarted — this is a plain shell in the same folder. This daemon is too old to check whether the agent's process actually exited.",
      canEnd: false,
    };
  }
  return {
    tone: "restored",
    title: "This session's shell was freshly restarted after the daemon restarted",
    canEnd: false,
  };
}

/// The paragraph the card detail shows under an interrupted binding.
///
/// The card modal is where the human presses Resume, which is the move
/// this whole card exists to protect: resuming next to an agent that is
/// still running puts a SECOND agent in a checkout that already has one
/// — by a different route than the re-run v20 closed, and from behind a
/// button the app itself recommends.
///
/// So the three wordings are ordered by what they let the human do next.
/// A survivor says "end it first" before Resume is mentioned at all. A
/// probed-and-clean run says so. An unprobed one admits it does not
/// know, rather than promising the clean stop nobody checked for.
export function interruptedCardNote(args: {
  orphan: OrphanProcess | null;
  compat: DaemonCompat | null;
}): string {
  const { orphan, compat } = args;
  const base =
    "The daemon restarted while this agent was working, so it was stopped and not restarted — " +
    "the tab now holds a plain shell. Whatever it had already written is still in the checkout.";
  if (orphan) {
    return (
      `The daemon restarted while this agent was working — but the agent DID NOT STOP. ` +
      `${describeOrphan(orphan)} is still running in this folder, editing the same checkout, ` +
      `with a plain shell in the tab where it used to be. End it before you resume, or you will ` +
      `have two agents working on the same card at once.`
    );
  }
  if (!orphanDetectionAvailable(compat)) {
    return (
      `${base} This daemon is too old to check whether the agent's process actually exited, ` +
      `so confirm it is gone before resuming. Resume picks that work up; Re-launch would start ` +
      `the card over from the beginning.`
    );
  }
  return (
    `${base} Its process is gone — the daemon checked. ` +
    `Resume picks that work up; Re-launch would start the card over from the beginning.`
  );
}

/// What the confirmation asks before ending a surviving process.
///
/// Killing something outside the session gavin owns is the most
/// destructive thing on this surface, so the prompt names the process
/// rather than describing the category, and says what will and will not
/// happen: the work it has already written to disk stays, and nothing is
/// undone.
export function endOrphanConfirm(orphan: OrphanProcess): string {
  return (
    `End ${describeOrphan(orphan)}?\n\n` +
    `This agent outlived the daemon and is still running in this folder. ` +
    `Ending it sends SIGTERM — any edit it has already written to disk stays, ` +
    `and nothing it did is undone.`
  );
}

/// The outcome line after a press, or null when there is nothing worth
/// interrupting the human for.
///
/// Success is silent: the badge disappearing IS the feedback, and a modal
/// confirming what the human just watched happen is noise. The two
/// failures are not silent, because in both cases the process the human
/// asked to kill may still be running and they need to know that they are
/// not done.
export function endOrphanOutcome(
  orphan: OrphanProcess,
  result: { ended: boolean; stillRunning: boolean }
): string | null {
  if (result.ended) return null;
  if (result.stillRunning) {
    return (
      `${describeOrphan(orphan)} was asked to stop and is still running. ` +
      `It is ignoring SIGTERM, which is how it survived the daemon in the first place. ` +
      `Ending it will have to be done from Activity Monitor, or with \`kill -9 ${orphan.pid}\`.`
    );
  }
  return `${describeOrphan(orphan)} was already gone — nothing needed ending.`;
}
