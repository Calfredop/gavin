// The Review tab's store: what each listed card touched, and which file
// of the selected card is on screen.
//
// Demand-loaded, like runChangesState.ts and for the same reason -- a
// `git diff` per card is not something the app may do behind a tab
// nobody opened -- but with one difference that matters: this tab needs
// EVERY listed card's files at once, because the grouping is the view.
// So the fetches are pooled rather than serialized, capped so a board
// with forty finished cards does not fork forty gits at once, and cached
// per (cwd, baseSha) so re-opening the tab, flipping the archive toggle
// or typing in the search box costs nothing.
//
// A card's entry is keyed by its own baseline, not by a timestamp:
// re-launching a card gives it a new one, and that is exactly when the
// cached answer stops being about the run anybody is looking at.
//
// Supersession is guarded with a token counter rather than by comparing
// objects: Svelte 5's `$state` proxies everything it touches, so a
// stored value is never identity-equal to the one that was put in.

import { get, writable } from "svelte/store";
import * as backend from "./backend";
import type { FileDiff, RunChanges } from "./git";
import { changesProblem } from "./runChanges";

/// How many `git diff`s may be in flight at once. Four rather than one
/// because the tab is unusable until they all land, and rather than
/// unbounded because each one is a process: a workspace with forty
/// finished cards would otherwise fork forty at the moment the tab
/// opens, on the same machine that is running the agents.
export const FETCH_CONCURRENCY = 4;

/// One card's baseline, as the tab has to ask for it.
export interface TouchRequest {
  path: string;
  cwd: string;
  baseSha: string;
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
  return run !== undefined && run.cwd === request.cwd && run.baseSha === request.baseSha;
}

async function fetchOne(workspaceId: string, request: TouchRequest, token: number): Promise<void> {
  try {
    const changes = await backend.gitRunChanges(request.cwd, request.baseSha);
    const problem = changesProblem(changes);
    store(workspaceId, request, token, {
      cwd: request.cwd,
      baseSha: request.baseSha,
      changes,
      // A checkout that cannot be diffed against this baseline has NOT
      // been measured, so its files are null and not `[]`. Reporting it
      // as a card that touched nothing is the one misreading this whole
      // tab has to avoid.
      files: problem ? null : changes.files.map((f) => f.path),
      problem,
      error: null,
    });
  } catch (e) {
    store(workspaceId, request, token, {
      cwd: request.cwd,
      baseSha: request.baseSha,
      changes: null,
      files: null,
      problem: null,
      error: `Couldn't read this card's changes: ${errorText(e)}`,
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
      entry.status === "?"
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
