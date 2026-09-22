// The card link's DRIVERS: when to ask, whether to ask at all, and what to
// do with an answer that arrives late.
//
// `commitCardLink.ts` is the policy and can be argued with in a test.
// This file is the wiring between two surfaces and the host command,
// and it holds the gates that decide whether a byte leaves the machine:
//
//  1. **The human said so.** The same switch the turn verdict runs on
//     (`typesafeSettings`), and a key alone is not consent -- see
//     `typesafe.rs`. Null there is "nobody has asked the host yet", not
//     "off": the turn-verdict driver loads it once per window, but the
//     Git tab can be the first thing opened, so this side asks the host
//     itself before reading null as a refusal.
//  2. **There is a key.** No key, no request.
//  3. **There is a board.** A Choice over `none` alone has nothing to
//     answer, so an empty tree asks nothing.
//
// Two consumers, one driver, because the request, the gate and the
// supersession are the same and only the KEY of a slot differs: a commit
// is asked about by its sha, a search by the query as it settled. Each
// workspace holds one slot per consumer -- the Git tab shows one commit
// at a time and the board runs one search -- and a slot whose key is not
// the one the surface is looking at is simply not shown, which is what
// makes an answer for the previous commit harmless even before the token
// drops it.
//
// The supersession discipline is the codebase's usual one: a per-workspace
// token bumped on every new ask and every clear, and an answer whose
// token is stale lands nowhere. A counter rather than an object
// comparison, per CLAUDE.md -- Svelte 5 proxies `$state`, so identity is
// never a valid guard.

import { get, writable, type Writable } from "svelte/store";

import * as backend from "$lib/core/backend";
import { loadTypesafeSettings, typesafeSettings } from "$lib/agents/turnVerdictState";
import {
  cardOptions,
  commitLinkRequest,
  parseCardAnswer,
  readCardLink,
  searchLinkRequest,
  type CardLink,
  type CardLinkRequest,
  type CardOption,
  type CommitState,
  type LinkableCard,
} from "$lib/git/commitCardLink";

/// Where one ask has got to. `pending` shows nothing -- a surface must
/// never put a title in front of somebody on a request that has not
/// answered -- and `read` with a null link is the ordinary fallback: an
/// error, a refused key, `none`, or a body this build cannot parse. All
/// of them look like a build without this feature.
export type CardLinkEntry = { state: "pending" } | { state: "read"; link: CardLink | null };

/// One workspace's slot: what was asked about, and the answer.
export interface CardLinkSlot {
  /// The commit's sha, or the search query exactly as it settled. A
  /// surface compares this against what it is showing and ignores a
  /// slot about anything else.
  key: string;
  entry: CardLinkEntry;
}

/// The Git tab's slot per workspace: the commit selected in the history
/// pane.
export const commitCardLinks = writable<Record<string, CardLinkSlot>>({});

/// The board's slot per workspace: the search that came back empty.
export const cardsByMeaning = writable<Record<string, CardLinkSlot>>({});

/// How long the search box has to be quiet before a query is asked
/// about. Typing a twelve-letter word is twelve empty boards in a row,
/// and each is a request if nothing waits.
export const SEARCH_DEBOUNCE_MS = 400;

const commitTokens = new Map<string, number>();
const searchTokens = new Map<string, number>();
const searchTimers = new Map<string, ReturnType<typeof setTimeout>>();

function bump(tokens: Map<string, number>, workspaceId: string): number {
  const token = (tokens.get(workspaceId) ?? 0) + 1;
  tokens.set(workspaceId, token);
  return token;
}

/// Gates 1 and 2, asking the host first when nobody has.
async function typesafeReady(): Promise<boolean> {
  if (get(typesafeSettings) === null) await loadTypesafeSettings();
  const settings = get(typesafeSettings);
  return settings?.enabled === true && settings.hasKey === true;
}

function drop(store: Writable<Record<string, CardLinkSlot>>, workspaceId: string): void {
  store.update((m) => {
    if (!(workspaceId in m)) return m;
    const next = { ...m };
    delete next[workspaceId];
    return next;
  });
}

