// Where a best-of-N run is remembered between the launch and the pick.
//
// The record is machine-local state about machine-local things: three
// folders under `.gavin-worktrees` and the sessions running in them --
// ignored by git, so no commit carries them. It is not workspace
// data -- nobody else's checkout has those folders -- and it is not
// daemon data, because putting it there would cost a protocol bump and a
// compat gate for a feature that needs neither. So: localStorage per
// workspace, the same place the orchestration conflicts box and the
// Plans tab's selection live.
//
// The worst thing losing this record can do is leave the human to clean
// three folders up by hand, which the worktree sweep already offers.
// That is what makes localStorage the right size of promise -- and why
// every read here forgives absence, corruption and a storage that
// refuses to answer, rather than surfacing any of them.
//
// One thing this module deliberately will NOT do is drop a candidate
// whose session has gone. A closed tab is not a cleaned-up worktree:
// forgetting the candidate would leave its folder and its branch behind
// with nothing in the app still pointing at them. Liveness is reported
// (`candidateLiveness`) so the UI can grey a dead candidate out; the
// record keeps it until the run is picked or discarded.

import { get, writable } from "svelte/store";
import type { BestOfNRun, RunCandidate } from "$lib/cards/bestOfN";
import type { CardView } from "$lib/core/planBoard";

/// Storage is injected (defaulting to the browser's) so this module stays
/// testable under vitest's node environment, where localStorage does not
/// exist at all.
type MaybeStorage = Pick<Storage, "getItem" | "setItem"> | undefined;

