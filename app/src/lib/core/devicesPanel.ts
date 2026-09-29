// The Devices panel and its footer row, as logic. `DevicesPanel.svelte` and
// the sidebar's footer row are templates over this and hold no rule of
// their own (CLAUDE.md's split).
//
// Pairing, the Device list and revocation used to live in Settings'
// Remote access section. They moved here because they are something a human
// DOES at the desk, again and again, and Settings is where a switch is
// flipped once. What stayed there is the switch, the Relay and the
// admission token. The pairing state machine, the copy and the row
// presentation are still `remoteAccess.ts`'s; this module adds only what
// the move made new: which Devices are connected, and the number the footer
// row wears.
//
// "Connected" has no read-back. The daemon says so once, with a
// `DeviceConnected` or `DeviceDisconnected` push, and keeps no list the app
// can ask for, so the set is built from pushes and starts empty. A Device
// already connected when the app starts therefore reads as last-seen until
// it reconnects -- an undercount, never an invented connection.

import { featureBlockedReason, type DaemonCompat } from "$lib/core/daemonCompat";
import {
  deviceRows,
  remoteAccessBlocked,
  type DeviceInfo,
  type DeviceRow,
} from "$lib/core/remoteAccess";

/// The footer row's label and the panel's title. One constant, so the row
/// and the panel cannot name themselves differently.
export const DEVICES_LABEL = "Devices";

/// A Device the daemon would let connect: not revoked, not stale. A revoked
/// Device's connection is dropped by the daemon, but the disconnect push
/// and the refreshed list are two messages, and a row that says
/// "connected" for a Device the list calls revoked is the disagreement
/// this rules out.
function admitted(d: DeviceInfo): boolean {
  return d.revokedAt === null && !d.stale;
}

/// The connected set after a `DeviceConnected` push. A new Set, so a store
/// holding it sees the change.
export function withConnected(set: ReadonlySet<string>, deviceId: string): Set<string> {
  return new Set(set).add(deviceId);
}

/// ...and after a `DeviceDisconnected` push.
export function withoutConnected(set: ReadonlySet<string>, deviceId: string): Set<string> {
  const next = new Set(set);
  next.delete(deviceId);
  return next;
}

/// How many paired Devices are connected right now: the footer badge. Ids
/// the list does not know (unpaired since, or a push that outran the
/// list) count for nothing.
export function connectedCount(
  devices: DeviceInfo[] | null,
  connected: ReadonlySet<string>
): number {
  if (!devices) return 0;
  return devices.filter((d) => admitted(d) && connected.has(d.deviceId)).length;
}

/// The badge text, or null for none: a quiet desk keeps a plain row rather
/// than a permanent "0" the eye learns to skip (the fleet strip's rule).
export function devicesBadge(
  devices: DeviceInfo[] | null,
  connected: ReadonlySet<string>
): string | null {
  const n = connectedCount(devices, connected);
  return n > 0 ? String(n) : null;
}

export function devicesBadgeTip(count: number): string {
  return count === 1 ? "1 Device connected" : `${count} Devices connected`;
}

export interface PanelRow extends DeviceRow {
  connected: boolean;
  /// What the state column says: "Connected", or "seen 3w ago".
  state: string;
}

/// The list the panel draws: `deviceRows`' order and dimming, plus whether
/// each row is connected now. A revoked or stale row is never "connected".
export function panelRows(
  devices: DeviceInfo[],
  connected: ReadonlySet<string>,
  nowMs: number
): PanelRow[] {
  const live = new Set(devices.filter(admitted).map((d) => d.deviceId));
  const rows = deviceRows(devices, nowMs);
  const sorted = rows.map((row) => {
    const isConnected = live.has(row.deviceId) && connected.has(row.deviceId);
    return {
      ...row,
      connected: isConnected,
      state: isConnected ? "Connected" : `seen ${row.lastSeen}`,
    };
  });
  // Connected first, then `deviceRows`' own order. Stable, so ties keep it.
  return sorted
    .map((row, i) => ({ row, i }))
    .sort((a, b) => Number(b.row.connected) - Number(a.row.connected) || a.i - b.i)
    .map(({ row }) => row);
}

/// Why the panel's controls are greyed, or null. The same gate the Settings
/// switch reads -- `FEATURE_MIN_VERSION.remoteAccess` -- because pairing and
/// listing are the requests it was added for.
export function devicesBlocked(compat: DaemonCompat | null): string | null {
  return remoteAccessBlocked(compat);
}

/// Whether the daemon can be asked at all; the state watcher's guard.
export function devicesAskable(compat: DaemonCompat | null): boolean {
  return featureBlockedReason(compat, "remoteAccess") === null;
}