/// One ask. Fire-and-forget by contract: the callers are a `$effect` and
/// a timer, neither of which can await, and every failure below is the
/// same null the policy already treats as "show nothing". Nothing here
/// ever throws at its caller.
function ask(
  store: Writable<Record<string, CardLinkSlot>>,
  tokens: Map<string, number>,
  workspaceId: string,
  token: number,
  key: string,
  cards: LinkableCard[],
  build: (options: CardOption[]) => CardLinkRequest
): void {
  void (async () => {
    const live = () => tokens.get(workspaceId) === token;
    try {
      if (cards.length === 0 || !(await typesafeReady())) {
        // Not even a `read` slot: a surface nobody asked for must look
        // exactly like one on a build without this feature.
        if (live()) drop(store, workspaceId);
        return;
      }
      if (!live()) return;
      store.update((m) => ({ ...m, [workspaceId]: { key, entry: { state: "pending" } } }));
      const options = cardOptions(cards);
      const body = await backend.typesafeAsk(build(options));
      if (!live()) return;
      const link = readCardLink(parseCardAnswer(body, options), options);
      store.update((m) => ({ ...m, [workspaceId]: { key, entry: { state: "read", link } } }));
    } catch {
      // Every failure is one failure: a refused key, a 500, a timeout, a
      // body this build cannot parse. They all mean "show nothing", and
      // the surfaces cannot tell them apart because there is nothing
      // useful they could do differently.
      if (live()) store.update((m) => ({ ...m, [workspaceId]: { key, entry: { state: "read", link: null } } }));
    }
  })();
}

/// The Git tab selected a commit. Asked ONCE per commit: the detail pane
/// re-renders on every store emission, and a pane that asked on each of
/// them would be a request per keystroke rather than per selection.
export function askCommitCardLink(
  workspaceId: string,
  sha: string,
  commit: CommitState,
  cards: LinkableCard[]
): void {
  if (get(commitCardLinks)[workspaceId]?.key === sha) return;
  const token = bump(commitTokens, workspaceId);
  ask(commitCardLinks, commitTokens, workspaceId, token, sha, cards, (options) =>
    commitLinkRequest(commit, options)
  );
}

/// The Git tab has no commit selected any more, or is gone.
export function clearCommitCardLink(workspaceId: string): void {
  bump(commitTokens, workspaceId);
  drop(commitCardLinks, workspaceId);
}

/// The board's search left it empty. Asked once the typing settles, and
/// once per settled query. Bumps the token at once rather than when the
/// timer fires, so an answer still in flight for the query just typed
/// over is dropped the moment it is superseded.
export function askCardsByMeaning(workspaceId: string, query: string, cards: LinkableCard[]): void {
  const timer = searchTimers.get(workspaceId);
  if (timer !== undefined) {
    clearTimeout(timer);
    searchTimers.delete(workspaceId);
  }
  if (get(cardsByMeaning)[workspaceId]?.key === query) return;
  const token = bump(searchTokens, workspaceId);
  searchTimers.set(
    workspaceId,
    setTimeout(() => {
      searchTimers.delete(workspaceId);
      if (searchTokens.get(workspaceId) !== token) return;
      ask(cardsByMeaning, searchTokens, workspaceId, token, query, cards, (options) =>
        searchLinkRequest(query, options)
      );
    }, SEARCH_DEBOUNCE_MS)
  );
}

/// The lexical search found something, the box was cleared, or the board
/// is gone. Cancels a wait as well as an answer: a query the human typed
/// past before the timer fired is a request never worth sending.
export function clearCardsByMeaning(workspaceId: string): void {
  const timer = searchTimers.get(workspaceId);
  if (timer !== undefined) {
    clearTimeout(timer);
    searchTimers.delete(workspaceId);
  }
  bump(searchTokens, workspaceId);
  drop(cardsByMeaning, workspaceId);
}

/// Test seam, matching `turnVerdictDriver.__resetForTesting`.
export function __resetForTesting(): void {
  for (const timer of searchTimers.values()) clearTimeout(timer);
  searchTimers.clear();
  commitTokens.clear();
  searchTokens.clear();
  commitCardLinks.set({});
  cardsByMeaning.set({});
}
