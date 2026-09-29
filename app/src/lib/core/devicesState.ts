// The Devices panel's state, one copy per window.
//
// A store rather than the panel's own `$state` because the footer row's
// badge counts connected Devices while the panel is CLOSED: the pushes
// have to be heard by something that lives as long as the sidebar. The
// panel reads the same stores, so what it draws and what the badge says
// come off one set. Pairing stays the panel's own: `DevicePairingRequested`
// is a question, and a question nobody is being asked is not a
// notification (see the panel).

import { derived, get, writable, type Readable } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as backend from "$lib/core/backend";
import { daemonCompat } from "$lib/core/layoutState";
import type { DeviceList, RelayState } from "$lib/core/remoteAccess";
import {
  devicesAskable,
  devicesBadge,
  withConnected,
  withoutConnected,
} from "$lib/core/devicesPanel";

const list = writable<DeviceList | null>(null);
const connected = writable<ReadonlySet<string>>(new Set());
const relay = writable<RelayState | null>(null);
const failure = writable<string | null>(null);

export const deviceList: Readable<DeviceList | null> = { subscribe: list.subscribe };
export const connectedDevices: Readable<ReadonlySet<string>> = { subscribe: connected.subscribe };
export const deviceRelayState: Readable<RelayState | null> = { subscribe: relay.subscribe };
export const devicesFailure: Readable<string | null> = { subscribe: failure.subscribe };

/// The footer row's badge text, or null.
export const devicesBadgeText: Readable<string | null> = derived(
  [list, connected],
  ([$list, $connected]) => devicesBadge($list?.devices ?? null, $connected)
);

let token = 0;

/// Re-reads the trust store. A no-op against a daemon too old to be asked,
/// so a footer that mounts before any verdict does not send `ListDevices`
/// to a daemon nobody has classified.
export async function refreshDeviceList(): Promise<void> {
  if (!devicesAskable(get(daemonCompat))) return;
  const mine = ++token;
  try {
    const next = await backend.listDevices();
    if (mine !== token) return;
    failure.set(null);
    list.set(next);
    // A revoked Device is no longer connected whatever the last push said.
    const revoked = next.devices.filter((d) => d.revokedAt !== null).map((d) => d.deviceId);
    if (revoked.length > 0) {
      connected.update((set) => revoked.reduce((s, id) => withoutConnected(s, id), set));
    }
  } catch (e) {
    if (mine === token) failure.set(String(e instanceof Error ? e.message : e));
  }
}

export async function refreshDeviceRelay(): Promise<void> {
  try {
    relay.set(await backend.getRelayState());
  } catch {
    relay.set(null); // not knowing is not a failure to connect
  }
}

/// Starts listening; returns the stop. Called once, from the sidebar.
export function watchDevices(): () => void {
  const stop: Promise<UnlistenFn>[] = [
    listen<string>("device-connected", (event) => {
      connected.update((set) => withConnected(set, event.payload));
      void refreshDeviceList();
    }),
    listen<string>("device-disconnected", (event) => {
      connected.update((set) => withoutConnected(set, event.payload));
      void refreshDeviceList();
    }),
    // A refusal is on the row the list returns, so the list is re-read
    // rather than patched: the panel then draws one account of the store.
    listen<[string, unknown]>("device-refusal-changed", () => void refreshDeviceList()),
    listen<RelayState>("relay-state-changed", (event) => relay.set(event.payload)),
  ];
  // The first read waits for a verdict (see refreshDeviceList).
  const unsubscribe = daemonCompat.subscribe(() => {
    if (get(list) === null) void refreshDeviceList();
  });
  return () => {
    unsubscribe();
    for (const p of stop) void p.then((off) => off());
  };
}
