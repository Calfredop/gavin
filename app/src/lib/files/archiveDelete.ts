// The archive's Delete dropdown: which cards each age bucket claims,
// the menu that offers them, and the sentences the confirmation says
// out loud.
//
// Pure, like archive.ts beside it and for the same reason -- the grid is
// a projection, and the delete commits against paths through
// cardDelete.ts's existing plan/execute pair. Nothing here touches a
// store, so every rule below is a unit test rather than a click.
//
// Why a menu and not seven buttons: the buckets are a single question
// ("how far back?"), so they belong in one list the human opens, reads
// and closes. What the card's sketch did not have, and what a bare
// dropdown would still be missing, is the COUNT -- an archive is the one
// board surface nobody keeps in their head, so "Older than 30 days" with
// no number attached is a destructive pick made blind. Every row carries
// its own, and a row that would delete nothing is dark.

import type { ContextMenuEntry } from "$lib/core/contextMenu";
import type { Orchestration } from "$lib/orchestration/orchestration";
import type { CardView } from "$lib/core/planBoard";

const HOUR = 3600;
const DAY = 24 * HOUR;

/// One row of the age list: how far back it reaches, and what it says.
export interface AgeBucket {
  id: string;
  /// The row's words, before its count is appended.
  label: string;
  /// The cut-off, in seconds before now.
  seconds: number;
}

/// The buckets, in menu order -- shortest reach first, so the list runs
/// from the pick that takes the least to the one that takes the most and
/// the counts only ever grow as the eye travels down.
export const AGE_BUCKETS: readonly AgeBucket[] = [
  { id: "24h", label: "Older than 24 hours", seconds: DAY },
  { id: "3d", label: "Older than 3 days", seconds: 3 * DAY },
  { id: "7d", label: "Older than 7 days", seconds: 7 * DAY },
  { id: "15d", label: "Older than 15 days", seconds: 15 * DAY },
  { id: "30d", label: "Older than 30 days", seconds: 30 * DAY },
  { id: "90d", label: "Older than 90 days", seconds: 90 * DAY },
];

/// The archived cards last touched longer than `seconds` ago.
///
/// A card with NO mtime is never claimed -- the same call archive.ts's
/// `chronological` makes, and here it is not a matter of ordering: an
/// unknown date is not an old one, and a bulk delete that swept up the
/// cards it could not date would take exactly the rows whose age nobody
/// can check afterwards. They stay, and the confirmation says how many.
export function olderThan(cards: CardView[], seconds: number, nowMs: number): CardView[] {
  const cutoff = nowMs / 1000 - seconds;
  return cards.filter((c) => {
    const at = c.modifiedAt ?? null;
    return at !== null && at < cutoff;
  });
}

/// Archived cards whose file date could not be read, so nothing here can
/// place them on a timeline. Named rather than derived at each call site
/// because the confirmation has to account for them out loud.
export function undatedCards(cards: CardView[]): CardView[] {
  return cards.filter((c) => (c.modifiedAt ?? null) === null);
}

/// Every bucket paired with what it would take, so the menu can label
/// and disable each row from one pass.
export function bucketCards(
  cards: CardView[],
  nowMs: number
): Array<{ bucket: AgeBucket; cards: CardView[] }> {
  return AGE_BUCKETS.map((bucket) => ({ bucket, cards: olderThan(cards, bucket.seconds, nowMs) }));
}

/// What the button calls the list it opens.
export const ARCHIVE_DELETE_TITLE = "Delete from the archive";

/// The two states the picker row has. Separated out because the button's
/// tooltip says the same thing the row does, and one wording is one
/// place.
export function selectRowLabel(selectMode: boolean, selectedCount: number): string {
  if (!selectMode) return "Select cards to delete…";
  return selectedCount > 0 ? `Delete ${selectedCount} selected` : "Delete selected";
}

/// What the age rows are replaced by while a lens is on. Sweeping by age
/// over a filtered grid would take cards the human cannot see, which is
/// the rule a column's own Clear / Delete / Archive-all already follow
/// (KanbanColumn's FILTERED_TIP). Picking by hand is exempt for the same
/// reason: every card in a selection was clicked.
export const FILTERED_ROW = "Clear the search and filters to sweep by age";

export interface ArchiveDeleteHandlers {
  /// Whether the grid is currently in select mode.
  selectMode: boolean;
  selectedCount: number;
  /// True when the search box or a facet is holding archived cards back.
  filtered: boolean;
  /// Turn select mode on -- the picker row's job when it is off.
  onEnterSelectMode: () => void;
  onLeaveSelectMode: () => void;
  onDeleteSelected: () => void;
  onDeleteBucket: (bucket: AgeBucket, cards: CardView[]) => void;
}

