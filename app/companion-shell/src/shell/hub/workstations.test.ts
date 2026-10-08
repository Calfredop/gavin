import { describe, expect, it } from "vitest";
import { DEMO } from "$companion/demo/sampleData";
import type { LiveState } from "$shell/hub/live";
import { keepPairing } from "$shell/hub/paired";
import { DEMO_WORKSTATION, hubWorkstations, isWorkstationHost } from "$shell/hub/workstations";

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

  it("lists paired Workstations first, by their names, locked until the Unlock, and not openable until ready", () => {
    const list = hubWorkstations([{ ...paired, name: "Studio Mac" }]);
    expect(list).toEqual([
      {
        id: paired.id,
        name: "Studio Mac",
        demo: false,
        summary: "Unlock to connect.",
        state: "locked",
        label: "Locked",
        openable: false,
        tryNow: false,
      },
      DEMO_WORKSTATION,
    ]);
    expect(DEMO_WORKSTATION.openable).toBe(true);
  });

  it("shows each paired Workstation's live state: ready, desktop app not running, asleep", () => {
    const other = keepPairing({ ...paired, workstationKey: "4b".repeat(32) }, [paired], 2);
    const third = keepPairing({ ...paired, workstationKey: "4c".repeat(32) }, [paired, other], 3);
    const list = hubWorkstations([paired, other, third], {
      [paired.id]: {
        state: "ready",
        items: [{ id: "a", workspace: "w", kind: "waiting", text: "t", target: null }],
      },
      [other.id]: { state: "desktop-app-not-running" },
      [third.id]: { state: "asleep" },
    });
    // Only a ready Workstation opens: its desktop app serves its UI. The
    // others can be tried again now.
    expect(list.slice(0, 3).map((ws) => ws.openable)).toEqual([true, false, false]);
    expect(list.map((ws) => ws.tryNow ?? false)).toEqual([false, true, true, false]);
    expect(list.slice(0, 3).map((ws) => [ws.state, ws.label, ws.summary])).toEqual([
      ["ready", "Ready", "1 waiting on you."],
      [
        "desktop-app-not-running",
        "Desktop app not running",
        "It is on, but Gavin’s desktop app is not running there. Open Gavin at the desk.",
      ],
      ["asleep", "Asleep", "Its Relay has not heard from it: it is asleep, or remote access is off at the desk."],
    ]);
    expect(DEMO_WORKSTATION.label).toBe("Ready");
  });

  it("offers Try now on one waiting out its backoff or whose desktop app did not answer, and Pair again on one that refused", () => {
    const offered = (live: LiveState) => hubWorkstations([paired], { [paired.id]: live })[0];
    for (const live of [
      { state: "asleep" },
      { state: "unreachable", problem: "Could not reach its Relay." },
      { state: "desktop-app-not-running", reason: "not-answering" },
    ] as LiveState[]) {
      expect(offered(live).tryNow).toBe(true);
    }
    for (const live of [
      { state: "locked" },
      { state: "connecting" },
      { state: "ready", items: [] },
      { state: "failed", problem: "This phone’s keys failed." },
    ] as LiveState[]) {
      expect(offered(live).tryNow).toBe(false);
    }
    const refused = offered({ state: "refused", problem: "This Device was revoked at the Workstation." });
    expect([refused.tryNow, refused.label]).toEqual([false, "Pair again"]);
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
