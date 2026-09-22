// The Review tab's pure half: which cards are up for review, which rails
// sit beside them as subjects, what each one touched, and how those
// cards cluster into the groups the left list draws. No Svelte, no
// Tauri, no I/O -- reviewState.ts fetches and ReviewHubView.svelte
// renders.
//
// The grouping is the reason this tab exists. A finished card on its own
// is a diff you have already agreed to; two finished cards that wrote to
// the same file are a question nobody asked, and the board cannot pose
// it because a column is ordered by when work started, not by what it
// touched. So cards are clustered by SHARED FILES: every card appears
// exactly once, in the company of the other cards its edits collide
// with. Rails are first-class subjects in the same list, but they do
// not join that clustering -- a rail is one checkout/branch as a whole.
//
// The one rule every string below follows, inherited from
// runChanges.ts: a card with no recorded baseline is never reported as a
// card that changed nothing. "Nobody measured this" and "this touched no
// files" are opposite answers, and collapsing them is the single most
// misleading thing this tab could do -- it would quietly promise that a
// card reviewed clean had been looked at.

import type { Column } from "$lib/board/kanban";
import { doneColumnOf, type Rail } from "$lib/orchestration/orchestration";
import { slugStatus, type CardView, type MergedProjection } from "$lib/core/planBoard";
import { cardMatches } from "$lib/board/boardSearch";
import { matchesFields, queryTokens } from "$lib/core/search";
import { cardPasses, type BoardFacets } from "$lib/board/boardFilters";
import { facetMatches, NO_RAIL, type RailIndex } from "$lib/board/planFilter";
import { earliestStepBaseSha } from "$lib/review/criticalReview";

/// One card up for review, with what its run touched.
///
/// `files` is root-relative paths, or null for "no baseline recorded" --
/// the distinction the module note is about. An empty ARRAY is a real
/// answer: the run was measured and moved nothing.
export interface ReviewCandidate {
  card: CardView;
  files: string[] | null;
  /// The checkout the files were measured in -- the repository root, so
  /// two cards launched at different depths of one tree still meet.
  ///
  /// A file is only the same file as another card's when both were
  /// measured HERE. The path alone is not identity: `app/src/lib/git.ts`
  /// in this tree and in a sibling worktree are two files on two
  /// branches, and treating them as one put every card in every checkout
  /// -- and in unrelated repositories -- into a single group.
  checkout: string | null;
  /// The baseline the files were measured from. Two cards that share one
  /// share their whole measurement; see `sameBaselineHint`.
  baseSha: string | null;
  /// Which card each of this run's files looks like, for the files
  /// TypeSafe change attribution placed confidently (root-relative path
  /// -> card id; `changeAttribution.ts`). A card CLAIMS a file for the
  /// clustering only when nobody else was named for it, so two cards
  /// that were measured identically stop colliding on the files that
  /// are plainly one of theirs. Absent or empty is today's reading:
  /// every listed file is claimed. Never read by anything that decides
  /// what a card touched -- `files` stays the whole measured list.
  owners?: ReadonlyMap<string, string>;
}

/// One cluster in the left list.
export interface ReviewGroup {
  /// Stable across refetches so an expanded group stays expanded: a
  /// digest of the checkout and the cluster's files, or "" for the
  /// fileless group. Short because it is written down -- see `digest`.
  id: string;
  /// Every file the cluster's cards touched, most-shared first -- the
  /// files that actually bind these cards together lead the header.
  files: string[];
  /// The header's words: two file names and a "+N", or the fileless
  /// group's sentence.
  label: string;
  /// The sentence drawn under an open header, or null for a group whose
  /// files say everything there is to say. Decided here rather than in
  /// the list, so what a group means and what it is called cannot drift
  /// apart.
  hint: string | null;
  /// How many of the files these cards list were taken out of the
  /// clustering because attribution placed them with one card. Zero
  /// without attribution, and then the group is exactly today's.
  setAside: number;
  cards: ReviewCandidate[];
}

