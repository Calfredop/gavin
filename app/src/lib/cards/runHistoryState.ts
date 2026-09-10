// The store behind the per-card run history: one entry per card path,
// fetched on demand and never on a timer.
//
// Demand-loaded for the same reason `runChangesState` is. The rows
// themselves are cheap, but the COST of each one is a transcript file
// read off disk -- and a card with a dozen runs is a dozen files. A
// history that loaded itself for every card on the board would read
// every agent log on the machine to render a column nobody opened.
//
// So the two halves load separately: the rows arrive with the panel, and
// each run's tokens are fetched per row, in parallel, once. A row whose
// cost is still in flight renders as a row, not as a gap -- the run
// happened whether or not its bill can be read.
//
// Supersession is guarded with a token counter rather than by comparing
// objects: Svelte 5's `$state` proxies everything it touches, so a
// stored value is never identity-equal to the one that was put in.

import { get, writable } from "svelte/store";
import * as backend from "$lib/core/backend";
import type { CardRun, TokenReport } from "$lib/cards/runHistory";

export interface RunHistoryView {
  runs: CardRun[];
  loading: boolean;
  error: string | null;
  /// Per conversation id, because that is what a transcript is filed
  /// under -- two sessions of one resume chain share the id and
  /// therefore the reading, and asking twice for the same file would
  /// double the disk work to show the same number twice.
  tokens: Record<string, TokenReport>;
  /// Conversation ids currently being read, so a row can say "reading"
  /// rather than "nothing".
  tokensLoading: string[];
  token: number;
}

export const runHistoryStore = writable<Record<string, RunHistoryView>>({});

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function update(path: string, fn: (view: RunHistoryView) => RunHistoryView): void {
  runHistoryStore.update((all) => (all[path] ? { ...all, [path]: fn(all[path]) } : all));
}

export function historyFor(path: string): RunHistoryView | undefined {
  return get(runHistoryStore)[path];
}

/// Opens a card's history and loads it. The rows a previous open left
/// behind are KEPT while the fetch is in flight -- reopening a panel
/// that flashes empty and then fills reads as a card that lost its
/// history, which is the one thing this feature must never suggest.
export async function openRunHistory(path: string, workspaceId: string, profileId: string): Promise<void> {
  const existing = get(runHistoryStore)[path];
  runHistoryStore.update((all) => ({
    ...all,
    [path]: {
      runs: existing?.runs ?? [],
      loading: true,
      error: null,
      tokens: existing?.tokens ?? {},
      tokensLoading: [],
      token: (existing?.token ?? 0) + 1,
    },
  }));
  await refreshRunHistory(path, workspaceId, profileId);
}

export async function refreshRunHistory(
  path: string,
  workspaceId: string,
  profileId: string
): Promise<void> {
  const view = get(runHistoryStore)[path];
  if (!view) return;
  const token = view.token + 1;
  update(path, (v) => ({ ...v, token, loading: true, error: null }));
  let runs: CardRun[];
  try {
    runs = await backend.cardRuns(workspaceId, path);
  } catch (e) {
    update(path, (v) =>
      v.token === token
        ? { ...v, loading: false, error: `Couldn't read this card's run history: ${errorText(e)}` }
        : v
    );
    return;
  }
  update(path, (v) => (v.token === token ? { ...v, runs, loading: false } : v));
  if (get(runHistoryStore)[path]?.token === token) {
    await loadTokens(path, profileId, token);
  }
}

/// Read every run's cost, one request per DISTINCT conversation, in
/// parallel.
///
/// A run still going is re-read on every refresh: its transcript is
/// still growing, and a cached figure for the row somebody is watching
/// would be the one number on the panel that never moved. Finished runs
/// are read once -- the host caches on the file's mtime underneath, so
/// even a re-read is cheap, but not asking at all is cheaper.
async function loadTokens(path: string, profileId: string, token: number): Promise<void> {
  const view = get(runHistoryStore)[path];
  if (!view) return;
  const wanted = new Map<string, boolean>();
  for (const run of view.runs) {
    const id = run.conversationId;
    if (!id) continue;
    const live = run.outcome === "running";
    wanted.set(id, (wanted.get(id) ?? false) || live);
  }
  const pending = [...wanted.entries()].filter(([id, live]) => live || !view.tokens[id]).map(([id]) => id);
  if (pending.length === 0) return;

  update(path, (v) => (v.token === token ? { ...v, tokensLoading: pending } : v));
  await Promise.all(
    pending.map(async (conversationId) => {
      let report: TokenReport;
      try {
        report = await backend.cardRunTokens(profileId, conversationId);
      } catch (e) {
        // A failure to read a cost is a fact about that run, not about
        // the panel: it lands in the row's own slot rather than in the
        // strip that would blank the whole history.
        report = { kind: "unavailable", reason: `Couldn't read this run's tokens: ${errorText(e)}` };
      }
      update(path, (v) =>
        v.token === token
          ? {
              ...v,
              tokens: { ...v.tokens, [conversationId]: report },
              tokensLoading: v.tokensLoading.filter((id) => id !== conversationId),
            }
          : v
      );
    })
  );
}

/// This run's cost, by the conversation it belongs to. Null while it is
/// still being read, or for a run with no conversation id -- which the
/// panel renders as the sentence the report itself would have carried.
export function tokensForRun(view: RunHistoryView | undefined, run: CardRun): TokenReport | null {
  if (!view || !run.conversationId) return null;
  return view.tokens[run.conversationId] ?? null;
}

export function tokensPending(view: RunHistoryView | undefined, run: CardRun): boolean {
  if (!view || !run.conversationId) return false;
  return view.tokensLoading.includes(run.conversationId);
}

/// Drops a card's history. Called when the panel closes: the rows are
/// small, but the token reports are one per run and there is no reason
/// to hold them for a card nobody is looking at.
export function closeRunHistory(path: string): void {
  runHistoryStore.update((all) => {
    if (!all[path]) return all;
    const next = { ...all };
    delete next[path];
    return next;
  });
}
