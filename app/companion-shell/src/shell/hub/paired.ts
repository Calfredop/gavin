// The Workstations this Device has paired with, as the hub keeps them.
//
// A record is what the core handed back when the desk confirmed
// (`KeptWorkstation`: the pinned key, the Relays, the admission token, the
// Device's id there and the notification key), plus what the phone adds:
// an id the hub and a bundle's origin can use, a name, and when.
//
// The records live natively (`$shell/native/workstations`): in the keychain
// on iOS and sealed by a Keystore key on Android, because the notification
// key is a secret, and because the web view's own storage is the OS's to
// clear. The native side stores each as opaque JSON; what a record must
// hold is decided here, and one that does not hold it is left out rather
// than half-shown.
import type { KeptWorkstation } from "$shell/core/core";
import { isWorkstationHost } from "$shell/hub/workstations";
import type { WorkstationsPlugin } from "$shell/native/workstations";

export interface PairedWorkstation extends KeptWorkstation {
  /// `ws-` and the first 16 hex digits of the Workstation's key: stable
  /// while the key is, and a DNS label, as a bundle's origin needs.
  id: string;
  name: string;
  /// Milliseconds since the epoch.
  pairedAt: number;
}

/// The longest name the hub keeps for a Workstation.
export const MAX_WORKSTATION_NAME = 64;

const DEFAULT_NAME = "Workstation";

export function workstationId(workstationKey: string): string {
  return `ws-${workstationKey.slice(0, 16).toLowerCase()}`;
}

/// "Workstation", or the first "Workstation N" no paired one is called.
export function defaultName(paired: PairedWorkstation[]): string {
  const taken = new Set(paired.map((ws) => ws.name));
  if (!taken.has(DEFAULT_NAME)) return DEFAULT_NAME;
  for (let n = 2; ; n++) if (!taken.has(`${DEFAULT_NAME} ${n}`)) return `${DEFAULT_NAME} ${n}`;
}

/// The record for a Workstation the desk just paired this Device with.
/// Pairing again with a Workstation already kept replaces what the phone
/// held -- the desk replaced its row too -- and keeps the name.
export function keepPairing(kept: KeptWorkstation, paired: PairedWorkstation[], now: number): PairedWorkstation {
  const id = workstationId(kept.workstationKey);
  const before = paired.find((ws) => ws.id === id);
  return {
    id,
    name: before?.name ?? defaultName(paired),
    pairedAt: now,
    workstationKey: kept.workstationKey,
    relays: [...kept.relays],
    relayAdmission: kept.relayAdmission,
    deviceId: kept.deviceId,
    notificationKey: kept.notificationKey,
  };
}

/// `record` under a new name. A name that is empty once trimmed keeps
/// the old one.
export function renamed(record: PairedWorkstation, name: string): PairedWorkstation {
  const trimmed = Array.from(name.trim()).slice(0, MAX_WORKSTATION_NAME).join("");
  return trimmed ? { ...record, name: trimmed } : record;
}

const HEX_32 = /^[0-9a-f]{64}$/;

/// A stored record, or null when it is not one this build can use.
export function readRecord(json: string): PairedWorkstation | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const r = value as Partial<PairedWorkstation> | null;
  if (!r || typeof r !== "object") return null;
  const ok =
    typeof r.workstationKey === "string" &&
    HEX_32.test(r.workstationKey) &&
    r.id === workstationId(r.workstationKey) &&
    isWorkstationHost(r.id) &&
    typeof r.name === "string" &&
    r.name.length > 0 &&
    typeof r.pairedAt === "number" &&
    Array.isArray(r.relays) &&
    r.relays.every((url) => typeof url === "string") &&
    (r.relayAdmission === null || typeof r.relayAdmission === "string") &&
    typeof r.deviceId === "string" &&
    r.deviceId.length > 0 &&
    typeof r.notificationKey === "string" &&
    HEX_32.test(r.notificationKey);
  if (!ok) return null;
  const record = r as PairedWorkstation;
  return {
    id: record.id,
    name: record.name,
    pairedAt: record.pairedAt,
    workstationKey: record.workstationKey,
    relays: record.relays,
    relayAdmission: record.relayAdmission,
    deviceId: record.deviceId,
    notificationKey: record.notificationKey,
  };
}

export interface PairedStore {
  /// Every usable record, oldest pairing first.
  list(): Promise<PairedWorkstation[]>;
  save(record: PairedWorkstation): Promise<void>;
}

export function pairedStore(plugin: Pick<WorkstationsPlugin, "list" | "save">): PairedStore {
  return {
    async list() {
      const { records } = await plugin.list();
      return records
        .map(readRecord)
        .filter((r): r is PairedWorkstation => r !== null)
        .sort((a, b) => a.pairedAt - b.pairedAt);
    },
    save: (record) => plugin.save({ id: record.id, record: JSON.stringify(record) }),
  };
}
