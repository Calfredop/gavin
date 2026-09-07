// The Review tab's pure half: which cards are up for review, what each
// one touched, and how those cards cluster into the groups the left list
// draws. No Svelte, no Tauri, no I/O -- reviewState.ts fetches and
// ReviewHubView.svelte renders.
//
// The grouping is the reason this tab exists. A finished card on its own
// is a diff you have already agreed to; two finished cards that wrote to
// the same file are a question nobody asked, and the board cannot pose
// it because a column is ordered by when work started, not by what it
// touched. So cards are clustered by SHARED FILES: every card appears
// exactly once, in the company of the other cards its edits collide
// with.
//
// The one rule every string below follows, inherited from
// runChanges.ts: a card with no recorded baseline is never reported as a
// card that changed nothing. "Nobody measured this" and "this touched no
// files" are opposite answers, and collapsing them is the single most
// misleading thing this tab could do -- it would quietly promise that a
// card reviewed clean had been looked at.

import type { Column } from "./kanban";
import { doneColumnOf } from "./orchestration";
import { slugStatus, type CardView, type MergedProjection } from "./planBoard";
import { cardMatches } from "./boardSearch";
import { queryTokens } from "./search";

/// One card up for review, with what its run touched.
///
/// `files` is root-relative paths, or null for "no baseline recorded" --
/// the distinction the module note is about. An empty ARRAY is a real
/// answer: the run was measured and moved nothing.
export interface ReviewCandidate {
  card: CardView;
  files: string[] | null;
}

/// One cluster in the left list.
export interface ReviewGroup {
  /// Stable across refetches so an expanded group stays expanded: the
  /// cluster's files joined, or "" for the fileless group.
  id: string;
  /// Every file the cluster's cards touched, most-shared first -- the
  /// files that actually bind these cards together lead the header.
  files: string[];
  /// The header's words: two file names and a "+N", or the fileless
  /// group's sentence.
  label: string;
  cards: ReviewCandidate[];
}

/// The fileless group's id and words. Its own constant because three
/// places need to agree on it: the grouper, the ordering rule that pins
/// it last, and the test that says so.
export const NO_FILES_GROUP_ID = "";
export const NO_FILES_LABEL = "No files recorded";

/// How many file names a group header names before it starts counting.
const HEADER_FILES = 2;

// ---- Which columns feed the tab --------------------------------------------

/// The columns a workspace reviews, resolved against the board it has
/// right now.
///
/// `selected` is the human's own list of column ids (localStorage); null
/// means they have never chosen, and the answer is the done column --
/// the same `doneColumnOf` rule the rest of the app files work under, so
/// a board whose terminal column is "Shipped" reviews Shipped without
/// anyone configuring anything.
///
/// Ids that no longer name a column are dropped, and a selection that
/// drops to nothing falls back to the default rather than to an empty
/// tab: a column deleted somewhere else must not silently empty a
/// surface the human is standing in.
export function resolveReviewColumns(columns: Column[], selected: string[] | null): Column[] {
  const byId = new Map(columns.map((c) => [c.id, c]));
  const chosen = (selected ?? []).map((id) => byId.get(id)).filter((c): c is Column => c !== undefined);
  if (chosen.length > 0) {
    return [...chosen].sort((a, b) => a.position - b.position);
  }
  const done = doneColumnOf(columns);
  return done ? [done] : [];
}

/// The status slugs those columns stand for -- what an archived card's
/// own `status:` is matched against, since an archived card has no
/// column to sit in.
export function reviewStatusSlugs(columns: Column[]): Set<string> {
  return new Set(columns.map((c) => slugStatus(c.name)));
}

// ---- Which cards ------------------------------------------------------------

export interface ReviewCardOptions {
  /// Archived cards (`plans/archive/`) too. Off by default: the archive
  /// is deliberately off the board, and a review list that opened full
  /// of work taken off it would bury the work that is actually waiting.
  includeArchived: boolean;
  query: string;
}

/// The cards the tab lists, in board order, before grouping.
///
/// Notes are left out. The card asked for "tasks and plan", and a note
/// is right: it is a reminder, not work -- it has no run, no diff and no
/// session, so every column of this tab would be empty for it.
///
/// An archived card is matched by its own `status:` rather than by a
/// column, because it has none -- `mergePlanCards` pulls it out before
/// any column is filled, precisely so it does not land back on the
/// board. Matching on the status it was archived WITH is what makes the
/// toggle a filter over the same question rather than a second,
/// unrelated list.
export function reviewCards(
  merged: MergedProjection,
  reviewColumns: Column[],
  options: ReviewCardOptions
): CardView[] {
  const ids = new Set(reviewColumns.map((c) => c.id));
  const slugs = reviewStatusSlugs(reviewColumns);
  const cards: CardView[] = [];
  for (const display of merged.columns) {
    if (ids.has(display.column.id)) cards.push(...display.planCards);
  }
  if (options.includeArchived) {
    for (const card of merged.archived) {
      if (card.status !== null && slugs.has(slugStatus(card.status))) cards.push(card);
    }
  }
  const reviewable = cards.filter((c) => c.kind !== "note");
  const tokens = queryTokens(options.query);
  if (tokens.length === 0) return reviewable;
  return reviewable.filter((card) => cardMatches(card, tokens));
}

