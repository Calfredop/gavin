// The store behind the per-run Changes view: one entry per card path,
// fetched on demand and never on a timer.
//
// Demand-loaded on purpose. A fleet of agents is a fleet of checkouts,
// and a watcher (or worse, a poll) per running card would put a `git
// diff` behind every tab in the window. The view fetches when it opens,
// after a discard, and when the human presses Refresh -- the three
// moments somebody is actually looking.
//
// Supersession is guarded with a token counter rather than by comparing
// objects: Svelte 5's `$state` proxies everything it touches, so a
// stored value is never identity-equal to the one that was put in.

import { get, writable } from "svelte/store";
import * as backend from "./backend";
import type { FileDiff, RunChanges } from "./git";
import { untrackedPaths } from "./runChanges";

export interface RunChangesView {
  /// The run this view is of -- carried so a card whose binding was
  /// replaced under an open modal cannot render the old run's diff.
  cwd: string;
  baseSha: string;
  changes: RunChanges | null;
  loading: boolean;
  error: string | null;
  /// The selected file and its diff, from the same baseline.
  selected: string | null;
  diff: FileDiff | null;
  diffLoading: boolean;
  busy: boolean;
  token: number;
  diffToken: number;
}

export const runChangesStore = writable<Record<string, RunChangesView>>({});

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function update(path: string, fn: (view: RunChangesView) => RunChangesView): void {
  runChangesStore.update((all) => (all[path] ? { ...all, [path]: fn(all[path]) } : all));
}

export function viewFor(path: string): RunChangesView | undefined {
  return get(runChangesStore)[path];
}

/// Opens (or re-points) a card's view at a run and loads it. Re-pointing
/// drops everything the previous run had: a re-launch gives the card a
/// new baseline, and showing the old diff under the new sha would be a
/// view of a run that no longer exists.
export async function openRunChanges(path: string, cwd: string, baseSha: string): Promise<void> {
  const existing = get(runChangesStore)[path];
  const same = existing && existing.cwd === cwd && existing.baseSha === baseSha;
  runChangesStore.update((all) => ({
    ...all,
    [path]: {
      cwd,
      baseSha,
      changes: same ? existing.changes : null,
      loading: true,
      error: null,
      selected: same ? existing.selected : null,
      diff: same ? existing.diff : null,
      diffLoading: false,
      busy: false,
      token: (existing?.token ?? 0) + 1,
      diffToken: existing?.diffToken ?? 0,
    },
  }));
  await refreshRunChanges(path);
}

export async function refreshRunChanges(path: string): Promise<void> {
  const view = get(runChangesStore)[path];
  if (!view) return;
  const token = view.token + 1;
  update(path, (v) => ({ ...v, token, loading: true, error: null }));
  try {
    const changes = await backend.gitRunChanges(view.cwd, view.baseSha);
    update(path, (v) => (v.token === token ? { ...v, changes, loading: false } : v));
    // A selection that survived the refresh is re-read, because the
    // agent has almost certainly written to it since -- that is why
    // anyone pressed Refresh.
    const after = get(runChangesStore)[path];
    if (after?.token === token && after.selected) {
      await selectRunFile(path, after.selected);
    }
  } catch (e) {
    update(path, (v) =>
      v.token === token ? { ...v, loading: false, error: `Couldn't read this run's changes: ${errorText(e)}` } : v
    );
  }
}

export async function selectRunFile(path: string, file: string): Promise<void> {
  const view = get(runChangesStore)[path];
  if (!view) return;
  const entry = view.changes?.files.find((f) => f.path === file);
  if (!entry) return;
  const token = view.diffToken + 1;
  update(path, (v) => ({ ...v, selected: file, diffToken: token, diffLoading: true }));
  try {
    const diff = await backend.gitDiffSince(
      view.cwd,
      view.baseSha,
      entry.path,
      entry.oldPath ?? null,
      entry.status === "?"
    );
    update(path, (v) => (v.diffToken === token ? { ...v, diff, diffLoading: false } : v));
  } catch (e) {
    update(path, (v) =>
      v.diffToken === token
        ? { ...v, diff: null, diffLoading: false, error: `Couldn't read that file's diff: ${errorText(e)}` }
        : v
    );
  }
}

/// Resets the run's checkout to its baseline. Returns the report, or
/// null when it could not run at all -- the caller has already asked the
/// human, so a refusal here is a failure to report, not a decision.
///
/// The untracked list comes from the CHANGES the human was shown, never
/// from a fresh scan: what they agreed to remove is what was on screen,
/// and a file the agent created in between must survive to be asked
/// about on its own.
export async function discardRun(path: string): Promise<{ report: import("./git").DiscardReport } | { error: string }> {
  const view = get(runChangesStore)[path];
  if (!view?.changes) return { error: "This run's changes are not loaded." };
  const untracked = untrackedPaths(view.changes);
  update(path, (v) => ({ ...v, busy: true, error: null }));
  try {
    const report = await backend.gitDiscardRun(view.cwd, view.baseSha, untracked);
    update(path, (v) => ({ ...v, busy: false }));
    await refreshRunChanges(path);
    return { report };
  } catch (e) {
    const error = `Couldn't discard this run: ${errorText(e)}`;
    update(path, (v) => ({ ...v, busy: false, error }));
    return { error };
  }
}

/// Drops a card's view. Called when the modal closes, so a card the
/// human is no longer looking at holds no diff -- these are the largest
/// objects the app keeps per card.
export function closeRunChanges(path: string): void {
  runChangesStore.update((all) => {
    if (!all[path]) return all;
    const next = { ...all };
    delete next[path];
    return next;
  });
}
