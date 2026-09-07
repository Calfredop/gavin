/// Git tracking of gavin's own files -- `.gavin-root/` and every `.gavin/`
/// context folder -- as the UI has to talk about it.
///
/// Two levels, and they are NOT the inherit-chain every other setting here
/// uses. The app-wide value is a default for INITIALISATION and nothing
/// else; a workspace that already exists carries its answer in its own
/// repo's `.gitignore`, which git reads and every other tool the human
/// owns reads too. So there is no per-workspace stored value to fall back
/// from, and nothing gavin holds that can drift out of step with the file.
/// `git::tracking` on the Rust side owns that half.
///
/// What lives here is the vocabulary: what the app default resolves to,
/// and the sentences the two panels and the confirm say. Pure, so the
/// `.svelte` surfaces stay templates over it.

/// The state git reports for one workspace root. Mirrors GavinTracking in
/// app/src-tauri/src/git/tracking.rs.
export interface GavinTracking {
  /// False when the root is not inside a git work tree. Every other field
  /// is then meaningless -- there is no ignore file worth writing.
  isRepo: boolean;
  /// True when no ignore rule excludes gavin's paths.
  tracked: boolean;
  /// The rule that excludes them, `source:line:pattern`, or null.
  ignoredBy: string | null;
  /// Whether gavin's own fenced block is what does the excluding.
  gavinManaged: boolean;
  /// How many of gavin's files are in the index right now. Ignoring a path
  /// does not untrack a file already committed, so this stays non-zero
  /// after an "off" until the human agrees to stage the removal.
  indexed: number;
}

/// What a workspace gets when nobody has chosen. On: gavin's files are the
/// project's plan -- the PRD leads development, the cards ARE the work --
/// and a plan that reaches only the machine that wrote it is the weaker
/// default. Turning it off stays one switch away.
export const DEFAULT_GIT_TRACKING = true;

/// A stored app-wide setting, or null for "nobody has chosen" -- which is
/// what both an absent value and an unusable one mean. Null rather than
/// the default so the panel can tell "chose on" from "never chose", and so
/// a later change to gavin's default reaches every install that never
/// expressed a preference.
export function normalizeGitTracking(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/// What a newly initialised workspace starts as: the app-wide choice, else
/// gavin's default. Expressed once so the two init prompts and the global
/// panel's "Default (on)" label can never disagree.
export function resolveGitTracking(appValue: unknown): boolean {
  return normalizeGitTracking(appValue) ?? DEFAULT_GIT_TRACKING;
}

/// Whether gavin can flip this workspace's switch at all.
///
/// It cannot when something OTHER than its own block does the ignoring: a
/// hand-written `.gitignore` line, a rule inherited from a parent repo, the
/// user's global excludes. Removing gavin's block would leave that rule
/// standing and the toggle would spring back, so the panel says whose rule
/// it is instead of pretending to act.
export function canToggleTracking(status: GavinTracking | null): boolean {
  if (!status || !status.isRepo) return false;
  return status.tracked || status.gavinManaged;
}

/// The sentence under the workspace switch. One line, and it always says
/// what git would do RIGHT NOW rather than what the switch means in
/// general -- the interesting cases are the ones where the two differ.
export function trackingSummary(status: GavinTracking | null): string {
  if (!status) return "Checking…";
  if (!status.isRepo) {
    return "This workspace's root is not a git repository, so there is nothing to track it with.";
  }
  if (status.tracked) {
    return status.indexed > 0
      ? `Committed with the project — ${status.indexed} ${status.indexed === 1 ? "file is" : "files are"} in git.`
      : "Gavin's files go into the repo like any other. Nothing is committed yet — stage them in the Git tab.";
  }
  if (!status.gavinManaged) {
    return `Ignored by a rule gavin did not write (${status.ignoredBy}). Take that rule out yourself to turn tracking back on.`;
  }
  return status.indexed > 0
    ? `Ignored by gavin's block in .gitignore, but ${status.indexed} ${status.indexed === 1 ? "file is" : "files are"} still in git — ignoring never untracks what is already committed.`
    : "Ignored by gavin's block in .gitignore. The files stay on disk and gavin keeps reading them.";
}

export interface ConfirmCopy {
  title: string;
  lines: string[];
  confirmLabel: string;
}

/// What to ask before turning tracking off in a repo that has already
/// committed some of gavin's files. Spelled out because the action stages
/// deletions in a checkout the human may be mid-commit in, and because the
/// one thing they will fear -- losing the cards -- is the one thing that
/// cannot happen.
export function untrackConfirm(indexed: number): ConfirmCopy {
  const files = `${indexed} ${indexed === 1 ? "file" : "files"}`;
  return {
    title: `Stop tracking gavin's files in git?`,
    lines: [
      `${files} under .gavin-root/ and .gavin/ are in this repo.`,
      "Adding an ignore rule does not untrack them, so gavin can stage their removal from git for you. Every file stays on disk and gavin keeps reading it.",
      "Nothing is committed — the removal shows up in the Git tab as a staged change, for you to review like any other.",
    ],
    confirmLabel: "Ignore and untrack",
  };
}

/// The tick-box beside an init prompt. One label, so the sidebar's prompt
/// and the Settings panel's cannot word the same question two ways.
export const INIT_TRACKING_LABEL = "Track gavin's files in git";
