// Which card a commit was made for -- and, by the same question, which
// card a search is looking for.
//
// Nothing ties a commit to the card it served except the human's memory
// and a "file the X card as done" commit beside it, and CLAUDE.md already
// warns that `git log` cannot answer "is this feature in?". The board's
// search is token-AND substring (`core/search.ts`), so a card is only
// findable by words that are literally on it.
//
// One TypeSafe Choice over every card TITLE on the board plus `none`,
// with the commit's subject, body and file list as state, names the
// right card for 88% of the 96 commits in this repository whose card is
// known from history (TF-IDF: 63%; top three: 96%). At a confidence of
// 0.75 it links 73 of the 96 and 72 are right. A commit message is a
// paraphrase of its card written by someone who was not trying to match
// it, so the same request over a typed query is a find-by-meaning for the
// board. Method, numbers and the exact question set:
// `docs/superpowers/specs/2026-09-21-typesafe-change-attribution-experiment.md`
// (E5). NOT measured: commits that belong to no card, which is why the
// policy below only ever SHOWS a link and nothing here writes one.
//
// The contract, in three parts, and every function below keeps it:
//
//  - **Suggest, never record.** A link is a line on a screen. Nothing is
//    written to a card, a commit or a store the app persists; closing the
//    pane forgets it. The `none` rate on real orphans being unknown is
//    the reason: a stored wrong link would outlive the evidence for it.
//
//  - **Titles only, one request.** What leaves the machine is the commit
//    message, its changed file PATHS and every card's title -- never a
//    diff, a card body or a path to a card. A Choice holds 255 options,
//    so the whole board rides in one request (~2.4k tokens, $0.0001,
//    0.3s); `none` takes one option and the most recently modified 254
//    cards take the rest. The open board and `plans/done/` are on the
//    list; `plans/archive/` is off the board and so off the list.
//
//  - **Policy in code, the question frozen.** `COMMIT_INSTRUCTIONS` and
//    `COMMIT_NONE` are the E5 wording verbatim and `TYPESAFE_MODEL` pins
//    `jev-1.13.0`; the confidence floor was measured against that pair.
//    The search variant changes only the sentence that names the state,
//    because the question ids are not sent and `search_query` has to be
//    named for the model to find it.
//
// Pure. The request is carried by the same host command the turn verdict
// uses (`typesafe.rs`), because the key must never reach this side, and
// no store is read here -- the drivers in `commitCardLinkState.ts` hand
// in the cards and take the answer.

import { TYPESAFE_MODEL } from "$lib/agents/turnVerdict";
import type { GavinTree } from "$lib/core/gavin";
import { isArchivedCard } from "$lib/core/planBoard";

/// Below this a link is not shown as THE card: the top three are offered
/// instead and the human picks. Measured on the title condition: at this
/// floor 73 of 96 commits link and 72 are right.
export const CARD_LINK_MIN_CONFIDENCE = 0.75;

/// How many cards an unsure answer offers. Top three held 96% of the
/// right cards on the measured set.
export const CANDIDATE_COUNT = 3;

/// A Choice holds 255 options and `none` is one of them.
export const MAX_CARD_OPTIONS = 254;

/// What the experiment sent of a commit: the body cut at 500 characters
/// and the first 12 changed paths. Enough to name the card; more is
/// tokens spent on the diff-shaped tail of a long message.
export const COMMIT_BODY_CHARS = 500;
export const COMMIT_FILE_PATHS = 12;

/// The key the no-match option holds. Never a card's key.
export const NONE_KEY = "none";

/// The E5 question, verbatim.
export const COMMIT_INSTRUCTIONS =
  "Each option is a card on a kanban board: a piece of planned work. `commit` is a git commit from the same project. Which card was this commit made for?";
export const COMMIT_NONE = "The commit does not belong to any of these cards.";