function defaultStorage(): MaybeStorage {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

export function runsStorageKey(workspaceId: string): string {
  return `gavin.bestOfNRuns.${workspaceId}`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseCandidate(raw: unknown): RunCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const sessionId = str(c.sessionId);
  const worktreePath = str(c.worktreePath);
  // Those two are the whole point of the record: an entry with no
  // session cannot be picked and an entry with no folder cannot be
  // cleaned up, so either missing makes the entry a liability rather
  // than a partial record worth keeping.
  if (!sessionId || !worktreePath) return null;
  return {
    sessionId,
    worktreePath,
    label: str(c.label) || str(c.profileId) || "agent",
    profileId: str(c.profileId),
    model: str(c.model),
    branch: str(c.branch),
    command: str(c.command),
    // Absent and empty both mean "no conversation to reopen", which is
    // also what a profile with no verified `--session-id` argv produces.
    conversationId: str(c.conversationId) || null,
  };
}

/// Every run this blob holds, with anything unreadable dropped. Pure and
/// exported because it is the half worth testing: the input is a string
/// a human can edit, an older gavin can have written, or a half-finished
/// write can have truncated.
export function parseRuns(raw: string | null | undefined): BestOfNRun[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const runs: BestOfNRun[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const cardPath = str(r.cardPath);
    if (!cardPath) continue;
    const candidates = Array.isArray(r.candidates)
      ? r.candidates.map(parseCandidate).filter((c): c is RunCandidate => c !== null)
      : [];
    // A run with no candidates left names nothing to show and nothing to
    // clean up. Dropping it is the one deletion this module does on its
    // own, and it destroys nothing.
    if (candidates.length === 0) continue;
    runs.push({
      cardPath,
      cardTitle: str(r.cardTitle),
      pageId: str(r.pageId),
      startedAt: typeof r.startedAt === "number" ? r.startedAt : 0,
      candidates,
    });
  }
  return runs;
}

export function loadRuns(workspaceId: string, storage: MaybeStorage = defaultStorage()): BestOfNRun[] {
  try {
    return parseRuns(storage?.getItem(runsStorageKey(workspaceId)));
  } catch {
    return [];
  }
}

export function saveRuns(
  workspaceId: string,
  runs: readonly BestOfNRun[],
  storage: MaybeStorage = defaultStorage()
): void {
  try {
    storage?.setItem(runsStorageKey(workspaceId), JSON.stringify(runs));
  } catch {
    // Best-effort: a full or blocked storage must never break a launch
    // that has already spawned real sessions.
  }
}

/// The runs in flight, per workspace. A store rather than a read of
/// localStorage per render: the card modal, the tab menu and the board
/// all ask, and three components each parsing the same blob would drift
/// the moment one of them cached it.
export const bestOfNRuns = writable<Record<string, BestOfNRun[]>>({});

/// Fill the store for a workspace from what was persisted. Idempotent,
/// so a component may call it on mount without checking.
export function hydrateRuns(workspaceId: string, storage: MaybeStorage = defaultStorage()): void {
  const runs = loadRuns(workspaceId, storage);
  bestOfNRuns.update((all) => ({ ...all, [workspaceId]: runs }));
}

/// Store and persist together, always: the store is what the UI reads
/// and localStorage is what survives the reload, and a helper that
/// updated one without the other is how a run comes back from a reload
/// missing a candidate the human can see on screen.
export function putRun(
  workspaceId: string,
  run: BestOfNRun,
  storage: MaybeStorage = defaultStorage()
): void {
  const existing = get(bestOfNRuns)[workspaceId] ?? loadRuns(workspaceId, storage);
  // Keyed by card: a second run on the same card REPLACES the first,
  // because the card can only have one set of candidates on screen and
  // the old record's folders were dealt with before this launch.
  const runs = [...existing.filter((r) => r.cardPath !== run.cardPath), run];
  bestOfNRuns.update((all) => ({ ...all, [workspaceId]: runs }));
  saveRuns(workspaceId, runs, storage);
}

export function dropRun(
  workspaceId: string,
  cardPath: string,
  storage: MaybeStorage = defaultStorage()
): void {
  const existing = get(bestOfNRuns)[workspaceId] ?? loadRuns(workspaceId, storage);
  const runs = existing.filter((r) => r.cardPath !== cardPath);
  bestOfNRuns.update((all) => ({ ...all, [workspaceId]: runs }));
  saveRuns(workspaceId, runs, storage);
}

/// The run a card is under, or null. Pure over the list so the surfaces
/// can pass whatever they already hold.
export function runForCard(runs: readonly BestOfNRun[] | undefined, cardPath: string): BestOfNRun | null {
  return runs?.find((r) => r.cardPath === cardPath) ?? null;
}

/// The run a SESSION belongs to, with the candidate it is. What the tab
/// menu needs: it has a session id and nothing else, and "this tab is
/// candidate 2 of 3 on the auth card" is the whole reason it can offer
/// a pick at all.
export function runForSession(
  runs: readonly BestOfNRun[] | undefined,
  sessionId: string
): { run: BestOfNRun; candidate: RunCandidate } | null {
  for (const run of runs ?? []) {
    const candidate = run.candidates.find((c) => c.sessionId === sessionId);
    if (candidate) return { run, candidate };
  }
  return null;
}

/// Which candidates still have a session, in the run's own order. Never
/// used to prune the record (see the header): a dead candidate still
/// owns a folder, and the panel that says so is the only thing left
/// pointing at it.
export function candidateLiveness(
  run: BestOfNRun,
  liveSessionIds: ReadonlySet<string>
): { candidate: RunCandidate; live: boolean }[] {
  return run.candidates.map((candidate) => ({
    candidate,
    live: liveSessionIds.has(candidate.sessionId),
  }));
}

/// How a run reads at a glance: "3 running", "1 running · 2 stopped".
/// One phrase rather than two numbers, because the panel that shows it
/// has one line to say what is happening.
export function runSummary(run: BestOfNRun, liveSessionIds: ReadonlySet<string>): string {
  const live = run.candidates.filter((c) => liveSessionIds.has(c.sessionId)).length;
  const stopped = run.candidates.length - live;
  if (stopped === 0) return `${live} running`;
  if (live === 0) return `${stopped} stopped`;
  return `${live} running · ${stopped} stopped`;
}

/// The card a best-of-N dialog has been asked for, or null.
///
/// A store rather than a hook on every board surface: three components
/// build the card context menu (the hub board, the in-page board, the
/// orchestration tab), and a modal mounted in each of them would be
/// three copies of the same dialog whose lifetime is tied to whichever
/// board happens to still be rendered. `+page.svelte` mounts it once,
/// beside the workspace wizard, for the same reason that one does.
export const bestOfNRequest = writable<{ workspaceId: string; card: CardView } | null>(null);

/// The same lookup across every workspace, for a surface that has a
/// session id and nothing else -- the pane tab menu, which is built from
/// a tab and does not know which workspace it belongs to. Safe because
/// session ids are minted by the daemon and unique across the app.
export function runForSessionAnywhere(
  all: Record<string, BestOfNRun[]>,
  sessionId: string
): { workspaceId: string; run: BestOfNRun; candidate: RunCandidate } | null {
  for (const [workspaceId, runs] of Object.entries(all)) {
    const hit = runForSession(runs, sessionId);
    if (hit) return { workspaceId, ...hit };
  }
  return null;
}