// ---- Grouping ---------------------------------------------------------------

/// Union-find over the candidates: two cards join when they share a
/// file, and joining is transitive, so A-B and B-C put all three in one
/// group even though A and C touched nothing in common. That is the
/// right answer for a review -- landing A means landing something C
/// would have to be read against.
function clusterIndexes(candidates: ReviewCandidate[]): Map<number, number[]> {
  const parent = candidates.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    // Path compression, so a long chain of unions does not turn every
    // later lookup into a walk.
    let walk = i;
    while (parent[walk] !== walk) {
      const next = parent[walk];
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  // One pass over the files rather than a comparison of every pair: the
  // first card to claim a file owns it, and every later claimant is
  // unioned into it.
  const owner = new Map<string, number>();
  candidates.forEach((candidate, i) => {
    for (const file of candidate.files ?? []) {
      const first = owner.get(file);
      if (first === undefined) owner.set(file, i);
      else union(first, i);
    }
  });

  const clusters = new Map<number, number[]>();
  candidates.forEach((_, i) => {
    const root = find(i);
    const list = clusters.get(root);
    if (list) list.push(i);
    else clusters.set(root, [i]);
  });
  return clusters;
}

/// The cluster's files, most-shared first and alphabetical within a
/// tie. The files several of these cards wrote to are the reason the
/// cluster exists, so they are what the header should name.
function rankFiles(cards: ReviewCandidate[]): string[] {
  const counts = new Map<string, number>();
  for (const candidate of cards) {
    for (const file of candidate.files ?? []) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([file]) => file);
}

/// A path's last segment. Headers name files, not paths: two columns of
/// `app/src/lib/` in front of every name is the part that is the same
/// for every group.
export function fileLabel(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? path : path.slice(at + 1);
}

/// A group's header: up to two file names, then how many more there are.
export function groupLabel(files: string[]): string {
  if (files.length === 0) return NO_FILES_LABEL;
  const named = files.slice(0, HEADER_FILES).map(fileLabel);
  const rest = files.length - named.length;
  return rest > 0 ? `${named.join(", ")} +${rest}` : named.join(", ");
}

/// The left list, grouped.
///
/// Groups are ordered by how many cards they hold (the busiest file
/// neighbourhood is the one worth reading first), then by label so the
/// order does not shuffle between two equal groups on every refetch. The
/// fileless group is pinned last however big it is: it is the group
/// whose cards this tab can say the least about.
///
/// Cards keep the order they arrived in, which is the board's.
export function groupCandidates(candidates: ReviewCandidate[]): ReviewGroup[] {
  const withFiles: ReviewCandidate[] = [];
  const withoutFiles: ReviewCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.files && candidate.files.length > 0) withFiles.push(candidate);
    else withoutFiles.push(candidate);
  }

  const groups: ReviewGroup[] = [];
  for (const indexes of clusterIndexes(withFiles).values()) {
    const cards = indexes.sort((a, b) => a - b).map((i) => withFiles[i]);
    const files = rankFiles(cards);
    groups.push({ id: files.join("\n"), files, label: groupLabel(files), cards });
  }
  groups.sort((a, b) => b.cards.length - a.cards.length || a.label.localeCompare(b.label));

  if (withoutFiles.length > 0) {
    groups.push({
      id: NO_FILES_GROUP_ID,
      files: [],
      label: NO_FILES_LABEL,
      cards: withoutFiles,
    });
  }
  return groups;
}

/// What the list says under a group with no baseline behind it. A
/// sentence rather than a count, because the count would be a lie of the
/// exact kind this module exists to avoid.
export const NO_FILES_HINT =
  "Gavin didn't record where these runs started, so it can't say what they touched.";

/// The one line the tab's header reduces to. Null when there is nothing
/// to say yet.
export function reviewSummary(groups: ReviewGroup[]): string | null {
  const cards = groups.reduce((n, g) => n + g.cards.length, 0);
  if (cards === 0) return null;
  const clusters = groups.filter((g) => g.id !== NO_FILES_GROUP_ID).length;
  const parts = [`${cards} card${cards === 1 ? "" : "s"}`];
  if (clusters > 0) parts.push(`${clusters} group${clusters === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/// The card a selection should land on after the list changed under it:
/// the one that was selected when it is still listed, otherwise the
/// first card of the first group, otherwise nothing.
///
/// Called on every list change rather than only on the first render.
/// The list is re-derived when the query changes, when the archive
/// toggle flips and when the touched files arrive -- and a selection
/// pointing at a card the list no longer holds renders three empty
/// columns beside a list that has plenty in it.
export function resolveSelection(groups: ReviewGroup[], selected: string | null): string | null {
  const paths = new Set(groups.flatMap((g) => g.cards.map((c) => c.card.id)));
  if (selected && paths.has(selected)) return selected;
  return groups[0]?.cards[0]?.card.id ?? null;
}
