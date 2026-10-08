// Which row the Decisions tab has selected, which pane its agent column
// is showing, and what its search and status filter narrow the list to,
// per workspace.
//
// A module-level store rather than component `$state`, for `hubFacets`'
// reason: `+page.svelte` renders one hub view at a time and destroys the
// rest on every tab switch, so a selection that lived in the tab's own
// `$state` would forget itself the moment the human looked at the board
// and came back. Only one hub view is ever mounted, so nothing needs
// live cross-component wiring -- the tab simply reads the current store
// when it is next shown.
//
// The search and status filter ARE persisted across restarts (they show
// in the list's header and have a clear button); the rest is not, unlike
// `reviewPrefs`: a Decisions row is a question
// that gets answered, so the selection is worth minutes rather than
// months, and a remembered id would come back on the next launch
// pointing at an item nobody is waiting for any more. The PANE is
// remembered for the session for the same reason reviewPrefs remembers
// its own -- it says how the human is reading, and that holds down the
// whole list.

import { writable } from "svelte/store";
import type { ReviewPane } from "$lib/review/reviewPrefs";
import { HUB_DECISIONS_FILTER_KEY, isStringArray, loadRecord, mirrorRecord } from "$lib/hub/hubFilterStorage";

export interface DecisionsPrefs {
  /// A `DecisionSubject.id`, or null for "nothing chosen yet" -- which
  /// `resolveSelection` turns into the longest wait.
  selected: string | null;
  /// Which half of `ReviewAgentPane` is showing. Borrowed rather than
  /// redeclared: the pane is reused as-is, so its vocabulary is too.
  pane: ReviewPane;
  /// The list's search box.
  query: string;
  /// The status keys the list is narrowed to (decisions.ts's
  /// `subjectStatusKey`); empty shows every status.
  statuses: string[];
  /// Whether the status picker is open.
  statusPickerOpen: boolean;
}

function empty(): DecisionsPrefs {
  return { selected: null, pane: "session", query: "", statuses: [], statusPickerOpen: false };
}

function reviveFilter(value: unknown): DecisionsPrefs | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  return {
    ...empty(),
    query: typeof v.query === "string" ? v.query : "",
    statuses: isStringArray(v.statuses) ? v.statuses : [],
  };
}

export const decisionsPrefs = writable<Record<string, DecisionsPrefs>>(
  loadRecord(HUB_DECISIONS_FILTER_KEY, reviveFilter)
);

mirrorRecord(decisionsPrefs, HUB_DECISIONS_FILTER_KEY, (p) =>
  p.query === "" && p.statuses.length === 0 ? null : { query: p.query, statuses: p.statuses }
);

/// This workspace's row, defaulted. Takes the stored map directly
/// (typically `$decisionsPrefs`) so a component reads it inside its own
/// `$derived` rather than through a subscription this module would have
/// to manage.
export function prefsFor(
  all: Record<string, DecisionsPrefs>,
  workspaceId: string
): DecisionsPrefs {
  // Merged over the defaults rather than returned as stored, so a
  // record written before a field existed still reads whole.
  return { ...empty(), ...all[workspaceId] };
}

export function setDecisionsPrefs(workspaceId: string, patch: Partial<DecisionsPrefs>): void {
  decisionsPrefs.update((all) => ({
    ...all,
    [workspaceId]: { ...(all[workspaceId] ?? empty()), ...patch },
  }));
}
