// Which sidebar rows are open: the workspaces showing their page list,
// and the pages showing their tab list.
//
// Both used to be plain component state, and `+page.svelte` mounts the
// sidebar only while the layout is `ready` -- so a reload, a hot module
// swap, or a daemon reconnect destroyed the tree and every row snapped
// shut. Re-opening four workspaces and the two pages you were actually
// working in, several times a day, is exactly the kind of state the
// human should never be asked to restate.
//
// This is a per-human view preference rather than workspace data -- what
// is unfolded on this screen is not a fact about the project -- so it
// goes where the orchestration conflicts box and the Plans tab's
// selection already live: localStorage. No
// daemon request, so no protocol bump and no compat gate.

/// Storage is injected (defaulting to the browser's) so this module stays
/// testable under vitest's node environment, where localStorage does not
/// exist at all -- and so an SSR pass, which has no storage either,
/// simply remembers nothing instead of throwing.
type MaybeStorage = Pick<Storage, "getItem" | "setItem"> | undefined;

function defaultStorage(): MaybeStorage {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

/// App-wide, not per workspace: the sidebar lists every workspace at
/// once, and both ids are globally unique (workspace ids and page ids are
/// uuids), so one key each is enough.
export const WORKSPACE_EXPANSION_KEY = "gavin.sidebarExpandedWorkspaces";
export const PAGE_EXPANSION_KEY = "gavin.sidebarExpandedPages";

/// Workspaces are tri-state, and the third state is the point: `true`
/// expanded, `false` collapsed, ABSENT never answered. The sidebar
/// auto-expands a workspace the first time it becomes active, and that
/// courtesy must not outlive the human's first answer -- with a plain set
/// of open ids, a deliberate collapse of the active workspace would read
/// as "not open yet" on the next mount and be undone immediately.
export type WorkspaceExpansion = Record<string, boolean>;

/// Ids of workspaces and pages that still exist. Everything else is
/// dropped on the next write: ids are uuids, so a closed page's entry can
/// never match anything again, and without this the record grows for the
/// life of the install.
export type KnownIds = Iterable<string>;

export function pruneWorkspaceExpansion(
  answers: WorkspaceExpansion,
  knownIds: KnownIds
): WorkspaceExpansion {
  const known = new Set(knownIds);
  const kept: WorkspaceExpansion = {};
  for (const [id, open] of Object.entries(answers)) {
    if (known.has(id)) kept[id] = open;
  }
  return kept;
}

export function pruneExpandedPages(pageIds: Iterable<string>, knownIds: KnownIds): string[] {
  const known = new Set(knownIds);
  return [...new Set(pageIds)].filter((id) => known.has(id));
}

/// Anything but a well-formed record reads as nothing remembered --
/// absent, corrupt, hand-edited, or a storage that refuses to be read.
/// Forgetting is the only acceptable failure mode for a view preference.
/// Non-boolean values are dropped rather than coerced, so a stray entry
/// leaves that workspace unanswered (and therefore still eligible for the
/// first-activation auto-expand) instead of pinning it open.
export function loadWorkspaceExpansion(
  storage: MaybeStorage = defaultStorage()
): WorkspaceExpansion {
  try {
    const raw = storage?.getItem(WORKSPACE_EXPANSION_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const answers: WorkspaceExpansion = {};
    for (const [id, open] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof open === "boolean") answers[id] = open;
    }
    return answers;
  } catch {
    return {};
  }
}

export function saveWorkspaceExpansion(
  answers: WorkspaceExpansion,
  knownIds: KnownIds,
  storage: MaybeStorage = defaultStorage()
): void {
  try {
    storage?.setItem(
      WORKSPACE_EXPANSION_KEY,
      JSON.stringify(pruneWorkspaceExpansion(answers, knownIds))
    );
  } catch {
    // Best-effort: a full or blocked storage must never break the sidebar.
  }
}

/// Pages get a plain list of the open ones, not the workspaces' tri-state:
/// nothing ever auto-expands a page, so "absent" and "collapsed" are the
/// same answer and there is no third state to record.
export function loadExpandedPages(storage: MaybeStorage = defaultStorage()): Set<string> {
  try {
    const raw = storage?.getItem(PAGE_EXPANSION_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string" && id !== ""));
  } catch {
    return new Set();
  }
}

export function saveExpandedPages(
  pageIds: Iterable<string>,
  knownIds: KnownIds,
  storage: MaybeStorage = defaultStorage()
): void {
  try {
    storage?.setItem(PAGE_EXPANSION_KEY, JSON.stringify(pruneExpandedPages(pageIds, knownIds)));
  } catch {
    // Best-effort, as above.
  }
}
