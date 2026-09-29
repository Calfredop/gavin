// The shell's store of paired Workstations (companion-21).
//
// Registered on the shell's own bridge only, like the Device's keys: a
// bundle's webview has no bridge, so no bundle reads another Workstation's
// record, or its own notification key.
//
// Each record is opaque JSON to the native side, kept under its
// Workstation's id; `hub/paired.ts` decides what one holds.
//
// - **iOS**: one keychain item a record, this device only, readable after
//   the first unlock -- so the notification service extension can open a
//   push on a locked phone once it exists.
// - **Android**: one file of records in `noBackupFilesDir`, sealed by a
//   Keystore AES key, with backup and device transfer off.
//
// They go with the Device's keys: deleting the keys deletes them, and so
// does the first launch after a reinstall. A record names the Device the
// Workstation paired, and without its keys this phone is not that Device.
import { registerPlugin } from "@capacitor/core";

export interface WorkstationsPlugin {
  list(): Promise<{ records: string[] }>;
  /// Adds or replaces the record under `id`.
  save(options: { id: string; record: string }): Promise<void>;
  remove(options: { id: string }): Promise<void>;
}

export const Workstations = registerPlugin<WorkstationsPlugin>("Workstations");
