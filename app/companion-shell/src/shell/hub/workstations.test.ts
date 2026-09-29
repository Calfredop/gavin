import { describe, expect, it } from "vitest";
import { DEMO } from "$companion/demo/sampleData";
import { keepPairing } from "$shell/hub/paired";
import { DEMO_WORKSTATION, hubWorkstations, isWorkstationHost, stateLabel } from "$shell/hub/workstations";

const paired = keepPairing(
  {
    workstationKey: "4a".repeat(32),
    relays: ["ws://127.0.0.1:8443"],
    relayAdmission: null,
    deviceId: "dev-1",
    notificationKey: "5a".repeat(32),
  },
  [],
  Date.UTC(2026, 8, 29)
);

describe("the Workstations hub's list", () => {
  it("lists the Demo Workstation, under the identity its channel answers to", () => {
    expect(hubWorkstations()).toEqual([DEMO_WORKSTATION]);
    expect({ id: DEMO_WORKSTATION.id, name: DEMO_WORKSTATION.name, demo: DEMO_WORKSTATION.demo }).toEqual(
      DEMO.workstation
    );
  });

  it("lists paired Workstations first, by their names, and not yet openable", () => {
    const list = hubWorkstations([{ ...paired, name: "Studio Mac" }], () => "29 Sept");
    expect(list).toEqual([
      {
        id: paired.id,
        name: "Studio Mac",
        demo: false,
        summary: "Paired on 29 Sept. Opening it from this phone comes in a later build.",
        state: "paired",
        openable: false,
      },
      DEMO_WORKSTATION,
    ]);
    expect(stateLabel("paired")).toBe("Paired");
    expect(DEMO_WORKSTATION.openable).toBe(true);
  });

  it("gives every listed Workstation an id that can be its bundle's host", () => {
    for (const ws of hubWorkstations([paired])) expect(isWorkstationHost(ws.id)).toBe(true);
  });

  it("refuses an id that could not be a host of its own", () => {
    for (const id of ["", "Demo", "demo.evil", "demo/..", "-demo", "demo-", "a".repeat(64), "demo:1"]) {
      expect(isWorkstationHost(id)).toBe(false);
    }
    expect(isWorkstationHost("a".repeat(63))).toBe(true);
  });
});
