// The live state of every ssh host's link, and the two things a surface
// does about it: reconnect, and open the form that makes or edits an
// ssh workspace.
//
// The link itself is the Tauri host's (`app/src-tauri/src/remote.rs`).
// It speaks through `remote-link-ready` and `remote-link-lost`, which
// layoutState.ts listens for and hands here; the reducers that turn
// them into the map are pure and tested in sshWorkspace.ts. This module
// is the store, and the one call that crosses to the host.

import { writable } from "svelte/store";
import * as backend from "$lib/core/backend";
import type { Workspace } from "$lib/core/workspace";
import {
  markConnecting,
  markLost,
  markReady,
  seedConnecting,
  type SshLinks,
} from "$lib/workspace/sshWorkspace";

/// Host -> link state. Empty until `workspaces-ready` seeds it.
export const sshLinks = writable<SshLinks>({});

/// The payload of both link events, camelCase as the host serialises it
/// (`remote.rs::RemoteLinkEvent`). `workspaceId` is set on a ready event
/// and on a lost event about one workspace's connect; a link dropping
/// mid-flight names only the host, because every workspace on it is
/// affected.
export interface RemoteLinkEvent {
  host: string;
  workspaceId?: string | null;
  message?: string | null;
  hostOs?: string | null;
  /// The host daemon's protocol version, on a ready event.
  daemonVersion?: number | null;
}

export function handleRemoteLinkReady(event: RemoteLinkEvent): void {
  sshLinks.update((links) => markReady(links, event.host, event.hostOs, event.daemonVersion));
}

export function handleRemoteLinkLost(event: RemoteLinkEvent): void {
  sshLinks.update((links) => markLost(links, event.host, event.message));
}

/// Called with the workspaces `workspaces-ready` carried: the host links
/// each ssh workspace right after that event, so until its ready event
/// lands the honest state for each is "connecting".
export function seedSshLinks(workspaces: Workspace[]): void {
  sshLinks.update((links) => seedConnecting(links, workspaces));
}

/// Reconnect, and the first connect of a workspace just made an ssh one.
/// Marks the host connecting, asks the Tauri host to link the workspace
/// (it resolves the workspace's sessions on the host daemon, attaches
/// them, watches the root, and emits `workspaces-synced` plus
/// `remote-link-ready`), and answers with the error when there is one --
/// which is also recorded as the link's lost message, so the banner and
/// the badge say the same thing the button did.
export async function connectSshWorkspace(workspaceId: string, host: string): Promise<string | null> {
  sshLinks.update((links) => markConnecting(links, host));
  try {
    await backend.connectRemoteWorkspace(workspaceId);
    return null;
  } catch (e) {
    const message = String(e instanceof Error ? e.message : e);
    sshLinks.update((links) => markLost(links, host, message));
    return message;
  }
}

/// The ssh workspace form: closed, creating (`workspaceId: null`), or
/// editing the named workspace's host, root and daemon path. One store
/// because the form is reached from three places (the sidebar's corner,
/// the root control, a lost banner) and must not stack.
export const sshForm = writable<{ workspaceId: string | null } | null>(null);

export function openSshForm(workspaceId: string | null): void {
  sshForm.set({ workspaceId });
}

export function closeSshForm(): void {
  sshForm.set(null);
}
