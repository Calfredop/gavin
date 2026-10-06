// The Review tab's human tests: every `Human test:` item still owed on a
// card whose work is still open, one entry per card.
//
// A test is a check on finished work -- does the installer run, does the
// rendered surface look right -- which is the Review tab's question, so
// the tests are listed there, beside the diff they check, and the
// Decisions tab keeps the questions (decisions.ts). Both read one set of
// item rules: `pendingItems`, `humanItemWaiting` and `cardFinished` are
// decisions.ts's, so the two tabs cannot disagree about what is owed or
// about which cards are closed.
//
// Pure, like reviewBoard.ts beside it. The answer controls are the
// Decisions tab's own row and write (`DecisionsItemRow`,
// `answerHumanItem`): passing or failing a test means the same thing
// wherever it is pressed.

import type { HumanItem } from "$lib/core/gavin";
import type { CardView } from "$lib/core/planBoard";
import { matchesFields, queryTokens } from "$lib/core/search";
import { cardPasses, facetsActive, type BoardFacets } from "$lib/board/boardFilters";
import type { RailIndex } from "$lib/board/planFilter";
import {
  cardFinished,
  humanItemWaiting,
  pendingItems,
  type DecisionCard,
} from "$lib/decisions/decisions";
import { effectiveStatus, planIndex } from "$lib/orchestration/orchestration";

/// One card carrying human tests that are still owed.
export interface HumanTestSubject {
  /// The card's path, which is also the Review tab's selection key for
  /// a card -- so a card picked from the tests and the same card picked
  /// from its file group are one selection.
  cardPath: string;
  title: string;
  /// The card's effective status, for the row's chip.
  status: string | null;
  /// The tests still owed, in file order: open ones, and failed ones the
  /// agent has not re-armed yet.
  items: HumanItem[];
  /// The bound session's id, or null -- what a pass or a failure is
  /// told to.
  sessionId: string | null;
}

/// Kept as two counts for the reason the Decisions tab once kept them: a
/// failed test is back with the AGENT, so counting it as waiting on the
/// human would put a mark on the tab that no amount of checking clears.
export interface HumanTestsSummary {
  /// Tests waiting on the human to run them.
  waiting: number;
  /// Tests that failed and wait on the agent's fix.
  failed: number;
}

export interface HumanTestsInput {
  /// Every card in the workspace's tree, by path.
  cards: ReadonlyMap<string, DecisionCard>;
  /// Card path -> the session bound to it (`board.cardSessions`).
  bindings: ReadonlyMap<string, string>;
  /// The board's done column's name; see `cardFinished`.
  doneStatus?: string | null;
  /// `featureBlockedReason(compat, "humanItems")`. An older daemon parses
  /// no item lines, so its silence is not "no tests" -- when this is set
  /// nothing is listed and the reason travels out for the tab to say.
  itemsBlockedReason?: string | null;
}

export interface HumanTestsList {
  subjects: HumanTestSubject[];
  summary: HumanTestsSummary;
  itemsBlockedReason: string | null;
}

/// Every open card with tests still owed: waiting on you first, then the
/// ones only the agent owes.
export function humanTestList(input: HumanTestsInput): HumanTestsList {
  const blocked = input.itemsBlockedReason ?? null;
  if (blocked) return { subjects: [], summary: { waiting: 0, failed: 0 }, itemsBlockedReason: blocked };
  const plans = planIndex(input.cards);
  const doneStatus = input.doneStatus ?? null;
  const subjects: HumanTestSubject[] = [];
  for (const [path, card] of input.cards) {
    if (cardFinished(card, plans, doneStatus)) continue;
    const items = pendingItems(card.plan, "test");
    if (items.length === 0) continue;
    subjects.push({
      cardPath: path,
      title: card.plan.title.trim() || card.plan.fileName,
      status: effectiveStatus(card, plans),
      items,
      sessionId: input.bindings.get(path) ?? null,
    });
  }
  return {
    subjects: orderTestSubjects(subjects),
    summary: humanTestsSummary(subjects),
    itemsBlockedReason: null,
  };
}

