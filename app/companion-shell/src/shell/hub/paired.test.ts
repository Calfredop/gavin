import { describe, expect, it } from "vitest";
import type { KeptWorkstation } from "$shell/core/core";
import {
  defaultName,
  keepPairing,
  MAX_WORKSTATION_NAME,
  pairedStore,
  readRecord,
  renamed,
  workstationId,
  type PairedWorkstation,
} from "$shell/hub/paired";
import { isWorkstationHost } from "$shell/hub/workstations";

const kept = (key = "4a".repeat(32)): KeptWorkstation => ({
  workstationKey: key,
  relays: ["ws://127.0.0.1:8443"],
  relayAdmission: "let-me-in",
  deviceId: "dev-1",
  notificationKey: "5a".repeat(32),
});

describe("a paired Workstation, as the hub keeps it", () => {
  it("takes an id from the Workstation's key that can be its bundle's host", () => {
    const id = workstationId("4A".repeat(32));
    expect(id).toBe("ws-4a4a4a4a4a4a4a4a");
    expect(isWorkstationHost(id)).toBe(true);
  });

  it("names a new Workstation, and never two the same", () => {
    const first = keepPairing(kept("01".repeat(32)), [], 1000);
    expect(first).toEqual({
      id: workstationId("01".repeat(32)),
      name: "Workstation",
      pairedAt: 1000,
      ...kept("01".repeat(32)),
      // A core older than v69 hands back no direct listener: none kept.
      direct: [],
      directPin: null,
    });
    const second = keepPairing(kept("02".repeat(32)), [first], 2000);
    expect(second.name).toBe("Workstation 2");
    expect(defaultName([first, second, { ...second, name: "Workstation 3" }])).toBe("Workstation 4");
  });

  it("replaces what it held when the same Workstation pairs again, and keeps its name", () => {
    const before = { ...keepPairing(kept(), [], 1000), name: "Studio Mac" };
    const again = keepPairing({ ...kept(), deviceId: "dev-2", notificationKey: "6b".repeat(32) }, [before], 5000);
    expect(again).toMatchObject({ id: before.id, name: "Studio Mac", deviceId: "dev-2", pairedAt: 5000 });
  });

  // ADR 0009: the direct listener's addresses and pin are kept with the
  // Relays, and a record kept before them still reads.
  it("keeps the direct listener the QR named, and reads a record kept before it", () => {
    const withDirect = { ...kept(), direct: ["wss://192.168.1.20:8445"], directPin: "cd".repeat(32) };
    const record = keepPairing(withDirect, [], 1);
    expect(record.direct).toEqual(["wss://192.168.1.20:8445"]);
    expect(record.directPin).toBe("cd".repeat(32));
    expect(readRecord(JSON.stringify(record))).toEqual(record);

    const { direct: _d, directPin: _p, ...old } = record;
    expect(readRecord(JSON.stringify(old))).toEqual({ ...record, direct: [], directPin: null });

    expect(readRecord(JSON.stringify({ ...record, direct: "wss://192.168.1.20:8445" }))).toBeNull();
    expect(readRecord(JSON.stringify({ ...record, direct: [7] }))).toBeNull();
    expect(readRecord(JSON.stringify({ ...record, directPin: 7 }))).toBeNull();
  });

  it("renames, trimmed and bounded, and keeps the old name for an empty one", () => {
    const record = keepPairing(kept(), [], 1);
    expect(renamed(record, "  Studio Mac ").name).toBe("Studio Mac");
    expect(renamed(record, "   ").name).toBe("Workstation");
    expect(Array.from(renamed(record, "é".repeat(100)).name)).toHaveLength(MAX_WORKSTATION_NAME);
  });

  it("reads back what it stored, and leaves out a record it cannot use", () => {
    const record = keepPairing(kept(), [], 1);
    expect(readRecord(JSON.stringify(record))).toEqual(record);
    expect(readRecord(JSON.stringify({ ...record, extra: 1 }))).toEqual(record);
    for (const broken of [
      "not json",
      "null",
      JSON.stringify({ ...record, id: "ws-somebody-else" }),
      JSON.stringify({ ...record, notificationKey: "short" }),
      JSON.stringify({ ...record, workstationKey: "zz".repeat(32) }),
      JSON.stringify({ ...record, deviceId: "" }),
      JSON.stringify({ ...record, relays: "ws://127.0.0.1" }),
      JSON.stringify({ ...record, name: "" }),
      JSON.stringify({ ...record, pairedAt: "yesterday" }),
    ]) {
      expect(readRecord(broken)).toBeNull();
    }
  });

  it("stores each record under its id, and lists them oldest first", async () => {
    const held = new Map<string, string>();
    const store = pairedStore({
      list: async () => ({ records: [...held.values(), "garbage"] }),
      save: async ({ id, record }) => void held.set(id, record),
    });
    const late = keepPairing(kept("02".repeat(32)), [], 2000);
    const early = keepPairing(kept("01".repeat(32)), [], 1000);
    await store.save(late);
    await store.save(early);
    expect([...held.keys()]).toEqual([late.id, early.id]);
    expect(await store.list()).toEqual<PairedWorkstation[]>([early, late]);
  });
});
