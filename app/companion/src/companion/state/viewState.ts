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

/// The surfaces a workspace opens on. One, until the others are built.
export const SURFACES = ["board"] as const;
export type Surface = (typeof SURFACES)[number];

export interface ViewState {
  /// The workspace whose surface is open, or null at the workspace list.
  workspaceId: string | null;
  surface: Surface;
}

/// The part of `Storage` this needs, so a suite can hand it a map and a
/// Device that refuses storage can hand it nothing.
export interface ViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function initialView(): ViewState {
  return { workspaceId: null, surface: "board" };
}

export function openWorkspace(view: ViewState, workspaceId: string): ViewState {
  return { ...view, workspaceId, surface: "board" };
}

export function backToWorkspaces(view: ViewState): ViewState {
  return { ...view, workspaceId: null };
}

/// The view, given the workspaces the Workstation has NOW. One removed at
/// the desk since the Device last looked is not somewhere to return to.
export function reconcileView(view: ViewState, workspaceIds: string[]): ViewState {
  if (view.workspaceId === null || workspaceIds.includes(view.workspaceId)) return view;
  return backToWorkspaces(view);
}

export function viewKey(workstationId: string): string {
  return `gavin.companion.view.${workstationId}`;
}

function isSurface(value: unknown): value is Surface {
  return (SURFACES as readonly unknown[]).includes(value);
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
  const { workspaceId, surface } = stored as Record<string, unknown>;
  if (workspaceId !== null && typeof workspaceId !== "string") return initialView();
  return {
    workspaceId: workspaceId ?? null,
    // A surface this bundle does not have is one a newer bundle saved;
    // the workspace is still the right one to open.
    surface: isSurface(surface) ? surface : "board",
  };
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