/// Whether this card has a test the human can run now. A card whose only
/// tests have failed is listed so the human can see what the agent owes,
/// and pressing nothing on it is the right move.
export function testSubjectWaits(subject: HumanTestSubject): boolean {
  return subject.items.some(humanItemWaiting);
}

/// Waiting on you before owed by the agent, then by title, then by path
/// so two cards with one title keep their places.
export function orderTestSubjects(subjects: readonly HumanTestSubject[]): HumanTestSubject[] {
  return [...subjects].sort(
    (a, b) =>
      Number(testSubjectWaits(b)) - Number(testSubjectWaits(a)) ||
      a.title.localeCompare(b.title) ||
      a.cardPath.localeCompare(b.cardPath)
  );
}

/// The two counts, over tests rather than cards: one card can ask for
/// three checks, and that is three things to do.
export function humanTestsSummary(subjects: readonly HumanTestSubject[]): HumanTestsSummary {
  let waiting = 0;
  let failed = 0;
  for (const subject of subjects) {
    for (const item of subject.items) {
      if (humanItemWaiting(item)) waiting += 1;
      else if (item.state === "failed") failed += 1;
    }
  }
  return { waiting, failed };
}

/// Whether the Review tab should wear its attention mark: a test is
/// waiting on the human. Never the failed count -- see HumanTestsSummary.
export function humanTestsWaiting(summary: HumanTestsSummary): boolean {
  return summary.waiting > 0;
}

/// A test row's second line: what it holds for the human, and what is
/// back with the agent.
export function testSubjectDetail(subject: HumanTestSubject): string {
  const waiting = subject.items.filter(humanItemWaiting).length;
  const failed = subject.items.filter((item) => item.state === "failed").length;
  const parts: string[] = [];
  if (waiting > 0) parts.push(waiting === 1 ? "1 test" : `${waiting} tests`);
  if (failed > 0) parts.push(`${failed} failed, with the agent`);
  return parts.join(" · ");
}

/// One test row as the Review tab's list draws it: the subject, and the
/// card's own view when the projection holds one (for the facets, and
/// for the panes once it is selected).
export interface ReviewTestRow {
  subject: HumanTestSubject;
  card: CardView | null;
}

export interface ReviewTestOptions {
  query: string;
  facets: BoardFacets;
  rails: RailIndex;
}

/// The tests through the Review tab's own lens: the same search box and
/// the same context/kind/rail/label facets as the card groups, so a
/// narrowed tab narrows everything in it. The column picker and the
/// archive toggle do NOT apply -- they choose which finished columns to
/// read diffs from, and a test is owed whatever column its card is in,
/// short of Done (`cardFinished`).
///
/// A card the projection does not hold yet (the board has not loaded)
/// cannot be judged against a facet, so it is shown only while no facet
/// is set.
export function reviewTestRows(
  subjects: readonly HumanTestSubject[],
  cards: ReadonlyMap<string, CardView>,
  options: ReviewTestOptions
): ReviewTestRow[] {
  const tokens = queryTokens(options.query);
  const faceted = facetsActive(options.facets);
  const rows: ReviewTestRow[] = [];
  for (const subject of subjects) {
    const card = cards.get(subject.cardPath) ?? null;
    if (card ? !cardPasses(card, options.facets, options.rails) : faceted) continue;
    // One haystack for the card and its tests, so a query naming the
    // card and the check together still finds it.
    const fields = [
      subject.title,
      subject.status,
      card?.fileName,
      card?.contextName,
      card?.parentTitle,
      ...(card?.labels ?? []),
      ...subject.items.flatMap((item) => [item.text, item.latest]),
    ];
    if (!matchesFields(tokens, fields)) continue;
    rows.push({ subject, card });
  }
  return rows;
}
