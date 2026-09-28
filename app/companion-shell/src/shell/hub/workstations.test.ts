import { describe, expect, it } from "vitest";
import { DEMO } from "$companion/demo/sampleData";
import { DEMO_WORKSTATION, hubWorkstations, isWorkstationHost } from "$shell/hub/workstations";

describe("the Workstations hub's list", () => {
  it("lists the Demo Workstation, under the identity its channel answers to", () => {
    expect(hubWorkstations()).toEqual([DEMO_WORKSTATION]);
    expect({ id: DEMO_WORKSTATION.id, name: DEMO_WORKSTATION.name, demo: DEMO_WORKSTATION.demo }).toEqual(
      DEMO.workstation
    );
  });

  it("gives every listed Workstation an id that can be its bundle's host", () => {
    for (const ws of hubWorkstations()) expect(isWorkstationHost(ws.id)).toBe(true);
  });

  it("refuses an id that could not be a host of its own", () => {
    for (const id of ["", "Demo", "demo.evil", "demo/..", "-demo", "demo-", "a".repeat(64), "demo:1"]) {
      expect(isWorkstationHost(id)).toBe(false);
    }
    expect(isWorkstationHost("a".repeat(63))).toBe(true);
  });
});
