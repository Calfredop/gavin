// Which linked worktrees gavin has finished with, and how to say so.
//
// Forking a worktree per rail is cheap, so a workspace that has been
// running for a week accumulates a dozen sibling folders whose branches
// landed on main days ago. Sweeping them is the kind of chore a human
// only does when it has already gone wrong, which is why the answer is a
// button rather than advice.
//
// The whole risk of that button is deleting a folder someone still
// wanted, so the rule is deliberately conservative and stated once, here:
// a worktree is stale only when EVERY reason to keep it has been ruled
// out. Uncommitted work outranks the lot -- a fork whose branch merged
// last week can still be the only copy of an hour's edits, and no other
// fact about it makes those recoverable.
//
// Pure, because the reasons are the product. A verdict that cannot be
// read back ("kept: rail “auth” is bound to it") is a verdict the human
// has to take on trust, and the badge, the tooltip and the confirmation
// all have to be reading the same one.

import type { ConfirmCheck, ConfirmOptions } from "$lib/dialog";
import { splitPath, type StatusResult, type WorktreeInfo } from "$lib/git/git";
import { isGavinOwnPath } from "$lib/git/gitTracking";
import { count } from "$lib/railConfirm";

/// Why a worktree is being KEPT. Ordered by what is at stake, and that
/// order is the order they are tested in: the first one that holds is
/// the one the human is told about, so a fork that is dirty AND bound to
/// a rail reads "uncommitted changes" -- the fact that decides whether
/// anything is lost.
///
/// The first three are not really disqualifiers at all, they say the row
/// was never a candidate: the main checkout is the repo, a prunable one
/// has no folder left to remove (Prune is that button), and a locked one
/// is a worktree its owner explicitly asked git to refuse.
export type SweepBlocker =
  | "main"
  | "missing"
  | "locked"
  | "dirty"
  | "session"
  | "rail"
  | "detached"
  | "unmerged";

/// A rail's claim on a checkout: the name is carried so the reason can
/// say WHICH rail, which is the difference between a verdict and a
/// refusal.
export interface RailBinding {
  name: string;
  worktreePath: string;
}

/// Everything the classification needs that git, the rails and the
/// session store know and this module does not. Gathered by the caller
/// precisely so the rule itself stays testable without any of them.
export interface SweepFacts {
  /// The branch staleness is measured against -- the main worktree's
  /// branch. Named rather than assumed "main": a workspace whose trunk
  /// is `develop` must not be told its forks are unmerged.
  base: string;
  /// Local branch names fully merged into `base` (`git branch --merged`).
  merged: ReadonlySet<string>;
  /// Worktree paths whose `git status --porcelain` came back non-empty.
  /// A path ABSENT from this set is only clean if it was actually asked
  /// about — gitState's `sweepFacts` counts a checkout it could not read
  /// as dirty for exactly that reason.
  dirty: ReadonlySet<string>;
  /// Every rail in the workspace that is bound to a checkout.
  rails: readonly RailBinding[];
  /// The cwd of every session the app is holding.
  sessionCwds: readonly string[];
}

export interface SweepVerdict {
  path: string;
  branch: string | null;
  /// True when every reason to keep it has been ruled out.
  stale: boolean;
  /// The one phrase, either way: why it can go, or why it is staying.
  /// Shown in the confirmation's list and in the row's tooltip, so it
  /// reads as half a sentence rather than a heading.
  reason: string;
  /// Null exactly when `stale` is true.
  blocker: SweepBlocker | null;
}

/// Trailing slashes only: these paths come from `git worktree list`,
/// from a rail's binding and from a shell's OSC 7, and the three do not
/// agree about that one character. Nothing here resolves symlinks or
/// `..` -- that is the host's job, and guessing at it in the frontend
/// would be a second, wrong answer.
function normalize(path: string): string {
  return path.replace(/\/+$/, "");
}

function isInside(child: string, parent: string): boolean {
  const c = normalize(child);
  const p = normalize(parent);
  return c === p || c.startsWith(`${p}/`);
}

/// The worktree a path belongs to: the DEEPEST one containing it, not
/// the first. gavin's own forks are siblings (`../<repo>-<branch>`), but
/// the fork dialog takes any path the human types, and a worktree nested
/// inside the repo would otherwise hand every one of its sessions to the
/// main checkout -- which is the one row where the mistake is invisible,
/// because main is never swept anyway.
function owningWorktree(paths: readonly string[], child: string): string | null {
  let best: string | null = null;
  for (const path of paths) {
    if (!isInside(child, path)) continue;
    if (best === null || normalize(path).length > normalize(best).length) best = path;
  }
  return best;
}

function occupied(worktrees: readonly WorktreeInfo[], children: readonly string[]): Set<string> {
  const paths = worktrees.map((w) => w.path);
  const out = new Set<string>();
  for (const child of children) {
    const owner = owningWorktree(paths, child);
    if (owner !== null) out.add(normalize(owner));
  }
  return out;
}

function railsByWorktree(worktrees: readonly WorktreeInfo[], rails: readonly RailBinding[]): Map<string, string[]> {
  const paths = worktrees.map((w) => w.path);
  const out = new Map<string, string[]>();
  for (const rail of rails) {
    const owner = owningWorktree(paths, rail.worktreePath);
    if (owner === null) continue;
    const key = normalize(owner);
    out.set(key, [...(out.get(key) ?? []), rail.name]);
  }
  return out;
}

