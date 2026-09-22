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
// The button is split. Its icon jumps straight to the next session
// (nextWaitingTarget) -- the one action the human wants nearly every
// time, at one click rather than two -- and its chevron opens the list,
// for the time they want a particular one.

import type { ContextMenuEntry } from "$lib/core/contextMenu";
import type { Workspace } from "$lib/core/workspace";
import { allSessionIds, type LayoutNode } from "$lib/panes/layout";
import { rowTip, waitLabel, type AttentionReason, type AttentionRow } from "$lib/agents/attentionInbox";

/// What the menu calls itself -- the hub panel's own heading, since it
/// is the same list.
export const NEXT_WAITING_TITLE = "Waiting on you";

/// The two halves' names. An icon on a tab row has no room for words
/// (see newPage.ts), so they live here, in aria-labels and bubbles.
export const NEXT_WAITING_LABEL = "Go to the next session waiting on you";
export const WAITING_LIST_LABEL = "List the sessions waiting on you";

/// Why the button is disabled with no workspace open -- New page's own
/// reason, for the same missing workspace.
export const NO_WORKSPACE_TIP = "Open a workspace to see what in it is waiting on you";

/// The colour of the "you are here" dot: the active workspace's own
/// accent, read exactly as a page's focused tab reads it for its
/// underline (Pane.svelte's `.tab.focused`) -- the amber fallback for a
/// workspace with no colour included -- so the dot on the session in the
/// menu and the mark on its tab are one colour. `--ws-accent` is set on
/// the app's root, which the menu layer is mounted inside.
export const CURRENT_DOT_COLOR = "var(--ws-accent, #d9a648)";

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

/// Where the icon's click goes: the waiting session AFTER the one on
/// screen, in inbox order, wrapping round to the top -- or the longest
/// wait when the human is on none of them. Null when nothing is waiting.
///
/// After, not simply the first row: a session stays in the list until
/// its agent prints something, so the moment the human has jumped to the
/// longest wait it is still the first row, and a button that always went
/// there would go nowhere from the second click on. Stepping from where
/// they stand walks every wait in turn instead. With one wait, and the
/// human already on it, the target is that same session; the bubble says
/// so (see nextWaitingTip).
export function nextWaitingTarget(
  rows: readonly AttentionRow[],
  currentSessionId: string | null
): AttentionRow | null {
  if (rows.length === 0) return null;
  const at = rows.findIndex((row) => row.sessionId === currentSessionId);
  return rows[(at + 1) % rows.length];
}

/// The icon's bubble: why it is disabled, or where the click goes and
/// how much is waiting.
///
/// The count lives here and not on the button: a number that comes and
/// goes would reflow the row of tabs beside it, which is why New page
/// lost its words too. The empty case echoes the hub's quiet line for an
/// empty inbox, narrowed to the workspace it is about.
export function nextWaitingTip(
  ws: Pick<Workspace, "name"> | null,
  rows: readonly AttentionRow[],
  currentSessionId: string | null
): string {
  if (!ws) return NO_WORKSPACE_TIP;
  const target = nextWaitingTarget(rows, currentSessionId);
  if (!target) return `Nothing in ${ws.name} is waiting on you`;
  if (target.sessionId === currentSessionId) return `The only session waiting in ${ws.name} is this one`;
  const sessions = rows.length === 1 ? "1 session" : `${rows.length} sessions`;
  const label = rowLabel(target, spansPages(rows));
  return `Go to ${label} (${REASON_WORD[target.reason]}) — ${sessions} in ${ws.name} waiting on you`;
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
/// time -- but carries the menu's "you are here" dot, in the workspace's
/// colour, so the pick that goes nowhere is visibly that one, and the
/// icon's next is visibly the row under it.
export function nextWaitingEntries(
  rows: readonly AttentionRow[],
  currentSessionId: string | null,
  onPick: (row: AttentionRow) => void
): ContextMenuEntry[] {
  const withPage = spansPages(rows);
  return [
    { heading: NEXT_WAITING_TITLE },
    ...rows.map((row) => ({
      label: rowLabel(row, withPage),
      detail: `${REASON_WORD[row.reason]} · ${waitLabel(row.waitedMs, row.watched)}`,
      tip: rowTip(row),
      active: row.sessionId === currentSessionId,
      markerColor: row.sessionId === currentSessionId ? CURRENT_DOT_COLOR : undefined,
      onPick: () => onPick(row),
    })),
  ];
}

function spansPages(rows: readonly AttentionRow[]): boolean {
  return new Set(rows.map((row) => row.pageId)).size > 1;
}

/// A row's name in the menu and in the icon's bubble -- one spelling for
/// both, so the bubble names the row the human will find in the list.
function rowLabel(row: AttentionRow, withPage: boolean): string {
  return withPage ? `${row.pageName} · ${row.tabName}` : row.tabName;
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
