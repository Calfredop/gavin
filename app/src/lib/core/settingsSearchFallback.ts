// The settings search's FALLBACK: when no keyword matches, find the
// section by meaning.
//
// `searchSettings` shows a section only when every typed token is a
// substring of that section's hand-written keyword table, so a synonym
// nobody listed empties the screen. Measured on 41 plain-language queries
// labelled before any run (`plans/done/typesafe-experiments-round-2.md`;
// method and the exact question in
// `docs/superpowers/specs/2026-09-21-typesafe-change-attribution-experiment.md`),
// the matcher showed the right section for 4 and an empty screen for 37.
// One TypeSafe Choice whose options are the keyword tables themselves,
// verbatim, picked the right section for 38 and resolved 34 of the 37
// empty screens, at about 1k tokens, $0.00004 and 0.3s a query.
//
// The tables are still the first line of defence. The synonyms that were
// plain vocabulary gaps went INTO them -- settingsSearch.test.ts checks
// the shipped tables for each -- because a substring costs nothing and
// waits for nobody. What is here runs only after they have had their
// chance, and it is built to keep four promises:
//
//  - **Only on an empty literal result.** A literal hit never asks. An
//    empty box never asks. A query that is still being typed is not
//    asked about until it has settled for `FALLBACK_DEBOUNCE_MS`.
//  - **Behind the turn verdict's toggle and key.** One consent covers
//    every TypeSafe request the app makes, and the Settings copy says
//    what this one sends: the words typed into the box and the sections'
//    keyword lists. Nothing from any workspace.
//  - **Never worse than today.** `none`, a confidence under the floor, an
//    error, a timeout, a body this build cannot read and a missing key
//    all keep today's empty screen. The one section that IS shown is
//    shown under a "Closest match" line, so the human can see it was not
//    a literal hit and the box's own count still reads what the matcher
//    found.
//  - **The question is frozen and the model pinned.** `SECTION_QUESTION`
//    is the E7 wording from the experiment record, verbatim, and the
//    floor was measured against `TYPESAFE_MODEL` (`jev-1.13.0`). Re-wording
//    the question or floating the model silently invalidates the number
//    while leaving the code looking exactly as correct as before.
//
// Two halves. The pure functions (request, parse, policy, projection)
// have nothing to mock and are argued with in settingsSearchFallback.test.ts.
// `createSettingsSearchFallback` is the small driver both panels share:
// it owns the debounce, the backstop and the supersession token, and
// reaches the host through the function it is handed -- the API key
// lives in the Rust host (`typesafe.rs`), and nothing here has seen it.

import { TYPESAFE_MODEL } from "$lib/agents/turnVerdict";
import { queryTokens } from "$lib/core/search";
import type { SettingsSearch, SettingsSection } from "$lib/core/settingsSearch";

/// Below this the answer is not shown: today's empty screen stands.
///
/// 0.5, not the turn verdict's 0.75, and measured rather than chosen: at
/// this floor the model answered 40 of the 41 queries and was right on
/// 38. The stakes are also different -- a wrong section here is one
/// click away from the right one, where a wrong verdict stalls a rail.
export const FALLBACK_MIN_CONFIDENCE = 0.5;

/// How long the box must be still before a request goes out. A request
/// per keystroke would be a request per letter of "text size".
export const FALLBACK_DEBOUNCE_MS = 400;

/// How long an unanswered request may hold before the empty screen is
/// confirmed. The host's own budget is 2s (`TOTAL_BUDGET` in
/// `typesafe.rs`); this is that plus the two IPC hops around it, and it
/// is a BACKSTOP for the case where the command itself never returns
/// rather than the timeout, which the host enforces.
export const FALLBACK_BACKSTOP_MS = 3_000;

/// The E7 question, VERBATIM from the experiment record. The question id
/// (`section`) is not sent to the model, so the instruction carries the
/// whole meaning, including what `search_query` is and what an option is.
export const SECTION_QUESTION =
  "A user typed `search_query` into the search box of the settings screen of a desktop app that runs AI coding agents in terminals. Each option is one settings section, described by the settings it holds. Which section is the user looking for?";

/// The option that is not a section. Named in the criteria so the model
/// can say "nothing here", which the policy honours by showing nothing.
const NONE = "none";
const NONE_CRITERION = "No section holds a setting for this.";

