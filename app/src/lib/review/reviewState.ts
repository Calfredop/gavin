// The Review tab's store: what each listed card or rail touched, and
// which file of the selected subject is on screen.
//
// Demand-loaded, like runChangesState.ts and for the same reason -- a
// `git diff` per subject is not something the app may do behind a tab
// nobody opened -- but with one difference that matters: this tab needs
// EVERY listed subject's files at once, because the grouping is the view
// (cards) and rails sit beside them in the same list. So the fetches are
// pooled rather than serialized, capped so a board with forty finished
// cards does not fork forty gits at once, and cached per (cwd, baseSha,
// peers) so re-opening the tab, flipping the archive toggle or typing in
// the search box costs nothing.
//
// A card's entry is keyed by its own baseline, not by a timestamp:
// re-launching a card gives it a new one, and that is exactly when the
// cached answer stops being about the run anybody is looking at. A
// rail's entry is keyed the same way, under `railSubjectId`, and its
// request carries empty peers so the combined worktree/branch window is
// not sliced by neighbouring card runs.
//
// Supersession is guarded with a token counter rather than by comparing
// objects: Svelte 5's `$state` proxies everything it touches, so a
// stored value is never identity-equal to the one that was put in.

import { get, writable } from "svelte/store";
import * as backend from "$lib/core/backend";
import type { FileDiff, RunChanges } from "$lib/git/git";
import { changesProblem } from "$lib/cards/runChanges";
import { isRailSubjectId, railReviewBaseline, railSubjectId } from "$lib/review/reviewBoard";
import { attributeRun } from "$lib/cards/changeAttributionState";

/// How many `git diff`s may be in flight at once. Four rather than one
/// because the tab is unusable until they all land, and rather than
/// unbounded because each one is a process: a workspace with forty
/// finished cards would otherwise fork forty at the moment the tab
/// opens, on the same machine that is running the agents.
export const FETCH_CONCURRENCY = 4;

/// One card's baseline, as the tab has to ask for it.
///
/// `peers` is every baseline recorded against the same checkout, which
/// is what bounds this run's window to its own slice -- see
/// `withBaselinePeers` and `next_baseline` in `runchanges.rs`. It is
/// part of the request and not a detail of the fetch because it is part
/// of the ANSWER: adding a card to the list can move where an older
/// card's window ends.
export interface TouchRequest {
  path: string;
  /// The card's title, for the attribution question the fetch goes on
  /// to ask. Not part of the cache key: a renamed card is the same run.
  title?: string;
  cwd: string;
  baseSha: string;
  peers: string[];
}

/// A rail's combined checkout diff as a `TouchRequest`, or null when
/// neither a worktree fork point nor any step baseSha is known.
///
/// Peers are always empty: a rail subject is the whole worktree/branch
/// since its baseline, not a slice bounded by other runs. Card requests
/// still go through `withBaselinePeers`; mixing a rail's sha into that
/// set would bound every card in the same cwd against the rail's fork
/// and mis-report their windows.
export function railTouchRequest(options: {
  railId: string;
  cwd: string;
  worktreeForkPoint?: string | null;
  stepBaseShas?: readonly (string | null | undefined)[];
}): TouchRequest | null {
  const baseSha = railReviewBaseline({
    worktreeForkPoint: options.worktreeForkPoint,
    stepBaseShas: options.stepBaseShas,
  });
  if (!baseSha) return null;
  return {
    path: railSubjectId(options.railId),
    cwd: options.cwd,
    baseSha,
    peers: [],
  };
}

/// What this tab knows about one card's run.
///
/// `files` is null whenever the answer is "nobody measured this" --
/// there was no baseline, or there was one and the checkout can no
/// longer be diffed against it. `problem` carries the sentence for the
/// second case. Never an empty array standing in for either: an empty
/// array means the run was measured and moved nothing.
export interface TouchedRun {
  cwd: string;
  baseSha: string;
  /// The peer baseline the window stopped at, or null when it ran to the
  /// worktree. Kept so a file's diff is taken under the same bound as
  /// the row that opened it.
  untilSha: string | null;
  peers: string[];
  changes: RunChanges | null;
  files: string[] | null;
  problem: string | null;
  error: string | null;
}