/// The fileless group's id and words. Its own constant because three
/// places need to agree on it: the grouper, the ordering rule that pins
/// it last, and the test that says so.
///
/// The label says what the LIST cannot do -- show you files -- and
/// deliberately not why, because the group holds both of this module's
/// two opposite answers: a run nobody measured, and a run measured to
/// have moved nothing. A header naming the first would tell the second
/// as the first, which is the conflation this file exists to avoid, and
/// it would contradict the "0 files" the card's own row already carries.
/// `noFilesHint` is where the difference is spelled.
export const NO_FILES_GROUP_ID = "";
export const NO_FILES_LABEL = "No files to show";

/// What a group is called when its cards were all launched from the same
/// commit in the same checkout.
///
/// Such cards were measured against one baseline in one tree, so they
/// have the SAME file list -- not because they touched the same files,
/// but because gavin took one measurement and handed it to each of them.
/// Naming files here would report an agreement no one observed, and it
/// is the reading that made every card on a shared checkout look like it
/// had touched the whole tree.
export const SAME_BASELINE_LABEL = "Same starting point";

/// How many file names a group header names before it starts counting.
const HEADER_FILES = 2;

/// How many group ids the tab remembers the open state of.
///
/// A group's identity is its file set, which moves whenever anything in
/// the fleet writes, so ids retire constantly and a list that only ever
/// grew would be a slow leak in localStorage. Bounded most-recent-first
/// instead of pruned against the groups on screen: the search box
/// narrows the list, and pruning would quietly forget every group the
/// query happens to hide.
export const MAX_REMEMBERED_GROUPS = 64;

/// A 32-bit FNV-1a, twice with different offsets, as 16 hex characters.
///
/// Not for security -- for length. A group's id has to survive being
/// written down (`reviewPrefs.expandedGroups`), and spelling it out
/// would put every path in the cluster into localStorage: the group this
/// module was fixed for holds 230 of them.
function digest(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x85ebca6b);
  }
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, "0");
  return hex(a) + hex(b);
}

/// Every baseline recorded against the same checkout, attached to each
/// request -- what bounds a run's window to its own slice
/// (`next_baseline` in `runchanges.rs`).
///
/// Grouped by the launch cwd and not by the repository root, which only
/// git can resolve: a sibling worktree shares the object store, so its
/// baselines are reachable here and would bound a window they have
/// nothing to do with. Same cwd is the conservative reading, and the one
/// that matches how a run is launched.
///
/// Sorted and deduped so the same board asks the same question twice --
/// the peer list is part of the cache key, and an order that followed
/// the board's would re-fetch every card on every reorder.
export function withBaselinePeers<T extends { cwd: string; baseSha: string }>(
  requests: T[]
): (T & { peers: string[] })[] {
  const byCheckout = new Map<string, Set<string>>();
  for (const request of requests) {
    const seen = byCheckout.get(request.cwd);
    if (seen) seen.add(request.baseSha);
    else byCheckout.set(request.cwd, new Set([request.baseSha]));
  }
  const peers = new Map(
    [...byCheckout].map(([cwd, shas]) => [cwd, [...shas].sort()] as const)
  );
  return requests.map((request) => ({ ...request, peers: peers.get(request.cwd) ?? [] }));
}

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
  /// The context/kind/rail trio Kanban and Plans answer the same way
  /// (boardFilters.ts, shared across tabs by hubFacets.ts).
  facets: BoardFacets;
  rails: RailIndex;
}

/// The cards the tab lists, in board order, before grouping.
///
/// Notes are left out. The card asked for "tasks and plan", and a note
/// is right: it is a reminder, not work -- it has no run, no diff and no
/// session, so every column of this tab would be empty for it. A kind
/// facet set to "note" is therefore an honest empty list here, not a
/// bug: the same three dropdowns answer a question this tab can only
/// ever answer "none" to.
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
  const reviewable = cards.filter((c) => c.kind !== "note" && cardPasses(c, options.facets, options.rails));
  const tokens = queryTokens(options.query);
  if (tokens.length === 0) return reviewable;
  return reviewable.filter((card) => cardMatches(card, tokens));
}

// ---- Rails as subjects ------------------------------------------------------

/// Selection ids for rails. Card ids are absolute paths; rail ids are
/// short and could collide with a future path spelling, so every rail
/// subject is namespaced. The hub and the store both key on this string.
export const RAIL_SUBJECT_PREFIX = "rail:";

