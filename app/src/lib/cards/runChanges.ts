// What one card run changed, said in words. The pure half of the
// per-run Changes view: which baseline a run has (or why it has none),
// what a set of changes amounts to, and exactly what a discard is about
// to destroy. The store that fetches and the components that render sit
// on top of this (runChangesState.ts, RunChangesModal.svelte).
//
// The rule every string here follows: an ABSENT baseline is never
// reported as an empty diff. A run with no sha recorded is a run nobody
// measured, and saying "no changes" about one is the single most
// misleading thing this feature could do.

import type { CardSession } from "$lib/board/kanban";
import type { DiscardReport, FileEntry, RunChanges } from "$lib/git/git";
import { shortSha } from "$lib/git/git";
import { featureBlockedReason, type DaemonCompat } from "$lib/core/daemonCompat";

const MAX_LISTED = 8;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/// A run's baseline, or the reason it has none. A discriminated union
/// rather than a nullable sha because every surface needs both halves --
/// the button when there is one, the sentence when there is not, and
/// nothing at all is not an option here (see the module note).
export type RunBaseline =
  | { kind: "ready"; cwd: string; baseSha: string }
  | { kind: "none"; reason: string };

export function runBaseline(
  binding: CardSession | null | undefined,
  compat: DaemonCompat | null
): RunBaseline {
  if (!binding) {
    return { kind: "none", reason: "Nothing has run this card yet, so there is nothing to compare." };
  }
  if (binding.baseSha) {
    // The LAUNCH directory, never `cwd`: `cwd` follows the session's
    // OSC 7 reports and drifts the moment the agent moves into a
    // worktree, and a diff taken in the wrong checkout would be somebody
    // else's work.
    return { kind: "ready", cwd: binding.launchCwd ?? binding.cwd, baseSha: binding.baseSha };
  }
  const blocked = featureBlockedReason(compat, "runChanges");
  if (blocked) {
    return {
      kind: "none",
      reason: `Gavin couldn't record where this run started. ${blocked}`,
    };
  }
  return {
    kind: "none",
    reason:
      "Gavin didn't record where this run started — it was launched before this " +
      "was recorded, or in a folder that is not a git repository. Re-launching the card records one.",
  };
}

/// The one line a loaded set of changes reduces to: "7 files · +240 −18
/// · 2 commits". Null when there is nothing to say YET (still loading);
/// a state with an explanation goes through `changesProblem` instead.
export function changesSummary(changes: RunChanges | null): string | null {
  if (!changes) return null;
  if (changes.notARepo || changes.baseMissing) return null;
  if (changes.files.length === 0 && changes.commits === 0) return "No changes yet";
  const parts = [plural(changes.files.length, "file")];
  if (changes.added > 0 || changes.removed > 0) {
    // A minus sign, not a hyphen: this sits next to a plus and reads as
    // arithmetic.
    parts.push(`+${changes.added} −${changes.removed}`);
  }
  if (changes.commits > 0) parts.push(plural(changes.commits, "commit"));
  return parts.join(" · ");
}

/// Why this run's changes cannot be shown, in a sentence -- or null when
/// they can. Both cases are ordinary states of a checkout rather than
/// failures, which is why they are copy and not an error strip.
export function changesProblem(changes: RunChanges | null): string | null {
  if (!changes) return null;
  if (changes.notARepo) {
    return "This run's folder is not inside a git repository, so there is nothing to diff.";
  }
  if (changes.baseMissing) {
    return (
      `The commit this run started on (${shortSha(changes.baseSha)}) is not in this checkout any more — ` +
      `the branch was rewritten, or the run was launched somewhere else.`
    );
  }
  return null;
}

export function untrackedPaths(changes: RunChanges): string[] {
  return changes.files.filter((f) => f.status === "?").map((f) => f.path);
}

export function trackedFiles(changes: RunChanges): FileEntry[] {
  return changes.files.filter((f) => f.status !== "?");
}

/// Why "Discard this run" must not be offered, or null when it may be.
///
/// The live-agent case is first and is the important one: resetting a
/// checkout under a working agent destroys work nobody asked to touch,
/// and the agent carries on writing into a tree that moved beneath it.
/// `developCard` refuses on exactly the same evidence.
export function discardBlockedReason(
  changes: RunChanges | null,
  sessionIsLive: boolean
): string | null {
  if (sessionIsLive) {
    return "This card's agent is still running. Stop it first — resetting the checkout under a working agent destroys whatever it has not written yet.";
  }
  if (!changes) return "Load this run's changes first.";
  const problem = changesProblem(changes);
  if (problem) return problem;
  if (changes.files.length === 0 && changes.commits === 0) {
    return "This run hasn't changed anything, so there is nothing to discard.";
  }
  return null;
}

export interface DiscardPrompt {
  title: string;
  lines: string[];
  confirmLabel: string;
  /// Exactly the untracked paths the human is being shown -- handed
  /// straight to the backend, so nothing can be removed that this
  /// sentence did not name.
  untracked: string[];
}

/// The accounting a discard asks for. Every destructive clause is a line
/// of its own, and the commits and the new files are named separately
/// because they are recoverable in completely different ways: a dropped
/// commit is in the reflog, and a trashed file is in the Trash.
export function discardPrompt(changes: RunChanges, cardTitle: string): DiscardPrompt {
  const untracked = untrackedPaths(changes);
  const tracked = trackedFiles(changes);
  const lines: string[] = [
    `The checkout goes back to ${shortSha(changes.baseSha)}${
      changes.baseSubject ? ` (${changes.baseSubject})` : ""
    }.`,
  ];
  if (tracked.length > 0) {
    lines.push(`Edits to ${plural(tracked.length, "file")} are reverted.`);
  }
  if (changes.commits > 0) {
    lines.push(
      `${plural(changes.commits, "commit")} made since then ${
        changes.commits === 1 ? "comes" : "come"
      } off the branch — recoverable with \`git reflog\`, but not from gavin.`
    );
  }
  if (untracked.length > 0) {
    const shown = untracked.slice(0, MAX_LISTED);
    const rest = untracked.length - shown.length;
    lines.push(
      `${plural(untracked.length, "new file")} ${
        untracked.length === 1 ? "goes" : "go"
      } to the Trash: ${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}.`
    );
  }
  lines.push("Anything another run put in this checkout goes with it — the reset is the whole worktree, not this card's files.");
  return {
    title: `Discard everything this run did to ${cardTitle}?`,
    lines,
    confirmLabel: "Discard this run",
    untracked,
  };
}

/// What the discard actually achieved, for the strip afterwards. Null
/// when it did exactly what it said -- silence is the right report for a
/// clean success, and the view has already refreshed to show it.
export function discardOutcome(report: DiscardReport): string | null {
  if (report.failed.length === 0) return null;
  const first = report.failed
    .slice(0, MAX_LISTED)
    .map(([path, reason]) => `${path} (${reason})`)
    .join(", ");
  const rest = report.failed.length - Math.min(report.failed.length, MAX_LISTED);
  return (
    `The checkout was reset, but ${plural(report.failed.length, "file")} could not be moved to the Trash: ` +
    `${first}${rest > 0 ? `, and ${rest} more` : ""}.`
  );
}

/// The tab chip's tooltip. Short, and it names the baseline rather than
/// a count: the chip deliberately fetches nothing, because a count on a
/// tab is a git call per tab per render.
export function chipTooltip(baseSha: string): string {
  return `See what this run changed since ${shortSha(baseSha)}`;
}
