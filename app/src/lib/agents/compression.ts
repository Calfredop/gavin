// Compression through Headroom, as the app sees it: whether a workspace
// has it on, and what the daemon is told.
//
// Pure. The store that holds the app-wide default lives in
// `layoutState.ts`, and the driver that talks to the daemon is
// `compressionDriver.ts`.
//
// The app decides nothing about a SESSION here. Whether one is compressed
// is settled by the daemon when it spawns the process
// (`crates/daemon/src/headroom/compress.rs`), because readiness, the port
// and the recipes are all the daemon's facts, and a session another agent
// spawns over MCP never passes through the app. What the app owns is the
// switch, and the name of the profile it is launching.

import type { Workspace } from "$lib/core/workspace";

/// Off. Installing Headroom must never quietly change how the workspaces
/// that already exist talk to their models, so compression is something
/// a human turns on.
export const DEFAULT_HEADROOM = false;

/// A stored setting, or null for "nothing chosen here" -- what both an
/// absent value and an unusable one mean. config.json is a file a human
/// can edit, and a workspace whose value is garbled has to fall through
/// to the app-wide one rather than read as a choice.
export function normalizeHeadroom(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/// A workspace's OWN choice, or null where it inherits: what its switch
/// shows as selected. Not whether compression is on there -- that is
/// `resolveHeadroom`'s, and the switch names what inheriting comes to
/// beside it.
export function ownHeadroom(ws: { headroom?: unknown } | null | undefined): boolean | null {
  return normalizeHeadroom(ws?.headroom);
}

/// Whether compression is on in a workspace: its own choice, else the
/// app-wide one, else gavin's default. The same three levels, in the same
/// order, as `resolveRequireReview`.
export function resolveHeadroom(workspaceValue: unknown, appValue: unknown): boolean {
  return normalizeHeadroom(workspaceValue) ?? normalizeHeadroom(appValue) ?? DEFAULT_HEADROOM;
}

/// One workspace's effective setting, as the daemon takes it
/// (`protocol::HeadroomWorkspace`).
export interface HeadroomWorkspace {
  /// The workspace's root: what a launch sends as `workspaceRoot`, never
  /// the worktree a session runs in.
  workspacePath: string;
  enabled: boolean;
}

type SwitchedWorkspace = Pick<Workspace, "rootPath" | "headroom" | "ssh">;

/// Every workspace's effective setting, for the daemon to hold a copy of.
///
/// Two kinds of workspace are left out, and both are left out rather than
/// sent as off, because the list is what the daemon keeps Headroom
/// running FOR:
///
/// - One with no root (the Scratchpad). It launches no agent into a
///   workspace, so there is nothing of its to decide.
/// - One on an ssh host. Its sessions are its host daemon's, and
///   compressing them would need a Headroom installed and supervised
///   there. Its own switch does not reach the local daemon, so it cannot
///   keep a local Headroom running for sessions that will never use it.
///
/// Two workspaces on one root -- the same repository opened twice -- are
/// one entry, and it is on when either is: the daemon keys its copy by
/// path, so it cannot tell them apart, and compressing a session the
/// human turned compression on for is the smaller of the two mistakes.
///
/// Sorted, so two lists naming the same workspaces are the same list
/// whatever order the sidebar has them in.
export function headroomWorkspaces(
  workspaces: readonly SwitchedWorkspace[],
  appDefault: unknown,
): HeadroomWorkspace[] {
  const byPath = new Map<string, boolean>();
  for (const ws of workspaces) {
    const path = ws.rootPath?.trim();
    if (!path || ws.ssh) continue;
    const enabled = resolveHeadroom(ws.headroom, appDefault);
    byPath.set(path, (byPath.get(path) ?? false) || enabled);
  }
  return [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([workspacePath, enabled]) => ({ workspacePath, enabled }));
}

/// One string per distinct list, for "is this what the daemon already
/// holds". Its only contract is that two lists share it exactly when
/// they are equal.
export function headroomWorkspacesKey(list: readonly HeadroomWorkspace[]): string {
  return JSON.stringify(list.map((entry) => [entry.workspacePath, entry.enabled]));
}

/// Headroom on this machine, as the daemon that has to execute it sees
/// it (`protocol::HeadroomStatus`). Every Headroom request answers with
/// one, taken AFTER whatever the request did.
export interface HeadroomStatus {
  /// `verified`, `too-old`, `absent` or `unavailable`.
  state: string;
  reason: string | null;
  newerThanTested: boolean;
  version: string | null;
  floor: string;
  pin: string;
  path: string | null;
  source: string | null;
  uvFound: boolean;
  /// Whether the daemon has been asked to keep Headroom running, which
  /// it is while any workspace has compression on.
  wanted: boolean;
  running: boolean;
  ready: boolean;
  port: number | null;
  restarts: number;
  lastError: string | null;
  lifetimeTokensSaved: number | null;
  install: { state: string; output: string } | null;
}