export function railSubjectId(railId: string): string {
  return `${RAIL_SUBJECT_PREFIX}${railId}`;
}

export function isRailSubjectId(id: string): boolean {
  return id.startsWith(RAIL_SUBJECT_PREFIX);
}

export function railIdFromSubject(id: string): string | null {
  return isRailSubjectId(id) ? id.slice(RAIL_SUBJECT_PREFIX.length) : null;
}

/// One rail up for review, with what its combined checkout touched.
///
/// Rails sit in the SAME list as cards — not behind a Cards|Rails
/// switcher. They do not join card file-clustering: a rail is one
/// subject (its worktree/branch as a whole), and folding it into a
/// shared-file group would report card collisions the rail never
/// participated in. `groupCandidates` stays card-only.
export interface ReviewRailCandidate {
  /// `railSubjectId(railId)` — what selection and the store key on.
  id: string;
  railId: string;
  name: string;
  worktreePath: string | null;
  branch: string | null;
  files: string[] | null;
  checkout: string | null;
  baseSha: string | null;
  /// Inputs the Critical-review dialog needs when this row is selected.
  worktreeForkPoint: string | null;
  stepBaseShas: (string | null)[];
}

/// Baseline for a rail-as-subject diff: worktree fork point, else the
/// earliest step baseSha in step order. Null when neither is known —
/// the tab then reports the rail as unmeasured, the same way a card
/// with no binding is. Never a trunk branch name: `git_run_changes`
/// needs a commit, and the dialog's free-text default is a different
/// question.
export function railReviewBaseline(options: {
  worktreeForkPoint?: string | null;
  stepBaseShas?: readonly (string | null | undefined)[];
}): string | null {
  const fork = options.worktreeForkPoint?.trim();
  if (fork) return fork;
  return earliestStepBaseSha(options.stepBaseShas ?? []);
}

export interface ReviewRailOptions {
  query: string;
  /// Only the rail facet applies: a rail is not a card, so kind /
  /// context / label have nothing honest to say about it. Empty rail
  /// facet = every rail.
  facets: BoardFacets;
}

/// Whether this rail passes the shared rail facet. `NO_RAIL` never
/// matches a rail — that option means unplaced cards.
function railPassesFacet(railId: string, facets: BoardFacets): boolean {
  return facetMatches(facets.rail, facets.exclude.rail, (v) => (v === NO_RAIL ? false : v === railId));
}

/// The rails the tab lists, in rail position order — peers of
/// `reviewCards`, not a second mode.
export function reviewRails(rails: readonly Rail[], options: ReviewRailOptions): Rail[] {
  const tokens = queryTokens(options.query);
  const listed = [...rails]
    .filter((rail) => railPassesFacet(rail.id, options.facets))
    .sort((a, b) => a.position - b.position);
  if (tokens.length === 0) return listed;
  return listed.filter((rail) =>
    matchesFields(tokens, [rail.name, rail.branch ?? null, rail.worktreePath])
  );
}

/// Build a list row from a rail and whatever the store has measured.
export function railCandidate(
  rail: Pick<Rail, "id" | "name" | "worktreePath"> & { branch?: string | null },
  measured: {
    files: string[] | null;
    checkout: string | null;
    baseSha: string | null;
    worktreeForkPoint?: string | null;
    stepBaseShas?: readonly (string | null)[];
  } = { files: null, checkout: null, baseSha: null }
): ReviewRailCandidate {
  const stepBaseShas = [...(measured.stepBaseShas ?? [])];
  const worktreeForkPoint = measured.worktreeForkPoint?.trim() || null;
  return {
    id: railSubjectId(rail.id),
    railId: rail.id,
    name: rail.name,
    worktreePath: rail.worktreePath,
    branch: rail.branch ?? null,
    files: measured.files,
    checkout: measured.checkout,
    baseSha: measured.baseSha,
    worktreeForkPoint,
    stepBaseShas,
  };
}

/// What "Critical review…" from the current selection should open.
/// Null when nothing is selected — the hub hides the action then.
export type ReviewCriticalOffer =
  | { kind: "card"; cardPath: string }
  | {
      kind: "rail";
      railId: string;
      worktreeForkPoint: string | null;
      stepBaseShas: readonly (string | null)[];
    };