/// One option per section: its keyword table, verbatim, under a name that
/// says what the list is. Nothing is curated on top of the tables --
/// that is the whole reason the experiment's numbers carry over.
type SectionCriterion = { settings_in_this_section: string[] };

/// The body of the one request, exactly as it goes on the wire.
export interface FallbackRequest {
  model: string;
  state: { search_query: string };
  questions: {
    section: {
      type: "choice";
      instructions: string;
      criteria: Record<string, SectionCriterion | string>;
    };
  };
}

/// The query with its whitespace settled: lower-cased tokens, one space
/// apart. Both the state that is sent and the key an answer is filed
/// under, so "text size " is the same question as "text size" and does
/// not ask twice.
export function fallbackQueryKey(query: string): string {
  return queryTokens(query).join(" ");
}

export function fallbackRequest(sections: SettingsSection[], query: string): FallbackRequest {
  const criteria: Record<string, SectionCriterion | string> = {};
  for (const s of sections) criteria[s.id] = { settings_in_this_section: [...s.keywords] };
  criteria[NONE] = NONE_CRITERION;
  return {
    model: TYPESAFE_MODEL,
    state: { search_query: fallbackQueryKey(query) },
    questions: { section: { type: "choice", instructions: SECTION_QUESTION, criteria } },
  };
}

/// The model's raw answer to the one Choice, kept whole so the floor can
/// be re-derived from it.
export interface FallbackAnswer {
  /// A section id, or `none`.
  choice: string;
  /// How concentrated the Choice's distribution was -- not a claim that
  /// the section is right.
  confidence: number;
}

/// The response, or null if it is not one this build can read.
///
/// A choice that is neither `none` nor a section THIS panel offered is a
/// refusal, on `parseVerdictAnswers`'s principle: a value the code does
/// not understand must never fall into a branch that acts. The two panels
/// have different tables, so "a section this panel offered" is checked
/// against the sections the request was built from, not a global list.
export function parseFallbackAnswer(body: unknown, sections: SettingsSection[]): FallbackAnswer | null {
  if (!body || typeof body !== "object") return null;
  const answers = (body as Record<string, unknown>).answers;
  if (!answers || typeof answers !== "object") return null;
  const a = (answers as Record<string, unknown>).section;
  if (!a || typeof a !== "object") return null;
  const rec = a as Record<string, unknown>;
  const choice = rec.choice;
  const confidence = rec.confidence;
  if (typeof choice !== "string") return null;
  if (choice !== NONE && !sections.some((s) => s.id === choice)) return null;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  return { choice, confidence };
}

/// The policy: the one section to show, or null for today's empty screen.
///
/// Null is the answer for no answer, for `none`, and for anything under
/// the floor -- the same null a failed request produces, on purpose: the
/// panel cannot tell them apart and has nothing different to do for any
/// of them.
export function closestSection(answer: FallbackAnswer | null): string | null {
  if (!answer) return null;
  if (answer.choice === NONE) return null;
  if (answer.confidence < FALLBACK_MIN_CONFIDENCE) return null;
  return answer.choice;
}

/// Whether a byte may leave the machine: the turn verdict's toggle AND a
/// key. Null is what the store holds before the host has been asked, and
/// an unread setting is not consent.
export function fallbackAllowed(
  settings: { enabled: boolean; hasKey: boolean } | null | undefined
): boolean {
  return settings?.enabled === true && settings.hasKey === true;
}

/// Whether a literal result is the kind the fallback exists for: a real
/// query that found nothing.
export function wantsFallback(literal: SettingsSearch): boolean {
  return literal.filtering && literal.shown === 0;
}

/// An answer, filed under the settled query it answered. The query is the
/// guard: a panel's state holds the last answer for a moment after the
/// box moves on, and (CLAUDE.md, Svelte 5 proxies) identity of any object
/// is never something to gate on.
export interface ClosestMatch {
  id: string;
  query: string;
}

/// What a panel renders: the literal search, plus which section is being
/// shown as the closest match rather than as a hit -- null for a literal
/// result, so that a template reading `closest` can draw the line only
/// when it is true.
export interface ShownSettingsSearch extends SettingsSearch {
  closest: string | null;
}

