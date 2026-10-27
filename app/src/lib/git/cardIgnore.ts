// Keeping one card out of git: the card detail modal's Git row.
//
// The answer lives in git, not in the card -- an ignore rule in
// `.gitignore` or `.git/info/exclude` that app/src-tauri/src/git/card_ignore.rs
// writes and reads back with `git check-ignore`, the same rule
// gitTracking.ts keeps for the whole `.gavin-root/`. This module turns that
// reading into what the row shows and decides when the human is owed a
// question; the `.svelte` file stays a template over it.

import type { IgnoreKind } from "$lib/git/gitIgnore";

/// What git says about one card. Mirrors `CardIgnore` in card_ignore.rs.
export interface CardIgnore {
  /// False outside a git work tree; nothing else is then meaningful.
  isRepo: boolean;
  /// The rule gavin writes for this card: `/<context>/plans/**/<name>.md`,
  /// by file name so it survives the card's move into `plans/done/`.
  pattern: string;
  /// Which file holds gavin's rule for the card, or null when neither does.
  ruleIn: IgnoreKind | null;
  /// Whether git ignores the card right now, by any rule.
  ignored: boolean;
  /// The rule that decided, `source:line:pattern` -- an un-ignore (`!`)
  /// included -- or null when none matched.
  decidedBy: string | null;
  /// Whether that rule is gavin's own line for this card.
  decidedByGavin: boolean;
  /// Whether the card is in the index. Ignoring never untracks it.
  indexed: boolean;
}

/// The row's three positions.
export type CardGitChoice = "tracked" | IgnoreKind;

export const CARD_GIT_CHOICES: { value: CardGitChoice; label: string }[] = [
  { value: "tracked", label: "Tracked" },
  { value: "gitignore", label: "Ignored (.gitignore)" },
  { value: "exclude", label: "Excluded (this checkout only)" },
];

/// What the select shows. gavin's rule when there is one -- the position
/// the human last chose -- and "tracked" otherwise, including for a card
/// some other rule ignores: that rule is not a position of this row, and
/// `cardGitLocked` is what tells the human about it.
export function cardGitChoice(status: CardIgnore | null): CardGitChoice {
  return status?.ruleIn ?? "tracked";
}

/// Whether the row can act. Not outside a repo, and not while a rule gavin
/// did not write ignores the card with gavin's own line absent: every
/// position would leave that rule standing and the select would spring
/// back. (With gavin's line present the human can still switch files or
/// take it out -- the other rule is then said in the hint, not obeyed.)
export function cardGitLocked(status: CardIgnore | null): boolean {
  if (!status || !status.isRepo) return true;
  return status.ignored && !status.decidedByGavin && status.ruleIn === null;
}

/// The sentence beside the select: what git does with this card RIGHT
/// NOW, which is the interesting part when it differs from the choice.
export function cardGitSummary(status: CardIgnore | null): string {
  if (!status) return "Checking…";
  if (!status.isRepo) return "This workspace is not a git repository.";
  const stillIndexed = status.indexed
    ? " It is still in git — ignoring never untracks a committed file."
    : "";
  if (status.ignored && !status.decidedByGavin) {
    return status.ruleIn === null
      ? `Ignored by a rule gavin did not write (${status.decidedBy}). Take that rule out to track this card.${stillIndexed}`
      : `Ignored — also by a rule gavin did not write (${status.decidedBy}).${stillIndexed}`;
  }
  if (status.ignored) {
    return status.ruleIn === "exclude"
      ? `Kept out of git on this machine only (.git/info/exclude).${stillIndexed}`
      : `Kept out of git for everyone who clones (.gitignore).${stillIndexed}`;
  }
  if (status.ruleIn !== null) {
    // gavin's line is there and something overrides it -- a `!` rule.
    return `Gavin's rule is in place, but ${status.decidedBy ?? "another rule"} un-ignores this card.`;
  }
  return status.indexed
    ? "Committed with the project, like any other file."
    : "Not ignored — it will show in the Git tab like any other new file.";
}

/// Whether picking `choice` owes the human the untrack question first: an
/// ignore of a card that is already in the index. Moving gavin's rule from
/// one file to the other asks too while the card is still indexed -- the
/// last answer may have been "ignore only".
export function needsCardUntrackConfirm(status: CardIgnore | null, choice: CardGitChoice): boolean {
  return choice !== "tracked" && (status?.indexed ?? false);
}

/// The question. Its one fear -- losing the card -- is the thing that
/// cannot happen, so it is said. The untrack is a tick-box rather than a
/// second button, so dismissing the prompt is a plain Cancel and never
/// half an answer.
export function cardUntrackConfirm(choice: IgnoreKind): {
  title: string;
  lines: string[];
  confirmLabel: string;
  check: { label: string; default: boolean };
} {
  return {
    title: "This card is already committed",
    lines: [
      choice === "exclude"
        ? "Excluding it keeps it out of git on this machine, but the committed copy stays in the repo until it is untracked."
        : "Ignoring it keeps it out of git, but the committed copy stays in the repo until it is untracked.",
      "Untracking stages its removal from git. The file stays on disk and on the board; nothing is committed — the removal waits in the Git tab for you to review.",
    ],
    confirmLabel: choice === "exclude" ? "Exclude" : "Ignore",
    check: { label: "Also untrack it (stage the removal)", default: true },
  };
}
