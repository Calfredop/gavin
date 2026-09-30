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

/// The surfaces a workspace opens on, in the order the strip shows them.
export const SURFACES = ["board", "git", "files"] as const;
export type Surface = (typeof SURFACES)[number];

export const SURFACE_LABELS: Record<Surface, string> = {
  board: "Board",
  git: "Git",
  files: "Files",
};

/// Where the Files surface is: the folder on screen, and the file open
/// over it, if one is.
export interface FilesPlace {
  dir: string;
  file: string | null;
}

export interface ViewState {
  /// The workspace whose surface is open, or null at the workspace list.
  workspaceId: string | null;
  surface: Surface;
  /// Absent until the Files surface has been somewhere in this workspace.
  files?: FilesPlace;
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

/// Opens a workspace on its board. Where Files was is another
/// workspace's place, so it is not carried in.
export function openWorkspace(_view: ViewState, workspaceId: string): ViewState {
  return { workspaceId, surface: "board" };
}

export function backToWorkspaces(_view: ViewState): ViewState {
  return { workspaceId: null, surface: "board" };
}

/// Switches the open workspace to another of its surfaces, keeping the
/// place each one was at.
export function showSurface(view: ViewState, surface: Surface): ViewState {
  if (view.workspaceId === null) return view;
  return { ...view, surface };
}

export function placeFiles(view: ViewState, place: FilesPlace): ViewState {
  if (view.workspaceId === null) return view;
  return { ...view, files: { dir: place.dir, file: place.file } };
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

/// A stored Files place, or null for anything that is not one.
function readPlace(value: unknown): FilesPlace | null {
  if (typeof value !== "object" || value === null) return null;
  const { dir, file } = value as Record<string, unknown>;
  if (typeof dir !== "string" || (file !== null && typeof file !== "string")) return null;
  return { dir, file };
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
  const { workspaceId, surface, files } = stored as Record<string, unknown>;
  if (workspaceId !== null && typeof workspaceId !== "string") return initialView();
  const view: ViewState = {
    workspaceId: workspaceId ?? null,
    // A surface this bundle does not have is one a newer bundle saved;
    // the workspace is still the right one to open.
    surface: isSurface(surface) ? surface : "board",
  };
  const place = view.workspaceId === null ? null : readPlace(files);
  return place ? { ...view, files: place } : view;
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