export function criticalReviewOffer(
  selected: string | null,
  rails: readonly ReviewRailCandidate[],
  cardPaths: ReadonlySet<string> | readonly string[]
): ReviewCriticalOffer | null {
  if (!selected) return null;
  const railId = railIdFromSubject(selected);
  if (railId !== null) {
    const rail = rails.find((r) => r.railId === railId);
    if (!rail) return null;
    return {
      kind: "rail",
      railId: rail.railId,
      worktreeForkPoint: rail.worktreeForkPoint,
      stepBaseShas: rail.stepBaseShas,
    };
  }
  const paths = cardPaths instanceof Set ? cardPaths : new Set(cardPaths);
  if (!paths.has(selected)) return null;
  return { kind: "card", cardPath: selected };
}

// ---- Grouping ---------------------------------------------------------------

/// The files this card claims for the clustering: everything it lists,
/// minus the files attribution placed with another card. Without an
/// `owners` map it is the list itself.
function claimedFiles(candidate: ReviewCandidate): string[] {
  const files = candidate.files ?? [];
  const owners = candidate.owners;
  if (!owners || owners.size === 0) return [...files];
  return files.filter((file) => {
    const owner = owners.get(file);
    return owner === undefined || owner === candidate.card.id;
  });
}

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
  //
  // Keyed by CHECKOUT and path together. A bare path is not a file: the
  // same one in two worktrees is two branches' worth of edits that have
  // not met, and in two repositories it is a coincidence of naming. Both
  // used to chain -- a `README.md` was enough to put an unrelated
  // project's cards in this one's group.
  const owner = new Map<string, number>();
  candidates.forEach((candidate, i) => {
    for (const file of claimedFiles(candidate)) {
      const key = `${candidate.checkout ?? ""}\0${file}`;
      const first = owner.get(key);
      if (first === undefined) owner.set(key, i);
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
function rankFiles(
  cards: ReviewCandidate[],
  filesOf: (candidate: ReviewCandidate) => readonly string[]
): string[] {
  const counts = new Map<string, number>();
  for (const candidate of cards) {
    for (const file of filesOf(candidate)) {
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
    const claimedBy = new Map(cards.map((c) => [c, new Set(claimedFiles(c))] as const));
    const claimed = rankFiles(cards, (c) => [...(claimedBy.get(c) ?? [])]);
    const listed = rankFiles(cards, (c) => c.files ?? []);
    // What attribution took out of the clustering: a file some card here
    // lists and does not claim. Zero without attribution, and then
    // everything below is exactly today's grouping.
    const setAside = listed.filter((file) =>
      cards.some((c) => (c.files ?? []).includes(file) && !claimedBy.get(c)?.has(file))
    ).length;
    // ...and what still holds the group together: a file two or more of
    // its cards claim.
    const binding = claimed.filter(
      (file) => cards.filter((c) => claimedBy.get(c)?.has(file)).length >= 2
    ).length;
    // The header names the files that bind the group. A card whose every
    // file was placed with somebody else claims nothing, and its header
    // still names what it lists: the list is a hint, never a filter, and
    // the card's own row already says how many files it has.
    const files = claimed.length > 0 ? claimed : listed;
    const shared = sharesOneBaseline(cards);
    groups.push({
      // The checkout is in the id for the same reason it keys the
      // clustering: two worktrees with the same files are two groups,
      // and one id for both would fold and unfold them together. Two
      // cards that claim nothing and list the same files would share an
      // id too, so the card ids keep those apart -- and only those, so
      // every id a board had before attribution stays what it was.
      id: digest(
        `${cards[0].checkout ?? ""}\n${files.join("\n")}${
          claimed.length === 0 ? `\n${cards.map((c) => c.card.id).join("\n")}` : ""
        }`
      ),
      files,
      label: shared ? SAME_BASELINE_LABEL : groupLabel(files),
      hint: groupHint(cards, shared, setAside, listed.length, binding),
      setAside,
      cards,
    });
  }
  groups.sort((a, b) => b.cards.length - a.cards.length || a.label.localeCompare(b.label));

  if (withoutFiles.length > 0) {
    groups.push({
      id: NO_FILES_GROUP_ID,
      files: [],
      label: NO_FILES_LABEL,
      hint: noFilesHint(withoutFiles),
      setAside: 0,
      cards: withoutFiles,
    });
  }
  return groups;
}

/// Whether every card here was launched from one commit in one checkout
/// -- which makes their file lists one measurement rather than an
/// agreement between several.
///
/// One card is never this: a lone card's files are its own, however they
/// were measured, and there is nothing for it to be indistinguishable
/// from.
function sharesOneBaseline(cards: ReviewCandidate[]): boolean {
  if (cards.length < 2) return false;
  const { checkout, baseSha } = cards[0];
  if (baseSha === null) return false;
  return cards.every((c) => c.baseSha === baseSha && c.checkout === checkout);
}

/// What the list says under a group whose cards all started from one
/// commit. It has to name the limit rather than the files, because the
/// files are the same for all of them by construction -- saying "these
/// cards touched git.ts" of a measurement nobody attributed is the
/// review-tab equivalent of reporting an unmeasured run as an empty one.
export function sameBaselineHint(cards: ReviewCandidate[]): string {
  return (
    `These ${cards.length} cards were launched from the same commit in the same checkout, ` +
    `so gavin measured one set of changes and it belongs to all of them. ` +
    `It can't say which card made what.`
  );
}

/// The sentence under a group where attribution placed some of the files
/// with one card. Numbers rather than names, because the names are on
/// the rows: what the reader needs here is why two cards that list the
/// same files are not in one group -- or why they still are.
///
/// `listed` is every distinct file the group's cards list, `setAside`
/// how many of those were placed with one card and taken out of the
/// clustering, and `binding` how many are still claimed by two or more
/// cards. A lone card gets the singular reading: its files look like
/// somebody else's, and that is why it sits by itself.
export function attributionHint(
  cards: number,
  setAside: number,
  listed: number,
  binding: number
): string {
  if (cards === 1) {
    if (setAside === listed) {
      return listed === 1
        ? "The one file this card lists looks like another card's work, so it was not counted as a collision."
        : `All ${listed} files this card lists look like another card's work, so none of them was counted as a collision.`;
    }
    return setAside === 1
      ? `1 of the ${listed} files this card lists looks like another card's work, so it was not counted as a collision.`
      : `${setAside} of the ${listed} files this card lists look like another card's work, so they were not counted as collisions.`;
  }
  return (
    `TypeSafe placed ${setAside} of the ${listed} files these cards list with one card each, ` +
    `so those were not counted as collisions; the ${binding} it could not place still ` +
    `${binding === 1 ? "binds" : "bind"} the group.`
  );
}

/// What a cluster's header says underneath: the same-baseline sentence
/// where it applies, the attribution sentence where files were placed,
/// both where both, and nothing where neither -- the files say it all.
function groupHint(
  cards: ReviewCandidate[],
  shared: boolean,
  setAside: number,
  listed: number,
  binding: number
): string | null {
  const base = shared ? sameBaselineHint(cards) : null;
  if (setAside === 0) return base;
  const placed = attributionHint(cards.length, setAside, listed, binding);
  return base ? `${base} ${placed}` : placed;
}

/// What the list says under a group with no baseline behind it. A
/// sentence rather than a count, because the count would be a lie of the
/// exact kind this module exists to avoid.
export const NO_FILES_HINT =
  "Gavin didn't record where these runs started, so it can't say what they touched.";

/// ...and what it says under a group whose runs WERE measured. One
/// bucket holds both, because neither has files to cluster on, but they
/// are opposite answers and the hint under the header is the one place
/// with room to say which.
export const MEASURED_EMPTY_HINT = "These runs were measured: they changed nothing in the checkout.";

/// The hint the fileless group actually draws.
///
/// Only the sentences that are TRUE of the cards in front of the reader.
/// A group of measured-empty runs used to be told "gavin didn't record
/// where these runs started" while every row under it said "0 files" --
/// the header and the rows contradicting each other about the one
/// distinction this module is built around.
export function noFilesHint(cards: ReviewCandidate[]): string {
  const unmeasured = cards.some((c) => c.files === null);
  const measured = cards.some((c) => c.files !== null);
  if (unmeasured && measured) return `${NO_FILES_HINT} ${MEASURED_EMPTY_HINT}`;
  return unmeasured ? NO_FILES_HINT : MEASURED_EMPTY_HINT;
}

/// The one line the tab's header reduces to. Null when there is nothing
/// to say yet. Rails count beside cards — same list, one summary.
export function reviewSummary(
  groups: ReviewGroup[],
  rails: readonly ReviewRailCandidate[] = []
): string | null {
  const cards = groups.reduce((n, g) => n + g.cards.length, 0);
  const railCount = rails.length;
  if (cards === 0 && railCount === 0) return null;
  const parts: string[] = [];
  if (railCount > 0) parts.push(`${railCount} rail${railCount === 1 ? "" : "s"}`);
  if (cards > 0) parts.push(`${cards} card${cards === 1 ? "" : "s"}`);
  const clusters = groups.filter((g) => g.id !== NO_FILES_GROUP_ID).length;
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
///
/// Card-only. Prefer `resolveReviewSelection` once rails are in the
/// list — this stays for callers and tests that only hold card groups.
export function resolveSelection(groups: ReviewGroup[], selected: string | null): string | null {
  const paths = new Set(groups.flatMap((g) => g.cards.map((c) => c.card.id)));
  if (selected && paths.has(selected)) return selected;
  return groups[0]?.cards[0]?.card.id ?? null;
}

/// Selection across rails and card groups in one list. Keeps a still-
/// listed choice; otherwise the first rail, else the first card.
///
/// Rails lead the fallback so a workspace that only has rails (or whose
/// card filters emptied the card half) still has a subject, and so the
/// list does not jump past every rail to land on a card.
export function resolveReviewSelection(
  groups: ReviewGroup[],
  rails: readonly ReviewRailCandidate[],
  selected: string | null
): string | null {
  const railIds = new Set(rails.map((r) => r.id));
  if (selected && railIds.has(selected)) return selected;
  const cardPaths = new Set(groups.flatMap((g) => g.cards.map((c) => c.card.id)));
  if (selected && cardPaths.has(selected)) return selected;
  if (rails[0]) return rails[0].id;
  return groups[0]?.cards[0]?.card.id ?? null;
}

// ---- Which groups are open --------------------------------------------------

/// Groups are CLOSED by default, and what is remembered is the open set.
///
/// That polarity is what makes remembering safe. A group's id is its
/// file set, so it retires whenever anything in the fleet writes to the
/// checkout; an id nobody recognises therefore falls back to closed,
/// which is the state the human asked for anyway. Remembering the closed
/// set instead would make every churned id spring open, which is the
/// opposite of a default.
export function isGroupExpanded(expanded: string[], id: string): boolean {
  return expanded.includes(id);
}

/// One header clicked. Newest first and capped, so the list stays
/// bounded without ever being pruned against what is on screen.
export function toggleExpandedGroup(expanded: string[], id: string): string[] {
  if (expanded.includes(id)) return expanded.filter((e) => e !== id);
  return [id, ...expanded].slice(0, MAX_REMEMBERED_GROUPS);
}

/// Whether the one control has anything left to open. False for an empty
/// list too: a button that offers to close nothing is a button that
/// looks broken when it is pressed.
export function everyGroupExpanded(groups: ReviewGroup[], expanded: string[]): boolean {
  return groups.length > 0 && groups.every((g) => expanded.includes(g.id));
}

/// What the control writes.
///
/// Opening keeps the ids already remembered that are not on screen --
/// the query may be hiding them -- so "expand all" is not also a quiet
/// "forget everything else". Closing does the same in reverse: it closes
/// what is listed, not what it cannot see.
export function setAllGroupsExpanded(
  groups: ReviewGroup[],
  expanded: string[],
  open: boolean
): string[] {
  const listed = groups.map((g) => g.id);
  if (!open) {
    const hidden = new Set(listed);
    return expanded.filter((e) => !hidden.has(e));
  }
  const already = new Set(expanded);
  return [...listed.filter((id) => !already.has(id)), ...expanded].slice(0, MAX_REMEMBERED_GROUPS);
}
