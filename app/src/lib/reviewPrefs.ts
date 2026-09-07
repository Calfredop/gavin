// What the Review tab remembers per workspace: which columns it treats
// as "up for review", whether the archive is folded in, whether the card
// list is collapsed to a rail, and which card was selected.
//
// localStorage, for the reason hubTabPrefs.ts and sidebarPrefs.ts spell
// out at length: these are per-human VIEW preferences -- which parts of
// the board this screen watches and how wide its columns are -- not
// facts about any project. No daemon request, so no protocol bump and no
// compat gate; and not config.json, whose every field is a
// carry-through a dozen Tauri commands must each hand back to `save`.
//
// Per workspace and never inheriting, unlike hub tab HIDING. Which
// columns are "review" is a property of one board's column names, and
// two workspaces rarely spell them the same way -- a shared default
// would be right only by coincidence, and wrong silently.

import { get, writable } from "svelte/store";

/// Injected (defaulting to the browser's) for the same two reasons every
/// other prefs module injects it: vitest's node environment has no
/// localStorage at all, and an SSR pass has none either -- both must
/// remember nothing rather than throw.
type MaybeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;

function defaultStorage(): MaybeStorage {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

export const REVIEW_PREFS_KEY = "gavin.reviewTab";

/// One workspace's Review tab.
///
/// `columns` is null when the human has never chosen, which is NOT the
/// same as an empty list: null inherits the done-column default
/// (`resolveReviewColumns`), and `[]` would be a deliberate "review
/// nothing". The picker never writes `[]` -- unticking the last column
/// clears the choice back to null -- but the shape has to be able to
/// tell them apart or a stored choice could never be undone.
export interface ReviewPrefs {
  columns: string[] | null;
  includeArchived: boolean;
  listCollapsed: boolean;
  /// The search box.
  ///
  /// Persisted, unlike the board's search, for the trap conflictsBox.ts
  /// documents: the hub DESTROYS a view on every tab switch, so a query
  /// held in the component would be lost every time the human glanced at
  /// the board. It is safe to persist because it is never hidden -- the
  /// box shows the text and carries its own clear button -- which is the
  /// property a remembered filter has to have.
  query: string;
  /// The selected card's path. Verified against the list it is restored
  /// into (`resolveSelection`), never trusted: a card filed, archived or
  /// deleted between two sessions is the normal case here.
  selected: string | null;
  /// What the first column shows: the card's agent, or the card itself.
  ///
  /// Remembered rather than reset per card, which is where this parts
  /// company with ReviewFilePane's diff/edit switch. That one is a
  /// question about the file in front of you, so landing in Edit on a
  /// file you have not read is an invitation to type into it by
  /// accident. This one is a question about how you are reading the
  /// board -- watching agents work, or reading what they were asked for
  /// -- and it holds for the whole pass down the list. Re-answering it
  /// on every card would be answering it forty times.
  pane: ReviewPane;
}

/// The first column's two answers. A union rather than a boolean so the
/// stored value says what it means and a third view could be added
/// without rewriting every read of it.
export type ReviewPane = "session" | "plan";

const REVIEW_PANES: ReviewPane[] = ["session", "plan"];

export const DEFAULT_REVIEW_PREFS: ReviewPrefs = {
  columns: null,
  includeArchived: false,
  listCollapsed: false,
  query: "",
  selected: null,
  pane: "session",
};

function readJson(storage: MaybeStorage, key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    // Absent, corrupt, hand-edited, or a storage that refuses to be
    // read: forgetting is the only acceptable failure mode for a view
    // preference.
    return null;
  }
}

function writeJson(storage: MaybeStorage, key: string, value: unknown): void {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Best-effort: a full or blocked storage must never break the tab.
  }
}

function normalizeStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry === "" || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/// One stored entry, with every field it did not supply filled from the
/// default. Deliberately tolerant: a record written by an older gavin,
/// or hand-edited, gives back what it can rather than nothing.
export function normalizeReviewPrefs(value: unknown): ReviewPrefs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...DEFAULT_REVIEW_PREFS };
  }
  const raw = value as Record<string, unknown>;
  return {
    columns: normalizeStrings(raw.columns),
    includeArchived: raw.includeArchived === true,
    listCollapsed: raw.listCollapsed === true,
    query: typeof raw.query === "string" ? raw.query : "",
    selected: typeof raw.selected === "string" && raw.selected !== "" ? raw.selected : null,
    pane: REVIEW_PANES.includes(raw.pane as ReviewPane)
      ? (raw.pane as ReviewPane)
      : DEFAULT_REVIEW_PREFS.pane,
  };
}

