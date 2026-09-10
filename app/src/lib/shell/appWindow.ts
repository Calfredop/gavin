// Which window a workspace is in, as rules rather than as plumbing.
// appWindowState.ts holds the live map and talks to Rust; this module is
// every decision either side takes from it, pure and unit-tested.
//
// The one rule underneath all of them: A WORKSPACE IS ON SCREEN IN
// EXACTLY ONE WINDOW. Two panes over one PTY would each report their own
// cols/rows to the daemon and resize the program between them forever,
// and nothing else in the app is per-window -- one daemon connection, one
// Attach per session, output broadcast to every webview. So "where is
// this workspace" is the only question that has to have a single answer,
// and it is the one this module answers.
import type { Workspace } from "$lib/core/workspace";

/// Tauri's own label for the window declared in tauri.conf.json, and the
/// owner of every workspace no other window has claimed. Mirrors
/// workspace_window.rs's MAIN_WINDOW_LABEL.
export const MAIN_WINDOW_LABEL = "main";

/// Workspace id -> the label of the window showing it. A workspace that
/// is not a key belongs to the main window; the map only ever records
/// the exceptions, which is what makes "nothing has moved" the empty map
/// rather than a full one every window has to keep correct.
export type WorkspaceWindowMap = Record<string, string>;

/// The label of the window a workspace gets when it is given one of its
/// own. Mirrors workspace_window.rs, which builds the same string -- the
/// two sides have to agree, and the capability file already grants `ws-*`
/// on that basis.
export function workspaceWindowLabel(workspaceId: string): string {
  return `ws-${workspaceId}`;
}

export function ownerLabel(map: WorkspaceWindowMap, workspaceId: string): string {
  return map[workspaceId] ?? MAIN_WINDOW_LABEL;
}

/// Whether a workspace is on screen somewhere that is not this window.
/// The question every activation asks before putting one on screen: a
/// "yes" means raise that window instead.
export function isInAnotherWindow(
  map: WorkspaceWindowMap,
  workspaceId: string,
  myLabel: string
): boolean {
  return ownerLabel(map, workspaceId) !== myLabel;
}

/// The workspaces a window is responsible for, in the order given.
///
/// Two different questions share one implementation on purpose. For the
/// main window it is "everything nobody else took"; for a workspace
/// window it is "the ones handed to me". Written as a filter over
/// `ownerLabel`, both fall out of the same absence rule and neither can
/// drift from the other.
export function workspacesInWindow(
  workspaces: Workspace[],
  map: WorkspaceWindowMap,
  label: string
): Workspace[] {
  return workspaces.filter((w) => ownerLabel(map, w.id) === label);
}

/// The workspace a window should be showing, given what config.json says
/// was last active.
///
/// The stored id is one value shared by every window, so it can only ever
/// be right for one of them -- and it is not even reliably right for the
/// main window, since the workspace it names may have moved out. Every
/// window therefore takes it only as a preference, and falls back to the
/// first workspace it actually holds. `null` means this window has
/// nothing to show, which the app already has an answer for (the hub, or
/// the create-a-workspace overlay).
export function activeWorkspaceForWindow(
  workspaces: Workspace[],
  map: WorkspaceWindowMap,
  label: string,
  storedActiveId: string | null
): string | null {
  const mine = workspacesInWindow(workspaces, map, label);
  if (storedActiveId && mine.some((w) => w.id === storedActiveId)) return storedActiveId;
  return mine[0]?.id ?? null;
}

/// What a window should show after it hands `leavingId` to a window of
/// its own: the next workspace it still holds, or `null` when it holds
/// none -- the caller's cue to open the app hub rather than leave the
/// pane showing a workspace that is now somewhere else.
///
/// Prefers a neighbour of the one leaving rather than restarting at the
/// top of the list: the workspace you moved out is the one you were just
/// looking at, and the sidebar row under it is where your eye already is.
export function nextActiveAfterHandoff(
  workspaces: Workspace[],
  map: WorkspaceWindowMap,
  label: string,
  leavingId: string
): string | null {
  const mine = workspacesInWindow(workspaces, map, label).filter((w) => w.id !== leavingId);
  if (mine.length === 0) return null;
  const wasAt = workspaces.findIndex((w) => w.id === leavingId);
  const after = mine.find((w) => workspaces.indexOf(w) > wasAt);
  return (after ?? mine[mine.length - 1]).id;
}

/// What the two entry points may offer for a workspace.
///
/// Three states, not two, and the third is the one worth naming: a
/// workspace window looking at the workspace it was OPENED for has
/// nothing to offer -- that workspace is already in a window of its own,
/// and both "open" and "show" would be gestures ending where they
/// started. A workspace merely created inside that window is a different
/// case: it is sharing someone else's window and can still be given one.
export type WindowAction = "open" | "show" | "none";

export function windowAction(
  map: WorkspaceWindowMap,
  workspaceId: string,
  myLabel: string
): WindowAction {
  if (ownerLabel(map, workspaceId) !== myLabel) return "show";
  return myLabel === workspaceWindowLabel(workspaceId) ? "none" : "open";
}

/// What the human reads on the entry point, or `null` when there is
/// nothing to offer. One function so the sidebar menu and the hub's
/// button can never disagree about the words -- or, worse, offer to open
/// a second window onto a workspace that already has one.
export function windowActionLabel(
  map: WorkspaceWindowMap,
  workspaceId: string,
  myLabel: string
): string | null {
  switch (windowAction(map, workspaceId, myLabel)) {
    case "open":
      return "Open in New Window";
    case "show":
      return "Show in Its Window";
    default:
      return null;
  }
}