/// The same Choice asked of a search. Only the sentence naming the state
/// differs -- and it was not measured, so the board treats its answer
/// exactly as it treats a commit's: an offer of up to three cards, never
/// a result.
export const SEARCH_INSTRUCTIONS =
  "Each option is a card on a kanban board: a piece of planned work. A user typed `search_query` into the board's search box and no card matched it word for word. Which card is the user looking for?";
export const SEARCH_NONE = "No card here is what the user is looking for.";

/// A card as this feature knows it: enough to make an option of it and
/// to open it afterwards. `modifiedAt` decides who stays when the board
/// is over the cap.
export interface LinkableCard {
  path: string;
  title: string;
  modifiedAt: number | null;
}

/// Every card that is ON the board, from the tree the daemon sent: the
/// open columns and `plans/done/` (Done is a column), nested children
/// included, and never `plans/archive/`. The archive is off the board by
/// definition, and a link to a card the human filed away would be a
/// link to something no surface shows.
export function linkableCards(tree: GavinTree | undefined): LinkableCard[] {
  if (!tree || tree.rootMissing) return [];
  const cards: LinkableCard[] = [];
  for (const ctx of tree.contexts) {
    for (const plan of ctx.plans) {
      if (isArchivedCard(plan.path)) continue;
      cards.push({ path: plan.path, title: plan.title, modifiedAt: plan.modifiedAt ?? null });
    }
  }
  return cards;
}

/// One option: the neutral key the model answers with, and the card it
/// stands for. Keys are never shown to the model; titles are.
export interface CardOption {
  key: string;
  card: LinkableCard;
}

/// The cards as Choice options, `card_01`.. in board order.
///
/// Over the cap, the most recently modified cards stay and the ones
/// nobody has touched in longest go -- an undated card (a pre-v13 daemon,
/// a file that vanished between scan and stat) counts as untouched
/// forever. The survivors keep their board order rather than the date
/// order they were chosen by: the option list is what the human would
/// recognise as the board, and the cap is the only reason a date is read
/// at all.
export function cardOptions(cards: LinkableCard[]): CardOption[] {
  let kept = cards;
  if (cards.length > MAX_CARD_OPTIONS) {
    const byRecency = [...cards].sort((a, b) => (b.modifiedAt ?? -Infinity) - (a.modifiedAt ?? -Infinity));
    const survivors = new Set(byRecency.slice(0, MAX_CARD_OPTIONS));
    kept = cards.filter((c) => survivors.has(c));
  }
  const width = Math.max(2, String(kept.length).length);
  return kept.map((card, i) => ({ key: `card_${String(i + 1).padStart(width, "0")}`, card }));
}

/// The commit as the model sees it: the subject line, the rest of the
/// message, and the paths it touched. What `git show --format=%B` gives
/// is the whole message with the subject on its first line, so the
/// subject is taken off the body rather than sent twice.
export interface CommitState {
  subject: string;
  body: string;
  files: string[];
}

export function commitState(subject: string, message: string, files: string[]): CommitState {
  const lines = message.split("\n");
  const body = (lines[0]?.trim() === subject.trim() ? lines.slice(1).join("\n") : message).trim();
  return {
    subject,
    body: body.slice(0, COMMIT_BODY_CHARS),
    files: files.slice(0, COMMIT_FILE_PATHS),
  };
}

/// The one question, exactly as it goes on the wire.
export interface CardQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface CardLinkRequest {
  model: string;
  state: { commit: CommitState } | { search_query: string };
  questions: { card: CardQuestion };
}

function cardQuestion(instructions: string, none: string, options: CardOption[]): CardQuestion {
  const criteria: Record<string, string> = {};
  for (const o of options) criteria[o.key] = o.card.title;
  criteria[NONE_KEY] = none;
  return { type: "choice", instructions, criteria };
}

/// The request for one commit: ~2.4k tokens for a full board.
export function commitLinkRequest(commit: CommitState, options: CardOption[]): CardLinkRequest {
  return {
    model: TYPESAFE_MODEL,
    state: { commit },
    questions: { card: cardQuestion(COMMIT_INSTRUCTIONS, COMMIT_NONE, options) },
  };
}

