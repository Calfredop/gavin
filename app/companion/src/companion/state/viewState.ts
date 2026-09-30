// Where the Companion is looking: its own view state, kept on the Device.
//
// The desktop remembers where it is by saving its layout -- pages, tabs,
// the active workspace -- to the Workstation's config. The Companion must
// never do that (spec, story 35: what happens on the phone does not
// rearrange the desk), so what it remembers lives here instead, in the
// bundle's own storage, one entry per Workstation (story 34).
//
// Pure: the store that holds a view and the page that draws it are
// elsewhere (workstation.ts).

/// The surfaces a workspace opens on.
export const SURFACES = ["board", "sessions"] as const;
export type Surface = (typeof SURFACES)[number];

/// What is open over a workspace's board: one of its cards, by path, or
/// its PRD.
export type BoardPage = { kind: "card"; path: string } | { kind: "prd" };

export interface ViewState {
  /// The workspace whose surface is open, or null at the workspace list.
  workspaceId: string | null;
  /// Which of the workspace's surfaces. Kept while the list is showing,
  /// so the next workspace opens on the surface the human last chose.
  surface: Surface;
  /// The terminal open over the workspace's sessions, or null.
  sessionId: string | null;
  /// The page open over its board. Absent on the board itself, and
  /// wherever the view is not on a board.
  page?: BoardPage;
}

/// The part of `Storage` this needs, so a suite can hand it a map and a
/// Device that refuses storage can hand it nothing.
export interface ViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function initialView(): ViewState {
  return { workspaceId: null, surface: "board", sessionId: null };
}

export function openWorkspace(view: ViewState, workspaceId: string): ViewState {
  return { ...view, workspaceId, sessionId: null, page: undefined };
}

export function showSurface(view: ViewState, surface: Surface): ViewState {
  return { ...view, surface, sessionId: null, page: undefined };
}

/// A session's terminal, over its workspace's list of sessions -- which
/// is where closing it goes back to.
export function openTerminal(workspaceId: string, sessionId: string): ViewState {
  return { workspaceId, surface: "sessions", sessionId };
}

/// A card, or the PRD, over the open workspace's board -- which is where
/// closing it goes back to.
export function openPage(view: ViewState, page: BoardPage): ViewState {
  return { ...view, surface: "board", sessionId: null, page };
}

export function closePage(view: ViewState): ViewState {
  return { ...view, page: undefined };
}

export function closeTerminal(view: ViewState): ViewState {
  return { ...view, sessionId: null };
}

export function backToWorkspaces(view: ViewState): ViewState {
  return { ...view, workspaceId: null, sessionId: null, page: undefined };
}

/// The view, given the workspaces the Workstation has NOW. One removed at
/// the desk since the Device last looked is not somewhere to return to.
export function reconcileView(view: ViewState, workspaceIds: string[]): ViewState {
  if (view.workspaceId === null || workspaceIds.includes(view.workspaceId)) return view;
  return backToWorkspaces(view);
}

/// The view, given the sessions its workspace has NOW. A terminal whose
/// session has ended is not somewhere to return to either; its list is.
export function reconcileSession(view: ViewState, sessionIds: readonly string[]): ViewState {
  if (view.sessionId === null || sessionIds.includes(view.sessionId)) return view;
  return closeTerminal(view);
}

export function viewKey(workstationId: string): string {
  return `gavin.companion.view.${workstationId}`;
}

function isSurface(value: unknown): value is Surface {
  return (SURFACES as readonly unknown[]).includes(value);
}

/// A stored page, or undefined for one this bundle cannot open.
function readPage(value: unknown): BoardPage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { kind, path } = value as Record<string, unknown>;
  if (kind === "prd") return { kind };
  if (kind === "card" && typeof path === "string" && path !== "") return { kind, path };
  return undefined;
}

/// What was remembered for a Workstation, or the workspace list when
/// nothing usable was. Never throws: storage on a phone can be absent,
/// full, or written by a bundle newer than this one.
export function loadView(storage: ViewStorage | null, workstationId: string): ViewState {
  let stored: unknown;
  try {
    const raw = storage?.getItem(viewKey(workstationId)) ?? null;
    if (raw === null) return initialView();
    stored = JSON.parse(raw);
  } catch {
    return initialView();
  }
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return initialView();
  const { workspaceId, surface, sessionId, page } = stored as Record<string, unknown>;
  if (workspaceId !== null && typeof workspaceId !== "string") return initialView();
  // A surface this bundle does not have is one a newer bundle saved; the
  // workspace is still the right one to open, on its board.
  const known = isSurface(surface);
  const view: ViewState = {
    workspaceId: workspaceId ?? null,
    surface: known ? surface : "board",
    // Written by a bundle older than terminals, or for a surface this one
    // cannot draw: no terminal.
    sessionId: known && workspaceId && typeof sessionId === "string" ? sessionId : null,
  };
  // A page is over a board, and only over the board of a workspace. One
  // this bundle cannot open is dropped, and the board shown under it.
  const over = workspaceId && view.surface === "board" && view.sessionId === null ? readPage(page) : undefined;
  return over ? { ...view, page: over } : view;
}

/// Best-effort: a view that could not be saved costs the human one tap
/// the next time they open the Workstation.
export function saveView(storage: ViewStorage | null, workstationId: string, view: ViewState): void {
  try {
    storage?.setItem(viewKey(workstationId), JSON.stringify(view));
  } catch {
    // Nothing to do, and nothing to tell anyone.
  }
}
