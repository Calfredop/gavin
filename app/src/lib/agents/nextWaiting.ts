// The top bar's "next" button: every session waiting on a human, one
// click from wherever the human happens to be. NextWaitingButton.svelte
// is a thin template over this.
//
// It lists the hub's "Waiting on you" inbox (attentionInbox.ts), in the
// inbox's own order, rather than a list of its own making. The hub and
// this menu are two doors onto one question, so a session the hub says
// is waiting has to be one this button can reach -- and a button that
// greys out while the hub still lists something would be the one place
// the app contradicts itself about whether it needs you.
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

/// The bubble on the button while it is disabled -- the hub's quiet line
/// for an empty inbox, word for word.
export const ALL_CLEAR_TIP = "Nothing is waiting on you";

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

/// The button's bubble while something is waiting: how much, so the
/// count is readable without opening the menu. Not drawn on the button
/// itself -- a number that comes and goes would reflow the row of tabs
/// beside it, which is why New page lost its words too.
export function nextWaitingTip(rows: readonly AttentionRow[]): string {
  if (rows.length === 0) return ALL_CLEAR_TIP;
  return rows.length === 1 ? "1 session waiting on you" : `${rows.length} sessions waiting on you`;
}

/// The dropdown: the heading, then one row per waiting session in inbox
/// order.
///
/// A row is named by its tab, and by its workspace too only when the
/// list spans more than one. Most of the time every waiting session is
/// in the one workspace on screen, and repeating its name on each row
/// would spend the menu's width on the one word they all share.
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
  const spansWorkspaces = new Set(rows.map((row) => row.workspaceId)).size > 1;
  return [
    { heading: NEXT_WAITING_TITLE },
    ...rows.map((row) => ({
      label: spansWorkspaces ? `${row.workspaceName} · ${row.tabName}` : row.tabName,
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