/// The dropdown's entries, over the app's one context-menu layer -- the
/// same route NewPageButton takes, so viewport clamping, Escape and
/// click-away are already solved.
///
/// The heading leads because the button is an icon: the words the button
/// cannot afford live in the menu. The picker row comes first because it
/// is the only entry that does not delete anything on the spot -- an
/// exact pick should be reachable before the human reads a list of
/// sweeping ones.
export function archiveDeleteEntries(
  cards: CardView[],
  nowMs: number,
  h: ArchiveDeleteHandlers
): ContextMenuEntry[] {
  const entries: ContextMenuEntry[] = [{ heading: ARCHIVE_DELETE_TITLE }];
  if (h.selectMode) {
    entries.push({
      label: selectRowLabel(true, h.selectedCount),
      danger: h.selectedCount > 0,
      disabled: h.selectedCount === 0,
      onPick: h.onDeleteSelected,
    });
    // The way out lives in the menu that led in: select mode changes
    // what a plain click does, so leaving it must not depend on the
    // human finding the bar that appeared.
    entries.push({ label: "Leave select mode", onPick: h.onLeaveSelectMode });
  } else {
    entries.push({
      label: selectRowLabel(false, 0),
      disabled: cards.length === 0,
      onPick: h.onEnterSelectMode,
    });
  }
  entries.push({ separator: true });
  if (h.filtered) {
    // One dark row rather than six: a menu item carries no tooltip, so
    // the only place the reason fits is where the choices were.
    entries.push({ label: FILTERED_ROW, disabled: true, onPick: () => {} });
    return entries;
  }
  for (const { bucket, cards: matched } of bucketCards(cards, nowMs)) {
    entries.push({
      // The count is part of the label because a menu row has nowhere
      // else to put it.
      label: `${bucket.label} · ${matched.length}`,
      danger: matched.length > 0,
      disabled: matched.length === 0,
      onPick: () => h.onDeleteBucket(bucket, matched),
    });
  }
  return entries;
}

/// How many rail steps across this workspace's rails point at any of
/// these cards. Card steps only -- a tool step carries no card path.
export function railStepsFor(orch: Orchestration | null | undefined, cards: CardView[]): number {
  if (!orch) return 0;
  const paths = new Set(cards.map((c) => c.id));
  return orch.rails
    .flatMap((r) => r.stages)
    .flatMap((s) => s.steps)
    .filter((step) => step.cardPath !== "" && paths.has(step.cardPath)).length;
}

/// The prompt's title. `subject` names WHICH cards, in the words the
/// human just picked -- "older than 7 days" from a bucket row, "from the
/// archive" for a hand-made selection. A destructive prompt has to be
/// answerable from its title alone.
export function archivePurgeTitle(count: number, subject: string): string {
  return `Delete ${count} ${count === 1 ? "card" : "cards"} ${subject}?`;
}

/// A bucket's label as it reads mid-sentence: "Older than 7 days" is a
/// menu row, "older than 7 days" is the phrase a title can take.
export function bucketSubject(bucket: AgeBucket): string {
  return bucket.label.charAt(0).toLowerCase() + bucket.label.slice(1);
}

/// What a hand-made selection is called in that same slot.
export const SELECTION_SUBJECT = "from the archive";

export interface ArchivePurgeFacts {
  /// Cards the human picked -- what the count in the title is about.
  cards: number;
  /// Files that go: those cards plus every nested child travelling with
  /// its plan.
  files: number;
  /// Free-standing children elsewhere on the board that lose their
  /// `parent:` line.
  unparent: number;
  /// Steps on this workspace's rails aimed at any of the picked cards.
  railSteps: number;
  /// Picked cards that still hold a live agent session.
  boundSessions: number;
  /// Archived cards this pick could NOT date, and so left where they
  /// are. Zero for a selection, which the human made by hand.
  undated: number;
  /// featureBlockedReason for `cardPurge`: non-null when the running
  /// daemon deletes the file but keeps the rows.
  purgeBlocked: string | null;
}

/// What the confirmation spells out. Every line is a consequence the
/// human cannot see from the grid, and the order runs from the certain
/// (files) to the conditional (what a stale daemon will leave behind).
export function archivePurgeLines(facts: ArchivePurgeFacts): string[] {
  const lines: string[] = [
    `Deletes ${count(facts.cards, "archived card")} permanently — from disk, with no archive left to take ${plural(facts.cards, "it", "them")} back.`,
  ];
  const nested = facts.files - facts.cards;
  if (nested > 0) {
    lines.push(`${count(nested, "nested task")} inside ${plural(facts.cards, "it", "them")} ${plural(nested, "goes", "go")} too.`);
  }
  if (facts.unparent > 0) {
    lines.push(
      `${count(facts.unparent, "free-standing task")} on the board ${plural(facts.unparent, "keeps", "keep")} its column, un-parented.`
    );
  }
  if (facts.railSteps > 0) {
    // The gated sentence, and the reason `cardPurge` exists: against an
    // older daemon these steps survive a card that cannot come back, so
    // the prompt must not promise otherwise.
    lines.push(
      facts.purgeBlocked === null
        ? `${count(facts.railSteps, "rail step")} pointing at ${plural(facts.cards, "it", "them")} ${plural(facts.railSteps, "is", "are")} removed too.`
        : `${count(facts.railSteps, "rail step")} pointing at ${plural(facts.cards, "it", "them")} will STAY on ${plural(facts.railSteps, "its rail", "their rails")}, reading "card file is missing" with nothing left to restore — ${facts.purgeBlocked}`
    );
  }
  if (facts.boundSessions > 0) {
    lines.push(
      `${count(facts.boundSessions, "bound agent session")} ${plural(facts.boundSessions, "keeps", "keep")} running on the Agents page.`
    );
  }
  if (facts.undated > 0) {
    // Stated because it is the one thing the human asked for and is not
    // getting: a sweep by age cannot claim a card it could not date.
    lines.push(
      `${count(facts.undated, "archived card")} whose file date couldn't be read ${plural(facts.undated, "is", "are")} left alone.`
    );
  }
  return lines;
}

function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