export interface ReviewView {
  /// Per card path.
  runs: Record<string, TouchedRun>;
  /// Card paths whose diff is in flight, so the list can say "reading"
  /// rather than show a card as fileless while it is still being asked
  /// about.
  loadingPaths: string[];
  /// The selected card's selected file, and its diff against that
  /// card's baseline.
  selectedFile: string | null;
  diff: FileDiff | null;
  diffLoading: boolean;
  diffError: string | null;
  token: number;
  diffToken: number;
}

function emptyView(): ReviewView {
  return {
    runs: {},
    loadingPaths: [],
    selectedFile: null,
    diff: null,
    diffLoading: false,
    diffError: null,
    token: 0,
    diffToken: 0,
  };
}

export const reviewStore = writable<Record<string, ReviewView>>({});

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function update(workspaceId: string, fn: (view: ReviewView) => ReviewView): void {
  reviewStore.update((all) => ({ ...all, [workspaceId]: fn(all[workspaceId] ?? emptyView()) }));
}

export function viewFor(workspaceId: string): ReviewView {
  return get(reviewStore)[workspaceId] ?? emptyView();
}

/// Whether a cached answer still stands for this request. The baseline
/// AND the checkout, because a card re-launched somewhere else keeps
/// neither.
function cached(view: ReviewView, request: TouchRequest): boolean {
  const run = view.runs[request.path];
  return (
    run !== undefined &&
    run.cwd === request.cwd &&
    run.baseSha === request.baseSha &&
    // The peers too: they decide where the window ends, so a card
    // filed into the list beside this one makes the stored answer
    // about a window that no longer exists.
    run.peers.join("\n") === request.peers.join("\n")
  );
}

async function fetchOne(workspaceId: string, request: TouchRequest, token: number): Promise<void> {
  try {
    const changes = await backend.gitRunChanges(request.cwd, request.baseSha, request.peers);
    const problem = changesProblem(changes);
    store(workspaceId, request, token, {
      cwd: request.cwd,
      baseSha: request.baseSha,
      untilSha: changes.untilSha,
      peers: request.peers,
      changes,
      // A checkout that cannot be diffed against this baseline has NOT
      // been measured, so its files are null and not `[]`. Reporting it
      // as a card that touched nothing is the one misreading this whole
      // tab has to avoid.
      files: problem ? null : changes.files.map((f) => f.path),
      problem,
      error: null,
    });
    // The hint beside the files: which card each one looks like, when
    // another card ran in this checkout and the switch is on. Cards
    // only -- a rail is one checkout as a whole and has no co-tenant
    // question. Fire-and-forget into its own store; the grouper reads
    // it through `ownersOf`, and a failure there is today's grouping.
    if (!problem && !isRailSubjectId(request.path)) {
      void attributeRun({
        cardPath: request.path,
        cardTitle: request.title ?? request.path.slice(request.path.lastIndexOf("/") + 1),
        cwd: request.cwd,
        changes,
      });
    }
  } catch (e) {
    const whose = isRailSubjectId(request.path) ? "rail's" : "card's";
    store(workspaceId, request, token, {
      cwd: request.cwd,
      baseSha: request.baseSha,
      untilSha: null,
      peers: request.peers,
      changes: null,
      files: null,
      problem: null,
      error: `Couldn't read this ${whose} changes: ${errorText(e)}`,
    });
  }
}

function store(workspaceId: string, request: TouchRequest, token: number, run: TouchedRun): void {
  update(workspaceId, (v) =>
    v.token === token
      ? {
          ...v,
          runs: { ...v.runs, [request.path]: run },
          loadingPaths: v.loadingPaths.filter((p) => p !== request.path),
        }
      : v
  );
}