export function loadReviewPrefs(
  storage: MaybeStorage = defaultStorage()
): Record<string, ReviewPrefs> {
  const parsed = readJson(storage, REVIEW_PREFS_KEY);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, ReviewPrefs> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    out[id] = normalizeReviewPrefs(value);
  }
  return out;
}

/// Workspace ids that no longer exist are dropped on the next write, as
/// the sidebar's expansion records are: ids are uuids, so a removed
/// workspace's entry can never match again and would otherwise grow for
/// the life of the install.
export function pruneReviewPrefs(
  record: Record<string, ReviewPrefs>,
  knownIds: Iterable<string>
): Record<string, ReviewPrefs> {
  const known = new Set(knownIds);
  const kept: Record<string, ReviewPrefs> = {};
  for (const [id, prefs] of Object.entries(record)) {
    if (known.has(id)) kept[id] = prefs;
  }
  return kept;
}

/// An entry with nothing in it is not written. A record full of
/// all-default entries is a record that says nothing, and pruning it on
/// write is what keeps opening the tab in ten workspaces from leaving
/// ten entries behind.
function isDefault(prefs: ReviewPrefs): boolean {
  return (
    prefs.columns === null &&
    !prefs.includeArchived &&
    !prefs.listCollapsed &&
    prefs.query === "" &&
    prefs.selected === null &&
    prefs.pane === DEFAULT_REVIEW_PREFS.pane
  );
}

export function saveReviewPrefs(
  record: Record<string, ReviewPrefs>,
  storage: MaybeStorage = defaultStorage()
): void {
  const kept: Record<string, ReviewPrefs> = {};
  for (const [id, prefs] of Object.entries(record)) {
    if (!isDefault(prefs)) kept[id] = prefs;
  }
  writeJson(storage, REVIEW_PREFS_KEY, Object.keys(kept).length > 0 ? kept : null);
}

/// Ticking a column on or off in the picker.
///
/// The list is written as the human's own choice -- including the case
/// where they tick every column -- with one exception: unticking the
/// LAST one clears the choice back to null rather than storing an empty
/// list. A tab that lists nothing at all is not a state the picker
/// should be able to reach by clicking; `resolveReviewColumns` then
/// answers with the done column, which is where the human started.
export function toggleReviewColumn(
  columns: string[] | null,
  defaults: string[],
  id: string
): string[] | null {
  const current = columns ?? defaults;
  const next = current.includes(id) ? current.filter((c) => c !== id) : [...current, id];
  return next.length === 0 ? null : next;
}

// ---- The store ---------------------------------------------------------------

/// Read by the tab and written by four controls in it, so it is a store
/// rather than component state -- and the hub DESTROYS a view on every
/// tab switch (the trap conflictsBox.ts documents), so anything held in
/// the component would reset every time the human looked at the board.
/// Seeded from storage at module load, which is also what restores it
/// across a hot module swap.
export const reviewPrefs = writable<Record<string, ReviewPrefs>>(loadReviewPrefs());

export function prefsFor(workspaceId: string): ReviewPrefs {
  return get(reviewPrefs)[workspaceId] ?? { ...DEFAULT_REVIEW_PREFS };
}

export function setReviewPrefs(workspaceId: string, patch: Partial<ReviewPrefs>): void {
  reviewPrefs.update((all) => {
    const next = { ...all, [workspaceId]: { ...(all[workspaceId] ?? DEFAULT_REVIEW_PREFS), ...patch } };
    saveReviewPrefs(next);
    return next;
  });
}

/// Called with the workspaces that still exist, when the app knows them.
export function pruneReviewPrefsFor(knownIds: Iterable<string>): void {
  reviewPrefs.update((all) => {
    const kept = pruneReviewPrefs(all, knownIds);
    saveReviewPrefs(kept);
    return kept;
  });
}