/// Every worktree, with the one reason that decides it. The full list
/// rather than only the stale ones: the switcher draws a badge per row
/// and wants the kept rows' reasons for their tooltips, and a rule whose
/// negative half is never rendered is a rule nobody can check.
export function classifyWorktrees(worktrees: readonly WorktreeInfo[], facts: SweepFacts): SweepVerdict[] {
  const busy = occupied(worktrees, facts.sessionCwds);
  const bound = railsByWorktree(worktrees, facts.rails);
  return worktrees.map((w) => {
    const path = normalize(w.path);
    const keep = (blocker: SweepBlocker, reason: string): SweepVerdict => ({
      path: w.path,
      branch: w.branch,
      stale: false,
      reason,
      blocker,
    });
    if (w.isMain) return keep("main", "the main checkout");
    if (w.prunable) return keep("missing", "the folder is gone — Prune clears it");
    if (w.locked) return keep("locked", "locked");
    // Before anything else that could look like permission: a dirty
    // worktree is never stale, whatever else is true of it.
    if (facts.dirty.has(path)) return keep("dirty", "uncommitted changes");
    if (busy.has(path)) return keep("session", "a session is open in it");
    const rails = bound.get(path);
    if (rails && rails.length > 0) {
      const which = rails.map((n) => `“${n}”`).join(", ");
      return keep("rail", `${rails.length === 1 ? "rail" : "rails"} ${which} bound to it`);
    }
    if (!w.branch) return keep("detached", "detached HEAD — no branch to compare");
    if (!facts.merged.has(w.branch)) return keep("unmerged", `${w.branch} is not merged into ${facts.base}`);
    return { path: w.path, branch: w.branch, stale: true, reason: `${w.branch} is merged into ${facts.base}`, blocker: null };
  });
}

export function staleWorktrees(worktrees: readonly WorktreeInfo[], facts: SweepFacts): SweepVerdict[] {
  return classifyWorktrees(worktrees, facts).filter((v) => v.stale);
}

/// One line per worktree in the confirmation: the folder the human will
/// see disappear, then the branch and why it qualified. The folder name
/// leads because that is what the sweep actually deletes.
function line(verdict: SweepVerdict): string {
  const name = splitPath(normalize(verdict.path)).name || verdict.path;
  return `${name} — ${verdict.reason}`;
}

/// Whether `git worktree remove` may be FORCED for this checkout: true
/// exactly when git still reports something and every bit of it is
/// gavin's own.
///
/// The sweep's removal is unforced on principle -- git refusing is what
/// stands between this button and an hour of someone's work -- but git
/// refuses on ANY untracked file, and every checkout of a gavin
/// workspace holds gavin's board: a symlink to the root checkout's copy
/// where a fleet of worktrees shares one, a folder of cards where it
/// does not. Once `dirty` stopped counting those (gitState's
/// `sweepFacts`), a row could classify stale and then fail at removal
/// with git's raw fatal -- a worse answer than the wrong verdict it
/// replaced.
///
/// So gavin keeps a last line of defence of its own, and a narrower one:
/// git's is "anything untracked", this is "anything untracked that is
/// not mine". Forcing past a link gavin made costs the link; forcing
/// past `src/half-done.ts` costs the work. One entry of the second kind
/// is enough to refuse -- there is no reading of the sweep under which
/// deleting it is what the human asked for.
///
/// A checkout git could not be read for answers false, the direction
/// `sweepFacts` takes for the same question. So does a CLEAN one: there
/// is nothing in the way, the unforced removal already succeeds, and a
/// `--force` handed out where it changes nothing is a habit rather than
/// a decision.
export function mayForceRemoval(status: StatusResult | null): boolean {
  if (!status) return false;
  const entries = [...status.staged, ...status.unstaged];
  return entries.length > 0 && entries.every((e) => isGavinOwnPath(e.path));
}

/// The label on the checkbox, which has to name what it deletes. One
/// branch is named outright; several are counted, because a prompt
/// listing eight branch names is a prompt nobody reads to the end.
export function deleteBranchesLabel(stale: readonly SweepVerdict[]): string {
  const branches = stale.map((v) => v.branch).filter((b): b is string => b !== null);
  if (branches.length === 1) return `Also delete the branch ${branches[0]}`;
  return `Also delete the ${branches.length} merged branches`;
}

/// The single question the sweep asks. Everything it will do is on
/// screen at once -- every folder by name, and the branches as a
/// checkbox -- because the alternative is a prompt per worktree, which
/// is the chore this button exists to remove.
///
/// `danger`, so the confirm button is red and Enter lands on the way
/// out rather than on the deletion.
export function sweepConfirm(
  stale: readonly SweepVerdict[],
  base: string
): ConfirmOptions & { check: ConfirmCheck } {
  return {
    title: `Remove ${count(stale.length, "stale worktree")}?`,
    lines: [
      ...stale.map(line),
      `Their folders are deleted. The commits stay reachable on ${base}.`,
    ],
    confirmLabel: `Remove ${count(stale.length, "worktree")}`,
    cancelLabel: "Keep them",
    danger: true,
    check: { label: deleteBranchesLabel(stale), default: true },
  };
}

/// What the sweep says when there is nothing to sweep. An action that
/// silently does nothing reads as broken, and this is the one message
/// that has to distinguish "gavin looked" from "gavin failed".
export function nothingToSweepLines(verdicts: readonly SweepVerdict[]): string[] {
  const kept = verdicts.filter((v) => !v.stale && v.blocker !== "main");
  if (kept.length === 0) return ["This repo has no linked worktrees."];
  return kept.map(line);
}
