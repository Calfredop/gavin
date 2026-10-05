// A workspace's Git tab, as a phone draws it: one pane at a time where
// the desk shows three columns.
//
// The state and every action are the desktop's own (`gitState.ts`): the
// same store, the same refresh, the same lock that keeps two git commands
// from running at once, and the same sentence when one fails. What this
// adds is only what a narrow screen decides differently -- which pane is
// up, how the sync buttons read with no room for a tooltip, which branch
// rows carry which buttons -- and it leaves out everything the desk keeps
// in its layout, which the Companion never saves.
import {
  changedCount,
  LIST_DISPLAY_CAP,
  splitPath,
  validateBranchName,
  type Area,
  type FileEntry,
  type FileStatus,
  type InProgressKind,
} from "$lib/git/git";
import {
  canSync,
  currentBranch,
  findEntry,
  pushLabel,
  runBlocker,
  type GitViewState,
} from "$lib/git/gitState";

export type GitScreen = "no-root" | "loading" | "git-missing" | "not-a-repo" | "ready";

/// Which of the tab's states the surface is in, in the desk's own order
/// (`GitHubView`): a view that has read nothing and failed at nothing yet
/// is still loading, and one whose read failed is drawn with its error.
export function gitScreen(rootPath: string | null | undefined, view: GitViewState | null): GitScreen {
  if (!rootPath) return "no-root";
  if (!view || (!view.repo && !view.gitMissing && !view.error)) return "loading";
  if (view.gitMissing) return "git-missing";
  if (view.repo?.notARepo) return "not-a-repo";
  return "ready";
}

/// The two panes a phone switches between. The desk's third column --
/// the diff -- is a page of its own here, opened from a file.
export type GitPane = "changes" | "branches";

/// Whether a git command may start now: nothing else running. The desk
/// disables every control on the same test.
export function gitLocked(view: GitViewState | null): boolean {
  return runBlocker(view) !== null;
}

export interface SyncButton {
  label: string;
  enabled: boolean;
  /// Commits it would move: behind for Pull, ahead for Push. Zero is
  /// drawn as nothing.
  count: number;
}

/// Fetch, Pull and Push, as the desk's toolbar decides them.
export function syncButtons(view: GitViewState): { fetch: SyncButton; pull: SyncButton; push: SyncButton } {
  const locked = gitLocked(view);
  const sync = canSync(view);
  const branch = currentBranch(view);
  return {
    fetch: { label: "Fetch", enabled: !locked && sync.fetch, count: 0 },
    pull: { label: "Pull", enabled: !locked && sync.pull, count: branch?.behind ?? 0 },
    push: { label: pushLabel(view), enabled: !locked && sync.push, count: branch?.ahead ?? 0 },
  };
}

/// Why syncing is not on offer, in words for a screen with no tooltips
/// -- and without the desk's "add one in the sidebar", which names a
/// place the phone does not have. Null when it is.
export function syncNote(view: GitViewState): string | null {
  if (!view.refs) return null;
  if (view.refs.remotes.length === 0) return "This repository has no remote to fetch from or push to.";
  if (view.repo?.detached) return "HEAD is detached: check out a branch to pull or push.";
  if (view.repo?.unborn) return "Nothing is committed yet: commit before you pull or push.";
  return null;
}

/// The branch the checkout is on, with where it stands against its
/// upstream: "main", "main · ↑1", "main · not published".
export function branchLine(view: GitViewState): string | null {
  const repo = view.repo;
  if (!repo || repo.notARepo) return null;
  const name = repo.branch ?? "HEAD";
  if (repo.detached) return `${name} · detached`;
  if (repo.unborn) return `${name} · no commits yet`;
  const branch = currentBranch(view);
  if (!branch) return name;
  const standing = tracking(branch.upstream, branch.ahead, branch.behind);
  return standing ? `${name} · ${standing}` : name;
}

function tracking(upstream: string | null, ahead: number, behind: number): string {
  if (!upstream) return "not published";
  const moves = [ahead > 0 ? `↑${ahead}` : "", behind > 0 ? `↓${behind}` : ""].filter(Boolean);
  return moves.join(" ");
}

const IN_PROGRESS_LABEL: Record<InProgressKind, string> = {
  merge: "Merge",
  rebase: "Rebase",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
};

export interface InProgressBanner {
  kind: InProgressKind;
  text: string;
  /// Offered for everything but a merge, which the commit box finishes.
  canContinue: boolean;
  /// Continuing waits for every conflict to be resolved.
  continueEnabled: boolean;
}

/// The banner over a merge, rebase, cherry-pick or revert that stopped
/// part-way -- the desk's words, so the two say the same thing.
export function inProgressBanner(view: GitViewState): InProgressBanner | null {
  const kind = view.repo?.inProgress ?? null;
  if (!kind) return null;
  const conflicts = conflicted(view).length;
  const finish = kind === "merge" ? "commit" : "continue";
  const text =
    conflicts > 0
      ? `${IN_PROGRESS_LABEL[kind]} in progress — ${conflicts} file${conflicts === 1 ? "" : "s"} conflicted; resolve ${conflicts === 1 ? "it" : "them"} and ${finish}`
      : `${IN_PROGRESS_LABEL[kind]} in progress — no conflicts left — ${finish} when ready`;
  return {
    kind,
    text,
    canContinue: kind !== "merge",
    continueEnabled: conflicts === 0 && !gitLocked(view),
  };
}

