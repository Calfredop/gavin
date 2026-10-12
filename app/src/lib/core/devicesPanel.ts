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
import { relativeTime } from "$lib/hub/appHub";
import {
  deviceRows,
  remoteAccessBlocked,
  type DeviceInfo,
  type DeviceRow,
} from "$lib/core/remoteAccess";
import type { DeviceIndicatorState } from "$lib/ui/indicators";
import { presenceLine, type PresenceNaming, type Presences } from "$lib/core/devicePresence";
import { ownsText } from "$lib/core/sessionOwnership";

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

/// What a row says of the daemon's last refusal of that Device (v62).
export interface RefusalNotice {
  /// Which badge `ui/indicators.ts` draws it as.
  badge: DeviceIndicatorState;
  /// The row's words: "proof failed · 2m ago".
  text: string;
  /// What it means and what to do, for the badge's bubble.
  tip: string;
  /// The one worth stopping for: a good row whose Noise key answered a
  /// handshake and could not sign. The panel keeps Revoke beside it.
  alarming: boolean;
}

/// The words for a refusal, or null for a row the daemon has not refused.
///
/// A failed proof is the alarm. The handshake proved someone holds the
/// Device's Noise key and the signature proved it is not the phone, which
/// by ADR 0001's reasoning is a copied key -- so it is said as what it is,
/// and stays `alarming` only while the row is otherwise good: a Device
/// already revoked has had the button pressed.
///
/// The others are a Device the desk already knows being told no, worth
/// showing and not worth an alarm.
export function refusalNotice(d: DeviceInfo, nowMs: number): RefusalNotice | null {
  const refusal = d.lastRefusal;
  if (!refusal) return null;
  const age = relativeTime(refusal.at * 1000, nowMs);
  const good = d.revokedAt === null && !d.stale;
  const said = (badge: DeviceIndicatorState, what: string, tip: string, alarming = false) => ({
    badge,
    text: `${what} · ${age}`,
    tip,
    alarming,
  });
  switch (refusal.reason) {
    case "unlock":
      return said(
        "proof_failed",
        "proof failed",
        good
          ? "Something holding this Device's key connected and could not sign with the phone's hardware key. That is what a copied key looks like. If it was not you, revoke this Device."
          : "Something holding this Device's key connected and could not sign with the phone's hardware key. The Device is not trusted now, so it was refused anyway.",
        good
      );
    case "revoked":
      return said(
        "refused",
        "tried to connect, revoked",
        "This Device was revoked at the desk and is still trying to connect."
      );
    case "stale":
      return said(
        "refused",
        "tried to connect, not seen for 90 days",
        "This Device was unseen for ninety days and was refused. Pair it again to use it."
      );
    case "pair-again":
      return said(
        "refused",
        "pair again",
        "This Device was paired before Devices held a hardware key, and cannot connect as it is. Pair it again."
      );
    case "busy":
      return said(
        "refused",
        "too many connections",
        "This Device already held as many connections as one may, and another was refused."
      );
    case "not-paired":
      return said("refused", "not paired", "The Workstation held no row for this Device when it connected.");
    default:
      return said("refused", "refused", "The Workstation refused this Device a connection.");
  }
}

/// Why the panel cannot say a Device was refused, or null. Read beside the
/// list: against a daemon older than v62 a row with no refusal is not a
/// clean record, only one nobody kept.
export function refusalsBlocked(compat: DaemonCompat | null): string | null {
  return featureBlockedReason(compat, "deviceRefusals");
}

/// Why the panel cannot say where Devices are, or null. Read beside the
/// list, for `refusalsBlocked`'s reason: against a daemon older than v63 a
/// row with no presence line is not a Device doing nothing.
export function presenceBlocked(compat: DaemonCompat | null): string | null {
  return featureBlockedReason(compat, "devicePresence");
}

export interface PanelRow extends DeviceRow {
  connected: boolean;
  /// What the state column says: "Connected", or "seen 3w ago".
  state: string;
  /// The daemon's last refusal of this Device, or null.
  refusal: RefusalNotice | null;
  /// Where it is and what it is doing (`devicePresence.ts`'s line), or null.
  presence: string | null;
  /// "owns 2 sessions" (v68), or null for none.
  owns: string | null;
  /// Whether the desk's notifications reach it (v67). Only drawn where
  /// `pushGatewayBlocked` is null.
  notifies: boolean;
}

/// The list the panel draws: `deviceRows`' order and dimming, plus whether
/// each row is connected now. A revoked or stale row is never "connected".
/// With `naming`, each row also carries its presence line; with `owned`
/// (sessions per Device, `ownedCountByDevice`), how many sessions it owns.
export function panelRows(
  devices: DeviceInfo[],
  connected: ReadonlySet<string>,
  nowMs: number,
  presences: Presences = {},
  naming: PresenceNaming | null = null,
  owned: Record<string, number> = {}
): PanelRow[] {
  const live = new Set(devices.filter(admitted).map((d) => d.deviceId));
  const byId = new Map(devices.map((d) => [d.deviceId, d]));
  const rows = deviceRows(devices, nowMs);
  const sorted = rows.map((row) => {
    const isConnected = live.has(row.deviceId) && connected.has(row.deviceId);
    return {
      ...row,
      connected: isConnected,
      state: isConnected ? "Connected" : `seen ${row.lastSeen}`,
      refusal: refusalNotice(byId.get(row.deviceId)!, nowMs),
      presence: naming ? presenceLine(presences[row.deviceId], isConnected, naming, nowMs) : null,
      owns: ownsText(owned[row.deviceId]),
      notifies: !row.dimmed && byId.get(row.deviceId)!.notifies === true,
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
