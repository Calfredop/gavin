// A terminal tab's way back to the card it is running. `card_sessions`
// already binds a card path to a session id for both the board's Run and
// an orchestration launch (cardRunActions.ts, orchestrationState.ts), so
// the link is a reverse lookup over the very same binding -- no second
// source of truth, and a tab whose binding was replaced by a re-launch
// follows it automatically.
//
// Pure lookups plus one deep-link store, in the shape planExplorer.ts's
// `requestedExplorerPath` already established: the requester sets the
// store and switches the hub view, the view that owns the modal picks it
// up on mount (or on the spot, if it is already showing) and clears it.

import { writable } from "svelte/store";
import type { Board } from "./kanban";
import type { GavinTree } from "./gavin";
import type { Orchestration } from "./orchestration";
import { cardIndex } from "./orchestration";
import { switchWorkspaceView } from "./layoutState";

/// Which hub tab a card is best seen in: a card on a rail belongs to the
/// run that owns it, everything else to the board.
export type CardLinkView = "orchestration" | "kanban";

export interface LinkedCard {
  path: string;
  /// The card's title, or its file name when the tree has not caught up
  /// with a file that exists (a card created seconds ago). Never blank --
  /// this is the tab button's tooltip.
  title: string;
  view: CardLinkView;
}

export interface CardDetailRequest {
  workspaceId: string;
  path: string;
  /// The tab that should answer it. Carried explicitly so the tab the
  /// human is leaving cannot swallow a request meant for the one they
  /// are arriving at -- both stores are written in the same tick.
  view: CardLinkView;
}

/// Set before switching the hub view; the Kanban and Orchestration tabs
/// consume it and open that card's detail modal.
export const requestedCardDetail = writable<CardDetailRequest | null>(null);

export function cardPathForSession(board: Board | undefined, sessionId: string): string | null {
  return board?.cardSessions.find((cs) => cs.sessionId === sessionId)?.path ?? null;
}

export function cardIsOnARail(orch: Orchestration | undefined, path: string): boolean {
  return (orch?.rails ?? []).some((r) => r.stages.some((s) => s.steps.some((t) => t.cardPath === path)));
}

/// The whole tab-side question in one call: is this session running a
/// card, what is it called, and where should the link take the human.
/// Null for every ordinary terminal -- most tabs are not agents.
export function linkedCardFor(
  board: Board | undefined,
  orch: Orchestration | undefined,
  tree: GavinTree | undefined,
  sessionId: string
): LinkedCard | null {
  const path = cardPathForSession(board, sessionId);
  if (!path) return null;
  const title = cardIndex(tree).get(path)?.plan.title;
  return {
    path,
    title: title && title.trim() ? title : (path.split("/").at(-1) ?? path),
    view: cardIsOnARail(orch, path) ? "orchestration" : "kanban",
  };
}

/// Jump to the card: its rail's tab or the board, with its detail modal
/// open. The store is set BEFORE the view switch so a tab mounting for
/// the first time already finds the request waiting.
export async function openLinkedCard(workspaceId: string, card: LinkedCard): Promise<void> {
  requestedCardDetail.set({ workspaceId, path: card.path, view: card.view });
  await switchWorkspaceView(workspaceId, card.view);
}

/// The consumer half: returns the path this view should open, and clears
/// the request so it fires once. Requests for another workspace or
/// another view are left alone for their own owner to pick up.
export function takeCardDetailRequest(
  request: CardDetailRequest | null,
  workspaceId: string,
  view: CardLinkView
): string | null {
  if (!request || request.workspaceId !== workspaceId || request.view !== view) return null;
  requestedCardDetail.set(null);
  return request.path;
}
