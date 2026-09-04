// What archiving a card takes down with it: the agent sessions still
// running for that card, and the tabs that were showing its file.
//
// Pure, and deliberately separate from archiveActions.ts's write side --
// the answer has to be computed BEFORE the first move, while the cards
// still sit at the paths every binding and file tab names. The actions
// module then moves and closes card by card, so a batch that fails
// half-way never kills a session for a card that never moved.
//
// The `card_sessions` binding itself is left alone on purpose: the
// session dies, the row survives, and a card restored from the archive
// still offers "Re-launch agent" with the cwd and command it ran with.

import { findSessionLocation } from "./workspace";
import type { Workspace } from "./workspace";
import type { Board } from "./kanban";
import type { CardView } from "./planBoard";

/// The slice of LayoutState this projection reads. Structural rather
/// than the whole type, so the module never has to import layoutState
/// and drag its event listeners along.
export interface ClosableState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  fileTabsById: Record<string, { path: string }>;
  cardTabsById: Record<string, { path: string }>;
}

export interface ArchiveClosables {
  /// Live terminal sessions bound to the card. These END -- the prompt
  /// counts them, and only them.
  sessionIds: string[];
  /// Pane tabs showing the card -- its file in an editor, or its detail
  /// and diff views. Closing one ends no process, so they go silently.
  fileTabIds: string[];
}

/// Every path the archive move takes with this card: the card itself
/// plus its nested children, which live inside it and travel with it
/// (archiveActions.ts's movedPaths, same rule).
function pathsOf(card: CardView): string[] {
  return [card, ...card.nestedChildren].map((c) => c.id);
}

/// One entry per card, index-aligned with `cards`. Ids are never
/// repeated across entries: whichever card claims a tab first owns it,
/// so a session bound to two of the archived paths is killed once and
/// counted once.
export function closablesForArchive(
  state: ClosableState,
  board: Board | undefined,
  cards: CardView[]
): ArchiveClosables[] {
  const claimed = new Set<string>();
  return cards.map((card) => {
    const paths = new Set(pathsOf(card));
    const sessionIds: string[] = [];
    for (const cs of board?.cardSessions ?? []) {
      if (!paths.has(cs.path) || claimed.has(cs.sessionId)) continue;
      // A binding whose session already exited is not a close, it is a
      // memory -- handleSessionExited prunes dead ids out of every tree,
      // so "still in a tree" is exactly "still running".
      if (!findSessionLocation(state, cs.sessionId)) continue;
      claimed.add(cs.sessionId);
      sessionIds.push(cs.sessionId);
    }
    // File tabs and card tabs are counted together: both are a pane
    // showing a card that is about to leave the board, both close
    // silently, and the caller closes them through the one close path.
    const fileTabIds: string[] = [];
    for (const [tabId, tab] of [
      ...Object.entries(state.fileTabsById),
      ...Object.entries(state.cardTabsById),
    ]) {
      if (!paths.has(tab.path) || claimed.has(tabId)) continue;
      claimed.add(tabId);
      fileTabIds.push(tabId);
    }
    return { sessionIds, fileTabIds };
  });
}

/// How many live agent sessions this batch would end -- the number the
/// human is asked about. Already deduplicated by closablesForArchive.
export function liveSessionTotal(closables: ArchiveClosables[]): number {
  return closables.reduce((n, c) => n + c.sessionIds.length, 0);
}

/// The dialog's wording, in confirmClose.ts's voice: the question, then
/// what it costs. Title and consequence separately because the shared
/// modal renders them separately -- the heading asks, the list below it
/// spells out the price. Only ever shown when `sessions` is at least
/// 1 -- a batch that ends nothing is not worth a dialog.
export function archiveClosePrompt(cards: number, sessions: number): { title: string; lines: string[] } {
  const cardWord = cards === 1 ? "this card" : `these ${cards} cards`;
  const s = sessions === 1 ? "" : "s";
  return {
    title: `Archive ${cardWord}?`,
    lines: [`${sessions} running agent session${s} will end.`],
  };
}