/// Loads the touched files for every card the tab lists.
///
/// Cached entries are skipped, so this is safe to call on every list
/// change -- which is what the tab does: the candidate set moves when
/// the human types, flips the archive toggle, or a card is filed
/// somewhere else in the app.
///
/// `force` re-reads everything, which is what the Refresh button is:
/// these diffs are of a live checkout and go stale the moment anything
/// else in the fleet writes to it.
export async function loadTouchedFiles(
  workspaceId: string,
  requests: TouchRequest[],
  options: { force?: boolean } = {}
): Promise<void> {
  const before = viewFor(workspaceId);
  const wanted = options.force ? requests : requests.filter((r) => !cached(before, r));
  if (wanted.length === 0) return;

  // A single token for the whole batch: the answers are only ever read
  // together, and a per-request token would let half of one batch and
  // half of the next end up on screen at once.
  const token = before.token + 1;
  update(workspaceId, (v) => ({
    ...v,
    token,
    // What this batch wants, and NOT a union with what was already
    // loading. Bumping the token abandons every worker of the previous
    // batch: a path it had not reached is no longer being read by
    // anyone, and a path it did reach has its answer dropped by `store`.
    // Carrying those forward left the list saying "reading…" about cards
    // nothing would ever answer for -- and, through the `loading` flag
    // the tab derives from this, a Refresh button dark for the rest of
    // the session. Anything still genuinely wanted is in `wanted`,
    // because an entry is only skipped when it is already STORED.
    loadingPaths: wanted.map((r) => r.path),
  }));

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= wanted.length) return;
      // Re-checked inside the loop, not only at the top: a superseded
      // batch must stop forking gits, not merely stop storing them.
      if (viewFor(workspaceId).token !== token) return;
      await fetchOne(workspaceId, wanted[index], token);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, wanted.length) }, () => worker())
  );
}

/// Reads one file of the selected card, against that card's baseline.
///
/// Takes the run explicitly rather than looking up "the selected card":
/// the caller has already resolved which card is selected, and a second
/// answer to that question here is how a diff from one card ends up
/// under another's name.
export async function selectReviewFile(
  workspaceId: string,
  run: TouchedRun,
  file: string
): Promise<void> {
  const entry = run.changes?.files.find((f) => f.path === file);
  if (!entry) return;
  const token = viewFor(workspaceId).diffToken + 1;
  update(workspaceId, (v) => ({
    ...v,
    selectedFile: file,
    diffToken: token,
    diffLoading: true,
    diffError: null,
  }));
  try {
    const diff = await backend.gitDiffSince(
      run.cwd,
      run.baseSha,
      entry.path,
      entry.oldPath ?? null,
      entry.status === "?",
      run.untilSha
    );
    update(workspaceId, (v) => (v.diffToken === token ? { ...v, diff, diffLoading: false } : v));
  } catch (e) {
    update(workspaceId, (v) =>
      v.diffToken === token
        ? { ...v, diff: null, diffLoading: false, diffError: `Couldn't read that file's diff: ${errorText(e)}` }
        : v
    );
  }
}

/// Drops the selected file -- what changing the selected card does, and
/// what the tab does on its way out. The diff belongs to the card it was
/// read from, and leaving it up beside another card's name would be
/// somebody else's work under this card's heading.
///
/// The touched-file cache deliberately SURVIVES this. The hub destroys a
/// view on every tab switch (the trap conflictsBox.ts documents), and a
/// glance at the board would otherwise cost forty `git diff`s on the way
/// back; the diff is the one large object worth dropping.
export function clearReviewFile(workspaceId: string): void {
  update(workspaceId, (v) => ({
    ...v,
    selectedFile: null,
    diff: null,
    diffLoading: false,
    diffError: null,
    diffToken: v.diffToken + 1,
  }));
}
