// Keeps the daemon's copy of the compression switch current.
//
// The switch is the app's: a workspace's own setting in config.json,
// falling through to an app-wide default (`compression.ts`). The daemon
// holds a copy of what each workspace COMES TO, because it is the one
// deciding at spawn and a session another agent spawns over MCP never
// passes through the app. This module is what tells it, whenever the
// answer changes, and it runs Headroom while any workspace is on.
//
// The decision is `compressionPush`, and it is pure. The rest is a
// subscription.

import { get } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as backend from "$lib/core/backend";
import {
  daemonCompat,
  headroomDefault,
  headroomDefaultKnown,
  layoutState,
} from "$lib/core/layoutState";
import { featureBlockedReason, type DaemonCompat } from "$lib/core/daemonCompat";
import {
  headroomWorkspaces,
  headroomWorkspacesKey,
  normalizeHeadroom,
  type HeadroomWorkspace,
} from "$lib/agents/compression";
import type { Workspace } from "$lib/core/workspace";

/// Why the daemon cannot be told, or null when it can. `SetHeadroomWorkspaces`
/// is a new request type, so an older daemon is refused it on the wire
/// anyway; this is what keeps the driver from asking, and taking a
/// version error on every settings change.
export function compressionSwitchBlocked(compat: DaemonCompat | null): string | null {
  return featureBlockedReason(compat, "compressedLaunch");
}

export interface CompressionPushInput {
  /// Whether the workspaces have loaded. Before they have, the list is
  /// empty because nobody has read it, not because nothing is open.
  ready: boolean;
  workspaces: readonly Pick<Workspace, "rootPath" | "headroom" | "ssh">[];
  appDefault: boolean | null;
  /// Whether `appDefault` has been read (`headroomDefaultKnown`).
  defaultKnown: boolean;
  compat: DaemonCompat | null;
  /// The key of the list the daemon was last told, or null when it has
  /// been told nothing this connection.
  told: string | null;
}

export interface CompressionPush {
  list: HeadroomWorkspace[];
  key: string;
}

/// What to tell the daemon now, or null for nothing.
///
/// Three of the four reasons for nothing are about not knowing yet, and
/// they matter more than they look: the list REPLACES the daemon's copy,
/// so one resolved against workspaces that have not loaded, or a default
/// nobody has read, says compression is off everywhere -- and the daemon
/// would stop the Headroom every running agent is talking through. The
/// daemon's copy is persisted, so saying nothing leaves it on the last
/// thing it was told, which is the right answer until there is a better
/// one.
export function compressionPush(input: CompressionPushInput): CompressionPush | null {
  if (!input.ready || !input.defaultKnown) return null;
  // Not connected yet, which `featureBlockedReason` reads as "not
  // blocked": there is nobody to tell.
  if (!input.compat) return null;
  if (compressionSwitchBlocked(input.compat)) return null;
  const list = headroomWorkspaces(input.workspaces, input.appDefault);
  const key = headroomWorkspacesKey(list);
  if (key === input.told) return null;
  return { list, key };
}

/// Loads the app-wide default and keeps it current. The listener goes up
/// first, so a change made between the read and the subscription is not
/// lost; and a read that answers AFTER a change was heard is dropped,
/// because it may have been served before that change was written
/// (`initRemoteAccess`'s shape, for its reason).
///
/// Every window runs this, not only the one that tells the daemon: the
/// default is what a Settings panel shows, and the duty can be handed to
/// a window that has been open all along.
export async function initCompression(): Promise<UnlistenFn> {
  let heard = false;
  const unlisten = await listen<boolean | null>("headroom-default-changed", (event) => {
    heard = true;
    headroomDefault.set(normalizeHeadroom(event.payload));
    headroomDefaultKnown.set(true);
  });
  try {
    const enabled = await backend.getHeadroomDefault();
    if (!heard) {
      headroomDefault.set(normalizeHeadroom(enabled));
      headroomDefaultKnown.set(true);
    }
  } catch {
    // A read that failed leaves the default unknown, and the daemon on
    // the last list it was told.
  }
  return unlisten;
}

let told: string | null = null;
let telling = false;
let tellAgain = false;

/// Tells the daemon whatever it has not been told, once, however many
/// emissions asked. Collapsed into a single replay -- the shape the
/// scheduler's tick and the develop sweep both use -- so a change that
/// arrives while a push is in flight is the next thing sent rather than
/// the thing nobody looked at.
async function tell(): Promise<void> {
  if (telling) {
    tellAgain = true;
    return;
  }
  telling = true;
  try {
    do {
      tellAgain = false;
      const state = get(layoutState);
      const push = compressionPush({
        ready: state.status === "ready",
        workspaces: state.workspaces,
        appDefault: get(headroomDefault),
        defaultKnown: get(headroomDefaultKnown),
        compat: get(daemonCompat),
        told,
      });
      if (!push) continue;
      try {
        await backend.setHeadroomWorkspaces(push.list);
        told = push.key;
      } catch {
        // Not recorded as told, so the next emission tries again. Not
        // `setError` either: a daemon that would not take the list has
        // launched nothing differently, and the launch that finds
        // Headroom not ready says so on the session.
      }
    } while (tellAgain);
  } finally {
    telling = false;
  }
}

/// Tells the daemon now and whenever the answer changes. Run by the
/// window holding the app's duties (`whileHoldingAppDuties`): the list
/// replaces the daemon's copy whole, so it wants one teller.
///
/// A new connection is told from the start. The daemon that answers
/// after a restart may be a newer build with no copy of its own, and
/// `told` describes a conversation with the one before it.
export function startCompressionSwitch(): () => void {
  told = null;
  const stops = [
    layoutState.subscribe(() => void tell()),
    headroomDefault.subscribe(() => void tell()),
    headroomDefaultKnown.subscribe(() => void tell()),
    daemonCompat.subscribe(() => {
      told = null;
      void tell();
    }),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
