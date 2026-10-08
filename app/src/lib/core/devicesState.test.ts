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
      ],
    }),
    placeDeviceStartedSession: layoutMock.place,
  };
});

// This window shows `w-here`; another window shows `w-there`.
vi.mock("$lib/shell/appDuty", () => ({ runsRailsFor: (id: string) => id === "w-here" }));

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

beforeEach(async () => {
  layoutMock.place.mockClear();
  backendMock.listDevices.mockResolvedValue(listing(phone()));
  stop = watchDevices();
  await vi.waitFor(() => expect(backendMock.listDevices).toHaveBeenCalled());
  await Promise.resolve();
});

afterEach(() => stop());

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
