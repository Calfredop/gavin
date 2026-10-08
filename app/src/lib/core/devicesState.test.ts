import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";

// The wiring between the presence push and the desk: the rules are
// devicePresence.ts's and tested there; this proves the listener applies
// them -- a Device-started session is placed once, by the window showing
// its workspace, and its tab is labelled and marked from the same pushes.

const backendMock = vi.hoisted(() => ({
  listDevices: vi.fn(),
  getRelayState: vi.fn(async () => ({ state: "not_wanted" })),
}));
vi.mock("$lib/core/backend", () => backendMock);

const layoutMock = vi.hoisted(() => ({ place: vi.fn() }));
vi.mock("$lib/core/layoutState", async () => {
  const { writable } = await import("svelte/store");
  return {
    daemonCompat: writable({ daemonVersion: 63 }),
    layoutState: writable({
      workspaces: [
        { id: "w-here", name: "here", rootPath: "/work/here", pages: [], activePageId: null },
        { id: "w-there", name: "there", rootPath: "/work/there", pages: [], activePageId: null },
        // A Scratchpad: no folder, no pages.
        { id: "w-scratch", name: "Scratchpad", pages: [], activePageId: null },
      ],
    }),
    placeDeviceStartedSession: layoutMock.place,
  };
});

// This window shows `w-here` and `w-scratch`; another window shows `w-there`.
vi.mock("$lib/shell/appDuty", () => ({ runsRailsFor: (id: string) => id !== "w-there" }));

const eventMock = vi.hoisted(() => {
  const handlers = new Map<string, Array<(event: { payload: unknown }) => void>>();
  return {
    handlers,
    listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== handler));
    }),
    fire(name: string, payload: unknown): void {
      for (const handler of handlers.get(name) ?? []) handler({ payload });
    },
  };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: eventMock.listen }));

import { deviceNameBySessionId, typingBySessionId, watchDevices } from "$lib/core/devicesState";

const nowS = () => Math.floor(Date.now() / 1000);
const phone = (presence?: unknown) => ({
  deviceId: "d1",
  name: "Pixel",
  role: "remote",
  createdAt: 1,
  lastSeenAt: nowS(),
  revokedAt: null,
  stale: false,
  ...(presence ? { presence } : {}),
});
const listing = (...devices: unknown[]) => ({ devices, remoteAccessEnabled: true, relayUrl: null, relayAdmissionSet: false });

let stop: () => void;

let consoleSpies: Array<{ mockRestore(): void }> = [];

beforeEach(async () => {
  layoutMock.place.mockReset().mockReturnValue(true);
  consoleSpies = [
    vi.spyOn(console, "info").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
  ];
  backendMock.listDevices.mockResolvedValue(listing(phone()));
  stop = watchDevices();
  await vi.waitFor(() => expect(backendMock.listDevices).toHaveBeenCalled());
  await Promise.resolve();
});

afterEach(() => {
  stop();
  for (const spy of consoleSpies) spy.mockRestore();
});

describe("a session a Device started", () => {
  it("is placed as a tab once, in the workspace it was started in", async () => {
    const presence = { started: [{ sessionId: "s-new", workspaceRoot: "/work/here", at: nowS() }] };
    eventMock.fire("device-presence-changed", ["d1", presence]);
    eventMock.fire("device-presence-changed", ["d1", { ...presence, typing: { sessionId: "x", at: nowS() } }]);

    expect(layoutMock.place).toHaveBeenCalledTimes(1);
    expect(layoutMock.place).toHaveBeenCalledWith("w-here", "s-new", false);
    await vi.waitFor(() => expect(get(deviceNameBySessionId)).toEqual({ "s-new": "Pixel" }));
  });

  it("carries the Device's ask that it be the workspace agent", () => {
    eventMock.fire("device-presence-changed", [
      "d1",
      { started: [{ sessionId: "s-agent", workspaceRoot: "/work/here", workspaceAgent: true, at: nowS() }] },
    ]);
    expect(layoutMock.place).toHaveBeenCalledWith("w-here", "s-agent", true);
  });

  it("is left to the window showing its workspace", () => {
    eventMock.fire("device-presence-changed", [
      "d1",
      { started: [{ sessionId: "s-there", cwd: "/work/there/src", at: nowS() }] },
    ]);
    expect(layoutMock.place).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith(
      "gavin: device d1 started session s-there (cwd /work/there/src): left to the window showing workspace w-there"
    );
  });

  // Scratchpad's New terminal names no root and opens in the home folder.
  it("is placed in a workspace with no folder by the workspace it names", () => {
    eventMock.fire("device-presence-changed", [
      "d1",
      { workspaceId: "w-scratch", started: [{ sessionId: "s-scratch", workspaceId: "w-scratch", at: nowS() }] },
    ]);
    expect(layoutMock.place).toHaveBeenCalledWith("w-scratch", "s-scratch", false);
    expect(console.info).toHaveBeenCalledWith(
      "gavin: device d1 started session s-scratch (workspace w-scratch): placed in workspace w-scratch"
    );
  });

  // What an older daemon sends for that same terminal, or a phone naming a
  // workspace since removed at the desk: nothing to place it by, said.
  it("is not placed, and the console says why, when no workspace here holds it", () => {
    eventMock.fire("device-presence-changed", ["d1", { started: [{ sessionId: "s-lost", at: nowS() }] }]);
    eventMock.fire("device-presence-changed", [
      "d1",
      { started: [{ sessionId: "s-gone", workspaceId: "w-gone", cwd: "/Users/me", at: nowS() }] },
    ]);
    expect(layoutMock.place).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      "gavin: device d1 started session s-lost (no workspace, root or cwd named): not placed, no workspace here holds it"
    );
    expect(console.warn).toHaveBeenCalledWith(
      "gavin: device d1 started session s-gone (workspace w-gone, cwd /Users/me): not placed, no workspace here holds it"
    );
  });

  it("is said to be showing already when the layout would not take it", () => {
    layoutMock.place.mockReturnValue(false);
    eventMock.fire("device-presence-changed", [
      "d1",
      { started: [{ sessionId: "s-shown", workspaceRoot: "/work/here", at: nowS() }] },
    ]);
    expect(console.info).toHaveBeenCalledWith(
      "gavin: device d1 started session s-shown (root /work/here): not placed, it is already showing"
    );
  });

  it("is not placed again when it was started before this window began listening", () => {
    eventMock.fire("device-presence-changed", [
      "d1",
      { started: [{ sessionId: "s-old", workspaceRoot: "/work/here", at: nowS() - 3600 }] },
    ]);
    expect(layoutMock.place).not.toHaveBeenCalled();
  });
});

describe("a Device typing", () => {
  it("marks the session it is typing into", async () => {
    eventMock.fire("device-presence-changed", ["d1", { typing: { sessionId: "s-desk", at: nowS() }, started: [] }]);
    await vi.waitFor(() => expect(get(typingBySessionId)).toEqual({ "s-desk": ["Pixel"] }));
    expect(layoutMock.place).not.toHaveBeenCalled();
  });
});