/// The projection. A literal result passes through untouched; an empty
/// one with an answer for THIS query shows that one section. `shown`
/// counts what the panel shows, which is one; the box's own count is
/// fed the literal result by the template, so it keeps reading zero.
export function withClosestMatch(
  literal: SettingsSearch,
  closest: ClosestMatch | null,
  query: string
): ShownSettingsSearch {
  if (!wantsFallback(literal) || !closest || closest.query !== fallbackQueryKey(query)) {
    return { ...literal, closest: null };
  }
  const id = closest.id;
  return { filtering: true, shown: 1, total: literal.total, visible: (s) => s === id, closest: id };
}

export interface FallbackDeps {
  /// The host command (`backend.typesafeAsk`): the host adds the key and
  /// the address. Rejects on every failure.
  ask: (request: FallbackRequest) => Promise<unknown>;
  /// `fallbackAllowed` over the current setting, read at note time and
  /// again at send time.
  allowed: () => boolean;
  /// Where the answer lands: the panel's own state. Called with null
  /// whenever the question changes, so a stale answer never outlives its
  /// query even before the projection's own guard.
  onClosest: (closest: ClosestMatch | null) => void;
  debounceMs?: number;
  backstopMs?: number;
}

export interface SettingsSearchFallback {
  /// The panel's search changed. Handed the literal result beside the
  /// query so that "did the matcher find anything" is the matcher's own
  /// answer, not re-derived here.
  note(sections: SettingsSection[], query: string, literal: SettingsSearch): void;
  /// Unmount. Drops the timer and any answer in flight; nothing is sent
  /// or landed afterwards.
  dispose(): void;
}

/// The driver. One per panel, disposed with it.
///
/// Everything in here is the supersession discipline this codebase
/// already insists on: a per-question token, bumped whenever the query
/// changes, whenever the matcher finds something and on dispose; an
/// answer whose token is stale lands nowhere. The backstop settles the
/// same token to "nothing", and a settled token cannot settle again, so
/// an answer that arrives after the backstop gave up is dropped too.
export function createSettingsSearchFallback(deps: FallbackDeps): SettingsSearchFallback {
  const debounceMs = deps.debounceMs ?? FALLBACK_DEBOUNCE_MS;
  const backstopMs = deps.backstopMs ?? FALLBACK_BACKSTOP_MS;
  /// Bumped on every change of question. An answer carries the token it
  /// was asked under and is dropped if the token has moved.
  let token = 0;
  /// The token whose answer (or backstop) has already landed.
  let settledToken = -1;
  /// The settled query a request is pending or answered for, so that the
  /// same query noted twice -- a panel's effect re-running, a trailing
  /// space -- is not a second request.
  let currentKey: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function supersede(): void {
    token += 1;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function settle(t: number, closest: ClosestMatch | null): void {
    if (t !== token || t === settledToken) return;
    settledToken = t;
    deps.onClosest(closest);
  }

  function send(t: number, sections: SettingsSection[], key: string): void {
    timer = null;
    if (disposed || t !== token) return;
    // Re-checked here: the toggle may have been flipped during the
    // debounce, and a request is the one thing that cannot be taken back.
    if (!deps.allowed()) {
      currentKey = null;
      return;
    }
    const backstop = setTimeout(() => settle(t, null), backstopMs);
    let reply: Promise<unknown>;
    try {
      reply = deps.ask(fallbackRequest(sections, key));
    } catch (e) {
      reply = Promise.reject(e);
    }
    reply
      .then(
        (body) => {
          const id = closestSection(parseFallbackAnswer(body, sections));
          settle(t, id ? { id, query: key } : null);
        },
        () => {
          // Every failure is one failure: a refused key, a 500, a dead
          // host, a timeout. All of them are today's empty screen.
          settle(t, null);
        }
      )
      .finally(() => clearTimeout(backstop));
  }

  return {
    note(sections, query, literal) {
      if (disposed) return;
      if (!wantsFallback(literal)) {
        // A literal hit, or an empty box. Whatever was asked is moot, and
        // whatever was shown as closest must go: the panel is showing
        // real matches now.
        currentKey = null;
        supersede();
        deps.onClosest(null);
        return;
      }
      const key = fallbackQueryKey(query);
      if (key === currentKey) return;
      currentKey = key;
      supersede();
      deps.onClosest(null);
      if (!deps.allowed()) {
        // Not recorded as asked, so that the same query noted again once
        // the setting has been read (the store is null until the host
        // answers) does go out.
        currentKey = null;
        return;
      }
      const t = token;
      timer = setTimeout(() => send(t, sections, key), debounceMs);
    },
    dispose() {
      disposed = true;
      currentKey = null;
      supersede();
    },
  };
}