/// The request for one search that the lexical matcher answered with
/// nothing.
export function searchLinkRequest(query: string, options: CardOption[]): CardLinkRequest {
  return {
    model: TYPESAFE_MODEL,
    state: { search_query: query },
    questions: { card: cardQuestion(SEARCH_INSTRUCTIONS, SEARCH_NONE, options) },
  };
}

/// What the model answered, normalised. The distribution is kept whole
/// even though only its top three are read, on the turn verdict's
/// principle: a threshold nobody can re-derive from stored judgments is
/// a threshold nobody can move.
export interface CardAnswer {
  choice: string;
  confidence: number;
  /// Null when the response carried none; a surface then has only the
  /// choice to offer.
  probabilities: Record<string, number> | null;
}

/// The response, or null if it is not one this build can read.
///
/// A `choice` outside the options THIS request sent is a refusal, not a
/// card: a key the model was never offered cannot name one, and a
/// TypeSafe deployment that answered with something new must degrade to
/// "no link", which is what the human had before any of this existed.
export function parseCardAnswer(body: unknown, options: CardOption[]): CardAnswer | null {
  if (!body || typeof body !== "object") return null;
  const answers = (body as Record<string, unknown>).answers;
  if (!answers || typeof answers !== "object") return null;
  const a = (answers as Record<string, unknown>).card;
  if (!a || typeof a !== "object") return null;
  const rec = a as Record<string, unknown>;
  const choice = rec.choice;
  const confidence = rec.confidence;
  if (typeof choice !== "string") return null;
  if (choice !== NONE_KEY && !options.some((o) => o.key === choice)) return null;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  let probabilities: Record<string, number> | null = null;
  if (rec.probabilities && typeof rec.probabilities === "object") {
    probabilities = {};
    for (const [key, p] of Object.entries(rec.probabilities as Record<string, unknown>)) {
      if (typeof p === "number" && Number.isFinite(p)) probabilities[key] = p;
    }
  }
  return { choice, confidence, probabilities };
}

/// What a surface shows: the card, or up to three to choose from.
export type CardLink =
  | { kind: "card"; card: LinkableCard; confidence: number }
  | { kind: "candidates"; cards: LinkableCard[] };

/// The policy. Null means "show nothing", which is today's answer.
///
/// `none` is nothing whatever its confidence -- an unsure `none` still
/// has a card as its runner-up, and offering that runner-up would be
/// showing a link the model leaned against. Below the floor the top three
/// cards by probability are offered, `none` left out of the ranking, and
/// a card with no probability at all is not offered: three names where
/// one was likely reads as three guesses.
export function readCardLink(answer: CardAnswer | null, options: CardOption[]): CardLink | null {
  if (!answer || answer.choice === NONE_KEY) return null;
  const chosen = options.find((o) => o.key === answer.choice);
  if (!chosen) return null;
  if (answer.confidence >= CARD_LINK_MIN_CONFIDENCE) {
    return { kind: "card", card: chosen.card, confidence: answer.confidence };
  }
  if (!answer.probabilities) return { kind: "candidates", cards: [chosen.card] };
  const ranked = options
    .map((o) => ({ card: o.card, p: answer.probabilities?.[o.key] ?? 0 }))
    .filter((r) => r.p > 0)
    .sort((a, b) => b.p - a.p)
    .slice(0, CANDIDATE_COUNT)
    .map((r) => r.card);
  // The choice is the highest-probability option by definition, so it is
  // in `ranked` whenever the distribution is consistent with it; a
  // distribution that omits it is still answered with the choice alone
  // rather than with nothing.
  if (ranked.length === 0) return { kind: "candidates", cards: [chosen.card] };
  return { kind: "candidates", cards: ranked };
}

/// The cards a surface lists for a link: one, up to three, or none.
export function linkedCards(link: CardLink | null): LinkableCard[] {
  if (!link) return [];
  return link.kind === "card" ? [link.card] : link.cards;
}
