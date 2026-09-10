// What a tab in a pane IS, and what it is called.
//
// A pane's tab strip holds five different things behind one id, and
// nothing on the id says which. The three maps are the whole answer:
// an id in `boardTabsById` is a board, in `fileTabsById` a file, in
// `cardTabsById` a card or a follow-up queue -- and an id in none of them
// is a terminal session. That last clause is why this lives here rather
// than in the template. It is a classification by ABSENCE, so a lost map
// entry does not read as a missing tab; it reads as a terminal, and the
// pane goes on to mount a `<TerminalPane>` for a session the daemon has
// never heard of (see layoutState's ClosedTabs for what that costs).
//
// The labels come with it because they answer the same question. Four of
// the five kinds name themselves from exact information -- a filename, a
// context, a card title, the terminal a queue belongs to -- and only a
// terminal's label is a guess off its cwd. Which is exactly the set that
// may be renamed, so `renameable` is not a second rule but a reading of
// the first.

import type { BoardTab, CardTab, GavinTree } from "$lib/core/gavin";
// Type-only, so no store module is pulled in at runtime.
import type { FileTab } from "$lib/core/layoutState";
import type { Orchestration } from "$lib/orchestration/orchestration";
import { linkForCardPath } from "$lib/cards/cardTabLink";
import { boardTabLabel, cardTabLabel, folderName, followUpsTabLabel, sessionLabel } from "$lib/core/paths";

/// The three maps that classify a tab id.
export interface TabMaps {
  fileTabsById: Record<string, FileTab>;
  boardTabsById: Record<string, BoardTab>;
  cardTabsById: Record<string, CardTab>;
}

/// Everything naming a tab needs on top of the classification: the
/// terminal names and cwds, and the per-workspace trees and plans a
/// board or card tab reads its own name out of.
export interface TabNaming extends TabMaps {
  sessionNames: Record<string, string>;
  cwdBySessionId: Record<string, string>;
  trees: Record<string, GavinTree>;
  orchestrations: Record<string, Orchestration>;
}

export type TabKind = "terminal" | "file" | "board" | "card" | "followups";

/// A follow-up queue is a card tab with `view: "followups"` -- and no
/// card. Its subject rides in `sessionId`, because an agent's queue
/// outlives whatever card it happens to be running.
export function tabKind(tabId: string, maps: TabMaps): TabKind {
  if (maps.boardTabsById[tabId]) return "board";
  if (maps.cardTabsById[tabId]) {
    return maps.cardTabsById[tabId].view === "followups" ? "followups" : "card";
  }
  if (maps.fileTabsById[tabId]) return "file";
  return "terminal";
}

/// True for every tab a pane renders as something other than a terminal.
/// The session chips in the tab bar all hang off a session, so each of
/// them opens with this -- a card pane offering to open a card pane
/// beside itself is what a missing check here produces.
export function isViewTab(tabId: string, maps: TabMaps): boolean {
  return tabKind(tabId, maps) !== "terminal";
}

/// The session a follow-ups tab is the queue FOR, or null for every
/// other kind of tab.
export function followUpsSessionFor(tabId: string, maps: TabMaps): string | null {
  const tab = maps.cardTabsById[tabId];
  return tab?.view === "followups" ? (tab.sessionId ?? null) : null;
}

/// Only a terminal may be renamed. Every other label is exact
/// information read live out of the tree, so a hand-typed name would
/// either be overwritten on the next push or lie.
export function renameable(tabId: string, maps: TabMaps): boolean {
  return !isViewTab(tabId, maps);
}

/// What the tab strip shows. The formats themselves live in paths.ts,
/// shared with the sidebar's page expansion, so one tab never goes by
/// two names.
export function tabLabel(tabId: string, ctx: TabNaming): string {
  const board = ctx.boardTabsById[tabId];
  if (board) {
    const name = ctx.trees[board.workspaceId]?.contexts.find(
      (c) => c.folderPath === board.contextFolder
    )?.name;
    return boardTabLabel(name, board.contextFolder);
  }
  const card = ctx.cardTabsById[tabId];
  if (card) {
    // Named after the terminal it belongs to rather than after a card,
    // because it has none. Written as a check on `view` rather than on
    // followUpsSessionFor's result so the call below narrows to the two
    // views cardTabLabel can name.
    if (card.view === "followups") {
      return followUpsTabLabel(sessionLabel(ctx.sessionNames, ctx.cwdBySessionId, card.sessionId ?? tabId));
    }
    const title = linkForCardPath(ctx.orchestrations[card.workspaceId], ctx.trees[card.workspaceId], card.path).title;
    return cardTabLabel(title, card.view);
  }
  const file = ctx.fileTabsById[tabId];
  if (file) return folderName(file.path);
  return sessionLabel(ctx.sessionNames, ctx.cwdBySessionId, tabId);
}

/// The hover text: where the tab points, which is the part the label had
/// to drop. A queue borrows its terminal's, since where the queue points
/// IS that terminal -- one hop by construction, because a queue's
/// subject is a session id and a session is in none of these maps.
export function tabTooltip(tabId: string, ctx: TabNaming): string {
  const board = ctx.boardTabsById[tabId];
  if (board) return board.contextFolder;
  const queueFor = followUpsSessionFor(tabId, ctx);
  if (queueFor) return tabTooltip(queueFor, ctx);
  // Reached by a queue tab with no session recorded as well, which is
  // the one case where a follow-ups tab answers with its own card path.
  const card = ctx.cardTabsById[tabId];
  if (card) return card.path;
  const file = ctx.fileTabsById[tabId];
  if (file) return file.path;
  return ctx.sessionNames[tabId] ?? ctx.cwdBySessionId[tabId] ?? tabId;
}
