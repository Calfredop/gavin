// The top bar's "next" button: the sessions in THIS workspace that are
// waiting on a human, one click from anywhere in it.
// NextWaitingButton.svelte is a thin template over this.
//
// Workspace-bound the way New page is. The button sits on the workspace's
// own rows -- the hub tab row and a terminal page's actions row -- and
// everything on those rows acts on the workspace they belong to. A list
// that reached into other workspaces would make the one control on the
// row that yanks you out of the workspace you are working in; the whole
// fleet's waits already have a place, the app hub's inbox.
//
// It lists that inbox (attentionInbox.ts), narrowed to this workspace
// and in the inbox's own order, rather than a list of its own making.
// The hub and this menu are two doors onto one question, so a session
// the hub lists under this workspace has to be one this button can reach
// -- a button that greyed out while the hub still showed a wait here
// would be the one place the app contradicts itself about whether it
// needs you.
//
// Longest wait first is also what makes it a NEXT button rather than a
// list: the top row is the one that has waited longest, which is the one
// to go to next.

import type { ContextMenuEntry } from "$lib/core/contextMenu";
import type { Workspace } from "$lib/core/workspace";
import { allSessionIds, type LayoutNode } from "$lib/panes/layout";
import { rowTip, waitLabel, type AttentionReason, type AttentionRow } from "$lib/agents/attentionInbox";

/// What the menu calls itself -- the hub panel's own heading, since it
/// is the same list.
export const NEXT_WAITING_TITLE = "Waiting on you";

/// The button's name. An icon on a tab row has no room for words (see
/// newPage.ts), so they live here, in its aria-label and its bubble.
export const NEXT_WAITING_LABEL = "Go to a session waiting on you";

/// Why the button is disabled with no workspace open -- New page's own
/// reason, for the same missing workspace.
export const NO_WORKSPACE_TIP = "Open a workspace to see what in it is waiting on you";

/// Each reason in a word or two, for the row's muted right-hand column.
///
/// Not REASON_LABEL: the hub's labels are sentences sized for a
/// full-width row, and a menu at most 280px wide would spend the whole
/// row on "Stopped — something broke" and cut the tab name to nothing.
/// The sentence is still there, in the row's bubble (rowTip).
export const REASON_WORD: Record<AttentionReason, string> = {
  asking: "asking",
  failed: "failed",
  "turn-ended": "turn ended",
  stale: "stale",
  "decoy-edit": "wrong copy",
};

/// The rows of the inbox whose TAB is in this workspace -- the tab, not
/// the card, because the tab is where the jump lands, and a tab dragged
/// in from another workspace is waiting here now. Nothing for no
/// workspace at all.
export function workspaceWaiting(rows: readonly AttentionRow[], workspaceId: string | null): AttentionRow[] {
  return workspaceId === null ? [] : rows.filter((row) => row.workspaceId === workspaceId);
}

/// The button's bubble: why it is disabled, or how much is waiting.
///
/// The count lives here and not on the button: a number that comes and
/// goes would reflow the row of tabs beside it, which is why New page
/// lost its words too. The empty case echoes the hub's quiet line for an
/// empty inbox, narrowed to the workspace it is about.
export function nextWaitingTip(ws: Pick<Workspace, "name"> | null, rows: readonly AttentionRow[]): string {
  if (!ws) return NO_WORKSPACE_TIP;
  if (rows.length === 0) return `Nothing in ${ws.name} is waiting on you`;
  const sessions = rows.length === 1 ? "1 session" : `${rows.length} sessions`;
  return `${sessions} in ${ws.name} waiting on you`;
}

/// The dropdown: the heading, then one row per waiting session in inbox
/// order.
///
/// A row is named by its tab, and by its page too only when the list
/// spans more than one. Every row is in the one workspace, so its name
/// would be the word they all share; the page is the next thing that
/// tells two rows apart, and most of the time they are all on one.
/// The workspace's Home agent counts as its own page ("Home").
///
/// `currentSessionId` is the session already on screen. Its row keeps
/// its place -- the order is the inbox's, and a row that jumped around
/// depending on where the human stood would be a different list each
/// time -- but carries the menu's "you are here" dot, so the pick that
/// goes nowhere is visibly that one.
export function nextWaitingEntries(
  rows: readonly AttentionRow[],
  currentSessionId: string | null,
  onPick: (row: AttentionRow) => void
): ContextMenuEntry[] {
  const spansPages = new Set(rows.map((row) => row.pageId)).size > 1;
  return [
    { heading: NEXT_WAITING_TITLE },
    ...rows.map((row) => ({
      label: spansPages ? `${row.pageName} · ${row.tabName}` : row.tabName,
      detail: `${REASON_WORD[row.reason]} · ${waitLabel(row.waitedMs, row.watched)}`,
      tip: rowTip(row),
      active: row.sessionId === currentSessionId,
      onPick: () => onPick(row),
    })),
  ];
}

/// The session the human is looking at right now, or null.
///
/// On the terminal view that is the focused session -- but only if it is
/// on the page being shown: the focus is remembered across page switches,
/// and a dot on a session that is not on screen would claim the human
/// is somewhere they are not. On the Home tab it is the workspace's own
/// agent panel, which is where an inbox row with no page lands. Every
/// other tab shows no session at all.
export function sessionOnScreen(
  ws: Workspace | null,
  view: string,
  tree: LayoutNode | null,
  focusedSessionId: string | null
): string | null {
  if (!ws) return null;
  if (view === "home") return ws.mainSessionId ?? null;
  if (view !== "terminal" || !tree || !focusedSessionId) return null;
  return allSessionIds(tree).includes(focusedSessionId) ? focusedSessionId : null;
}