function conflicted(view: GitViewState): FileEntry[] {
  return view.status?.unstaged.filter((e) => e.status === "U") ?? [];
}

export interface ChangeSection {
  area: Area;
  title: string;
  /// The rows drawn, capped as the desk caps them.
  entries: FileEntry[];
  /// How many the cap left out.
  hidden: number;
  total: number;
  /// The section's bulk action, or null when it has nothing to act on.
  bulk: string | null;
  /// What an empty section says.
  empty: string;
}

export function changeSections(view: GitViewState): ChangeSection[] {
  const section = (area: Area, all: FileEntry[]): ChangeSection => ({
    area,
    title: area === "unstaged" ? "Unstaged" : "Staged",
    entries: all.slice(0, LIST_DISPLAY_CAP),
    hidden: Math.max(0, all.length - LIST_DISPLAY_CAP),
    total: all.length,
    bulk: all.length === 0 ? null : area === "unstaged" ? "Stage all" : "Unstage all",
    empty: area === "unstaged" ? "No unstaged changes" : "Nothing staged",
  });
  return [section("unstaged", view.status?.unstaged ?? []), section("staged", view.status?.staged ?? [])];
}

/// The count on the Changes pane's tab: files with any change, staged or
/// not, each once.
export function changesCount(view: GitViewState): number {
  return changedCount(view.status);
}

// ---- The diff page -------------------------------------------------------

/// The file whose diff is open, or null for the list. The desk's own
/// selection: a refresh that takes the file away (it was committed, or
/// discarded at the desk) takes the page with it.
export function openFile(view: GitViewState): FileEntry | null {
  return findEntry(view.status, view.selected);
}

const STATUS_WORD: Record<FileStatus, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  "?": "Untracked",
  U: "Conflicted",
};

export function statusWord(status: FileStatus): string {
  return STATUS_WORD[status];
}

export interface DiffHeading {
  name: string;
  dir: string;
  /// "Modified · not staged", "Added · staged".
  detail: string;
}

export function diffHeading(entry: FileEntry, area: Area): DiffHeading {
  const { dir, name } = splitPath(entry.path);
  return {
    name,
    dir: entry.oldPath ? `${entry.oldPath} → ${dir}` : dir,
    detail: `${statusWord(entry.status)} · ${area === "staged" ? "staged" : "not staged"}`,
  };
}

export type DiffBody = "loading" | "conflict" | "binary" | "too-large" | "empty" | "lines";

/// What the diff page shows under its heading. A conflicted file has no
/// diff: the desk's view loads its conflict instead.
export function diffBody(view: GitViewState, entry: FileEntry): DiffBody {
  if (entry.status === "U") return "conflict";
  const diff = view.diff;
  if (!diff) return "loading";
  if (diff.binary) return "binary";
  if (diff.tooLarge) return "too-large";
  if (diff.hunks.length === 0) return "empty";
  return "lines";
}

/// The page's one action on the whole file: stage what is not staged,
/// unstage what is. A conflicted file is marked resolved rather than
/// staged, which the desk's stage does too.
export function fileAction(entry: FileEntry, area: Area): string {
  if (entry.status === "U") return "Mark resolved";
  return area === "staged" ? "Unstage" : "Stage";
}

// ---- Branches ----------------------------------------------------------------

export interface BranchRow {
  name: string;
  current: boolean;
  subject: string;
  /// Where it stands against its upstream: "↑1", "↓2", "not published",
  /// or "" when in step.
  standing: string;
}

/// The local branches, the one checked out first.
export function localBranches(view: GitViewState): BranchRow[] {
  const rows = (view.refs?.branches ?? []).map((b) => ({
    name: b.name,
    current: b.current,
    subject: b.subject,
    standing: tracking(b.upstream, b.ahead, b.behind),
  }));
  return [...rows.filter((r) => r.current), ...rows.filter((r) => !r.current)];
}

export interface RemoteBranchRow {
  remote: string;
  name: string;
}

/// Branches a remote has that this repository has no local branch of.
/// Checking one out makes the local branch, tracking it -- the desk's
/// Remotes section, without the branches already here twice over.
export function remoteOnlyBranches(view: GitViewState): RemoteBranchRow[] {
  const local = new Set((view.refs?.branches ?? []).map((b) => b.name));
  return (view.refs?.remotes ?? []).flatMap((remote) =>
    remote.branches.filter((name) => name !== "HEAD" && !local.has(name)).map((name) => ({ remote: remote.name, name }))
  );
}

/// What stands in the way of a new branch by this name, or null. The
/// desk's own check first, then the one it leaves to git.
export function newBranchProblem(view: GitViewState, name: string): string | null {
  const invalid = validateBranchName(name);
  if (invalid) return invalid;
  if ((view.refs?.branches ?? []).some((b) => b.name === name)) return `A branch named ${name} already exists`;
  return null;
}

/// The question a merge asks first. A tap on a phone is easier to make
/// by accident than a click, and a merge commit is not one tap to undo.
export function mergeQuestion(view: GitViewState, branch: string): string {
  const into = view.repo?.branch ?? "HEAD";
  return `Merge ${branch} into ${into}?`;
}
