// The Devices panel's state, one copy per window.
//
// A store rather than the panel's own `$state` because the footer row's
// badge counts connected Devices while the panel is CLOSED: the pushes
// have to be heard by something that lives as long as the sidebar. The
// panel reads the same stores, so what it draws and what the badge says
// come off one set. Pairing stays the panel's own: `DevicePairingRequested`
// is a question, and a question nobody is being asked is not a
// notification (see the panel).
//
// Presence (v63) lives here for the badge's reason: a terminal's typing
// marker and a Device-started tab's label are read with the panel closed,
// and this listener is what places a session a Device started. The rules are
// `devicePresence.ts`'s.

import { derived, get, writable, type Readable } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as backend from "$lib/core/backend";
import { daemonCompat, layoutState, placeDeviceStartedSession } from "$lib/core/layoutState";
import type { DeviceList, DevicePresence, RelayState } from "$lib/core/remoteAccess";
import {
  devicesAskable,
  devicesBadge,
  withConnected,
  withoutConnected,
} from "$lib/core/devicesPanel";
import {
  deviceNameBySession,
  presencesFromList,
  sessionsToPlace,
  startedWhere,
  typingBySession,
  typingChangesAt,
  workspaceForStarted,
  type Presences,
} from "$lib/core/devicePresence";
import { runsRailsFor } from "$lib/shell/appDuty";

const list = writable<DeviceList | null>(null);
const connected = writable<ReadonlySet<string>>(new Set());
const relay = writable<RelayState | null>(null);
const failure = writable<string | null>(null);
/// Every Device's presence (v63): seeded by the list read, replaced per
/// Device by each push, which carries the whole of it.
const presences = writable<Presences>({});
/// The clock the typing markers are read against. Moved only when a marker
/// could change: a push, and the moment the freshest typing goes stale.
const typingClock = writable(Date.now());

export const deviceList: Readable<DeviceList | null> = { subscribe: list.subscribe };
export const connectedDevices: Readable<ReadonlySet<string>> = { subscribe: connected.subscribe };
export const deviceRelayState: Readable<RelayState | null> = { subscribe: relay.subscribe };
export const devicesFailure: Readable<string | null> = { subscribe: failure.subscribe };

export const devicePresences: Readable<Presences> = { subscribe: presences.subscribe };

/// Which Device started each session, by name: what its tab is labelled
/// with. Needs the list for the names, so it is empty until the first read.
export const deviceNameBySessionId: Readable<Record<string, string>> = derived(
  [list, presences],
  ([$list, $presences]) => deviceNameBySession($list?.devices ?? [], $presences)
);

/// The Devices typing into each session right now: the terminal marker.
export const typingBySessionId: Readable<Record<string, string[]>> = derived(
  [list, presences, typingClock],
  ([$list, $presences, $now]) => typingBySession($list?.devices ?? [], $presences, $now)
);

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
    // Over what the pushes said: a read is the daemon's whole account. A
    // push that crossed this read in flight is lost only until the Device
    // does anything else, since every push is the whole presence again --
    // and placement cannot repeat on it (`handledStarts`).
    presences.set(presencesFromList(next.devices));
    scheduleTypingClock();
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

let typingTimer: ReturnType<typeof setTimeout> | null = null;

/// Moves the typing clock now, and again when the freshest typing goes
/// stale -- one timer, re-aimed by every change, and none while nobody is
/// typing.
function scheduleTypingClock(): void {
  if (typingTimer !== null) clearTimeout(typingTimer);
  typingTimer = null;
  const now = Date.now();
  typingClock.set(now);
  const changesAt = typingChangesAt(get(presences), now);
  if (changesAt !== null) {
    typingTimer = setTimeout(scheduleTypingClock, Math.max(changesAt - now, 0) + 50);
  }
}

/// Sessions this window has placed, or decided not to (another window
/// shows that workspace, or no workspace here holds it). Each is handled
/// once: a Device's presence keeps listing what it started.
const handledStarts = new Set<string>();

/// A Device's presence was pushed: take it, and place any session it newly
/// started as a tab labelled with the Device. The window that places it is
/// the one showing its workspace -- the rail rule (`runsRailsFor`), since
/// every window holds every workspace and exactly one should add the tab.
///
/// Each new start, and what this window did with it, goes to the console:
/// a tab that never appears leaves nothing else behind to read. Typing
/// pushes (every two seconds) do not.
function presencePushed(deviceId: string, presence: DevicePresence, sinceSeconds: number): void {
  presences.update((all) => ({ ...all, [deviceId]: presence }));
  scheduleTypingClock();
  const workspaces = get(layoutState).workspaces;
  for (const started of sessionsToPlace(presence, handledStarts, sinceSeconds)) {
    handledStarts.add(started.sessionId);
    const said = `gavin: device ${deviceId} started session ${started.sessionId} (${startedWhere(started)})`;
    const workspaceId = workspaceForStarted(workspaces, started);
    if (workspaceId === null) {
      console.warn(`${said}: not placed, no workspace here holds it`);
    } else if (!runsRailsFor(workspaceId)) {
      console.info(`${said}: left to the window showing workspace ${workspaceId}`);
    } else if (placeDeviceStartedSession(workspaceId, started.sessionId, started.workspaceAgent === true)) {
      console.info(`${said}: placed in workspace ${workspaceId}`);
    } else {
      console.info(`${said}: not placed, it is already showing`);
    }
  }
  // A Device this window has not listed yet has a name nobody can show.
  if (!get(list)?.devices.some((d) => d.deviceId === deviceId)) void refreshDeviceList();
}

/// Starts listening; returns the stop. Called once, from the sidebar.
export function watchDevices(): () => void {
  // A little before now: the daemon stamps a start in whole seconds.
  const listeningSince = Math.floor(Date.now() / 1000) - 2;
  const stop: Promise<UnlistenFn>[] = [
    listen<[string, DevicePresence]>("device-presence-changed", (event) => {
      const [deviceId, presence] = event.payload;
      presencePushed(deviceId, presence, listeningSince);
    }),
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
    if (typingTimer !== null) clearTimeout(typingTimer);
    typingTimer = null;
  };
}
