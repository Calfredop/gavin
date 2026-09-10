// The keyboard's route to a board's card composer. ⌘N is pressed at the
// window (keyboard.ts), far outside the component that owns the composer
// modal, so the request travels through a store in the shape
// cardTabLink.ts's `requestedCardDetail` already established: the router
// sets it, the board that owns the addressed surface picks it up and
// clears it.
//
// The routing itself is pure and lives here rather than in keyboard.ts,
// because "which board is on screen" is the part that is easy to get
// subtly wrong -- a hub board and any number of context BoardPanes can
// be mounted at once, and only one of them may answer.

import { writable } from "svelte/store";
import { getActiveView, type Workspace } from "$lib/core/workspace";
import type { BoardTab } from "$lib/core/gavin";

/// Which board should answer ⌘N. The hub board is addressed by its
/// workspace; a context BoardPane by the TAB it lives in -- two panes can
/// project the same context folder, and only the focused one should open.
export type ComposeTarget =
  | { kind: "hub"; workspaceId: string }
  | { kind: "tab"; workspaceId: string; tabId: string };

/// Set by the shortcut router; consumed by whichever board matches.
export const requestedCompose = writable<ComposeTarget | null>(null);

/// The board the shortcut addresses, or null when no board is showing --
/// in which case the key is left alone for whatever else wants it.
///
/// A board tab only ever renders inside the terminal view, so the hub
/// board wins whenever the Kanban hub tab is the active view and the
/// focused board tab wins otherwise. The tab's OWN workspaceId is used:
/// a board tab can project a context from a workspace other than the
/// active one, and the card belongs to the board it was typed into.
export function resolveComposeTarget(
  workspace: Workspace | null,
  focusedSessionId: string | null,
  boardTabsById: Record<string, BoardTab>
): ComposeTarget | null {
  if (!workspace) return null;
  const view = getActiveView(workspace);
  if (view === "kanban") return { kind: "hub", workspaceId: workspace.id };
  if (view !== "terminal" || !focusedSessionId) return null;
  const tab = boardTabsById[focusedSessionId];
  if (!tab) return null;
  return { kind: "tab", workspaceId: tab.workspaceId, tabId: focusedSessionId };
}

function sameTarget(a: ComposeTarget, b: ComposeTarget): boolean {
  if (a.kind !== b.kind || a.workspaceId !== b.workspaceId) return false;
  return a.kind === "hub" || a.tabId === (b as { tabId: string }).tabId;
}

/// The consumer half: true when this surface owns the pending request,
/// which is also when the request is cleared so it fires exactly once.
/// A request for another board is left alone for its own owner.
export function takeComposeRequest(request: ComposeTarget | null, self: ComposeTarget): boolean {
  if (!request || !sameTarget(request, self)) return false;
  requestedCompose.set(null);
  return true;
}
