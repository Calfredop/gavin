// The live answer to "which window is this, and where is every
// workspace" -- the state behind appWindow.ts's rules.
//
// Deliberately imports nothing from layoutState: layoutState reads THIS
// module on every activation (that is the guard keeping a workspace out
// of two windows at once), so an import back would close a cycle.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { get, writable } from "svelte/store";
import * as backend from "$lib/backend";
import { hotState } from "$lib/hotState";
import { MAIN_WINDOW_LABEL, type WorkspaceWindowMap } from "$lib/shell/appWindow";

const hotBag = import.meta.hot?.data;

/// Workspace id -> window label, mirrored from Rust. Empty until
/// `initWorkspaceWindows` has run, which is the same thing it means
/// afterwards: nothing has moved, everything is in the main window.
export const workspaceWindows = hotState(
  "workspaceWindows",
  () => writable<WorkspaceWindowMap>({}),
  hotBag
);

let cachedLabel: string | null = null;

/// This window's Tauri label.
///
/// Guarded and cached: `getCurrentWindow()` reads an object Tauri injects
/// into the page, so it throws under vitest and during the static build,
/// where "main" is both harmless and true -- there is only ever one
/// window in either.
export function currentWindowLabel(): string {
  if (cachedLabel !== null) return cachedLabel;
  try {
    cachedLabel = getCurrentWindow().label;
  } catch {
    cachedLabel = MAIN_WINDOW_LABEL;
  }
  return cachedLabel;
}

export function isMainWindow(): boolean {
  return currentWindowLabel() === MAIN_WINDOW_LABEL;
}

/// The map as it stands, for the synchronous paths (a menu being built, an
/// activation deciding whether to raise another window instead).
export function currentWorkspaceWindows(): WorkspaceWindowMap {
  return get(workspaceWindows);
}

/// Loads the map and keeps it current. Awaited early in bootstrap,
/// because which workspace this window shows at all depends on it -- a
/// workspace window that rendered before the answer arrived would flash
/// the main window's workspace first.
export async function initWorkspaceWindows(): Promise<UnlistenFn> {
  const unlisten = await listen<WorkspaceWindowMap>("workspace-windows-changed", (event) => {
    workspaceWindows.set(event.payload ?? {});
  });
  // After the listener, not before: a window opening or closing between
  // the fetch and the subscription would be a change nothing ever hears.
  try {
    workspaceWindows.set(await backend.workspaceWindows());
  } catch {
    // A Rust side that cannot answer means no window has claimed
    // anything, which is the empty map this store already holds.
  }
  return unlisten;
}
