// Which window does the app's own work, and how the others hear about it.
//
// Every window loads the whole frontend, and bootstrap starts the app's
// pollers and its rail scheduler in each. Two windows asked for agent
// usage, system memory, watchman and the daemon's session list twice as
// often, and each of those is a command on the thread that draws the
// window. Worse, two schedulers ticked the same rails -- every window
// holds every workspace, and the sidebar loads every workspace's plan --
// and nothing stopped both from launching the same step.
//
// The pollers belong to the app. Exactly one window holds the duty
// (workspace_window.rs decides which, and hands it over when that window
// is destroyed), and the others take its readings: the holder tells the
// other windows what it read, and they put it in their own stores.
// Nothing downstream of those stores knows or cares which window
// measured.
//
// Rails belong to a WORKSPACE, and a workspace is already on screen in
// exactly one window (appWindow.ts). That window is where its git refs,
// its tool library and its views get loaded, so it is the one that runs
// its rails; the holder only picks up the workspaces no open window is
// showing. See `railWindowFor`.
//
// Deliberately imports nothing from layoutState, for the reason
// appWindowState.ts gives: layoutState reads this module.
import { derived, get, writable, type Readable } from "svelte/store";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as backend from "$lib/core/backend";
import { hotState } from "$lib/core/hotState";
import { MAIN_WINDOW_LABEL, ownerLabel, type WorkspaceWindowMap } from "$lib/shell/appWindow";
import { currentWindowLabel, currentWorkspaceWindows } from "$lib/shell/appWindowState";

const hotBag = import.meta.hot?.data;

export interface AppDuty {
  /// The label of the window running the app's pollers, and the rails of
  /// any workspace no open window is showing.
  holder: string;
  /// Every window open, the holder included.
  windows: string[];
}

/// Mirrored from Rust. Until `initAppDuty` has run it names the main
/// window and no others -- what the host starts with, and the only
/// answer there is under vitest and the static build.
export const appDuty = hotState(
  "appDuty",
  () => writable<AppDuty>({ holder: MAIN_WINDOW_LABEL, windows: [] }),
  hotBag
);

/// Whether THIS window runs the app's duties. Emits only when that
/// answer changes, not when another window opens or closes.
export const holdsAppDuties: Readable<boolean> = derived(
  appDuty,
  (duty) => duty.holder === currentWindowLabel()
);

export function holdsAppDutiesNow(): boolean {
  return get(appDuty).holder === currentWindowLabel();
}

/// Whether anybody else is open to hear a reading. A lone window -- the
/// ordinary case -- has no one to tell, and telling nobody is still a
/// command per reading.
function otherWindowsOpen(): boolean {
  const me = currentWindowLabel();
  return get(appDuty).windows.some((label) => label !== me);
}

/// Loads the duty and keeps it current. Awaited in bootstrap ahead of
/// every poller it gates, so a workspace window never starts one for the
/// moment before it learns it is not the holder.
export async function initAppDuty(): Promise<UnlistenFn> {
  const unlisten = await listen<AppDuty>("app-duty-changed", (event) => {
    if (event.payload) appDuty.set(event.payload);
  });
  // After the listener, for workspaceWindows' reason: a handover between
  // the fetch and the subscription would be one nobody heard.
  try {
    appDuty.set(await backend.appDuty());
  } catch {
    // A host that cannot answer has not moved the duty, and it starts in
    // the main window.
  }
  return unlisten;
}

/// Runs `start` for as long as this window holds the duty: at once if it
/// does, when the duty is handed to it, and stopped when it moves away.
/// Returns its own teardown, for bootstrap's list.
export function whileHoldingAppDuties(start: () => () => void): () => void {
  let stop: (() => void) | null = null;
  const unsubscribe = holdsAppDuties.subscribe((holds) => {
    if (holds && !stop) {
      stop = start();
    } else if (!holds && stop) {
      const stopping = stop;
      stop = null;
      stopping();
    }
  });
  return () => {
    unsubscribe();
    const stopping = stop;
    stop = null;
    stopping?.();
  };
}

/// The window that runs a workspace's rails: the one showing it, or the
/// duty holder when the window showing it is not open -- the main window
/// after the close prompt's first rung, whose workspaces are then on
/// screen nowhere and would otherwise never advance again.
///
/// Not simply the holder for everything. A rail's scheduler reads the
/// workspace's git refs to put its checkout on the rail's branch, and
/// those are loaded by the views of the window SHOWING the workspace; a
/// holder that had never shown it would read them as unknown, skip the
/// switch and launch on whatever branch the checkout was on.
export function railWindowFor(
  map: WorkspaceWindowMap,
  duty: AppDuty,
  workspaceId: string
): string {
  const owner = ownerLabel(map, workspaceId);
  return duty.windows.includes(owner) ? owner : duty.holder;
}

/// Whether THIS window runs a workspace's rails.
export function runsRailsFor(workspaceId: string): boolean {
  return (
    railWindowFor(currentWorkspaceWindows(), get(appDuty), workspaceId) === currentWindowLabel()
  );
}

interface FromAWindow<T> {
  origin: string;
  payload: T;
}

/// Tells every other window. Best-effort: a reading that does not arrive
/// is replaced by the next one.
export function tellOtherWindows<T>(event: string, payload: T): void {
  if (!otherWindowsOpen()) return;
  const message: FromAWindow<T> = { origin: currentWindowLabel(), payload };
  try {
    void emit(event, message).catch(() => {});
  } catch {
    // No host to carry it.
  }
}

/// Hears what the other windows tell. A window's own message comes back
/// to it too, and is dropped: it already holds what it sent.
export function listenToOtherWindows<T>(
  event: string,
  handler: (payload: T) => void
): Promise<UnlistenFn> {
  return listen<FromAWindow<T>>(event, (e) => {
    if (!e.payload || e.payload.origin === currentWindowLabel()) return;
    handler(e.payload.payload);
  });
}
