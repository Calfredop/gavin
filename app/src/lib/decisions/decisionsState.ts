// Which row the Decisions tab has selected, and which pane its agent
// column is showing, per workspace.
//
// A module-level store rather than component `$state`, for `hubFacets`'
// reason: `+page.svelte` renders one hub view at a time and destroys the
// rest on every tab switch, so a selection that lived in the tab's own
// `$state` would forget itself the moment the human looked at the board
// and came back. Only one hub view is ever mounted, so nothing needs
// live cross-component wiring -- the tab simply reads the current store
// when it is next shown.
//
// Not persisted, unlike `reviewPrefs`: a Decisions row is a question
// that gets answered, so the selection is worth minutes rather than
// months, and a remembered id would come back on the next launch
// pointing at an item nobody is waiting for any more. The PANE is
// remembered for the session for the same reason reviewPrefs remembers
// its own -- it says how the human is reading, and that holds down the
// whole list.

import { writable } from "svelte/store";
import type { ReviewPane } from "$lib/review/reviewPrefs";

export interface DecisionsPrefs {
  /// A `DecisionSubject.id`, or null for "nothing chosen yet" -- which
  /// `resolveSelection` turns into the longest wait.
  selected: string | null;
  /// Which half of `ReviewAgentPane` is showing. Borrowed rather than
  /// redeclared: the pane is reused as-is, so its vocabulary is too.
  pane: ReviewPane;
}

function empty(): DecisionsPrefs {
  return { selected: null, pane: "session" };
}

export const decisionsPrefs = writable<Record<string, DecisionsPrefs>>({});

/// This workspace's row, defaulted. Takes the stored map directly
/// (typically `$decisionsPrefs`) so a component reads it inside its own
/// `$derived` rather than through a subscription this module would have
/// to manage.
export function prefsFor(
  all: Record<string, DecisionsPrefs>,
  workspaceId: string
): DecisionsPrefs {
  return all[workspaceId] ?? empty();
}

export function setDecisionsPrefs(workspaceId: string, patch: Partial<DecisionsPrefs>): void {
  decisionsPrefs.update((all) => ({
    ...all,
    [workspaceId]: { ...(all[workspaceId] ?? empty()), ...patch },
  }));
}
