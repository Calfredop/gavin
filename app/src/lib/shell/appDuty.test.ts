import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

// Every window loads the whole frontend, and under vitest the window is
// "main" (appWindowState's fallback when Tauri is not there). So "this
// window holds the duty" and "another window holds it" are told apart
// by the HOLDER, which is what the host hands every window anyway.

const eventMock = vi.hoisted(() => {
  const handlers = new Map<string, Array<(event: { payload: unknown }) => void>>();
  return {
    handlers,
    listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {
        handlers.set(
          name,
          (handlers.get(name) ?? []).filter((h) => h !== handler)
        );
      };
    }),
    emit: vi.fn(async (_name: string, _message: unknown) => {}),
    fire(name: string, payload: unknown): void {
      for (const handler of handlers.get(name) ?? []) handler({ payload });
    },
  };
});

vi.mock("@tauri-apps/api/event", () => ({ listen: eventMock.listen, emit: eventMock.emit }));

const backendMock = vi.hoisted(() => ({
  appDuty: vi.fn(),
  workspaceWindows: vi.fn(async () => ({})),
}));

vi.mock("$lib/core/backend", () => backendMock);

import {
  appDuty,
  holdsAppDuties,
  holdsAppDutiesNow,
  initAppDuty,
  listenToOtherWindows,
  railWindowFor,
  runsRailsFor,
  tellOtherWindows,
  whileHoldingAppDuties,
} from "$lib/shell/appDuty";
import { workspaceWindows } from "$lib/shell/appWindowState";

beforeEach(() => {
  vi.clearAllMocks();
  eventMock.handlers.clear();
  appDuty.set({ holder: "main", windows: ["main"] });
  workspaceWindows.set({});
});

describe("who holds the app's duties", () => {
  it("is this window when the host names it", () => {
    expect(holdsAppDutiesNow()).toBe(true);
    expect(get(holdsAppDuties)).toBe(true);
  });

  it("is not this window when the host names another", () => {
    appDuty.set({ holder: "ws-2", windows: ["main", "ws-2"] });
    expect(holdsAppDutiesNow()).toBe(false);
    expect(get(holdsAppDuties)).toBe(false);
  });

  it("is read from the host at load, after the listener is up", async () => {
    backendMock.appDuty.mockResolvedValue({ holder: "ws-2", windows: ["main", "ws-2"] });
    await initAppDuty();
    expect(eventMock.listen.mock.invocationCallOrder[0]).toBeLessThan(
      backendMock.appDuty.mock.invocationCallOrder[0]
    );
    expect(holdsAppDutiesNow()).toBe(false);
  });

  it("follows the host's handover", async () => {
    backendMock.appDuty.mockResolvedValue({ holder: "ws-2", windows: ["main", "ws-2"] });
    await initAppDuty();
    eventMock.fire("app-duty-changed", { holder: "main", windows: ["main"] });
    expect(holdsAppDutiesNow()).toBe(true);
  });

  it("keeps the main window's claim when the host cannot answer", async () => {
    backendMock.appDuty.mockRejectedValue(new Error("no host"));
    await initAppDuty();
    expect(holdsAppDutiesNow()).toBe(true);
  });
});

describe("whileHoldingAppDuties", () => {
  it("starts nothing in a window that does not hold the duty", () => {
    appDuty.set({ holder: "ws-2", windows: ["main", "ws-2"] });
    const start = vi.fn(() => () => {});
    whileHoldingAppDuties(start);
    expect(start).not.toHaveBeenCalled();
  });

  it("starts once in the holder, however often the window list moves", () => {
    const start = vi.fn(() => () => {});
    whileHoldingAppDuties(start);
    appDuty.set({ holder: "main", windows: ["main", "ws-2"] });
    appDuty.set({ holder: "main", windows: ["main"] });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("starts when the duty is handed over and stops when it leaves", () => {
    appDuty.set({ holder: "ws-2", windows: ["main", "ws-2"] });
    const stop = vi.fn();
    const start = vi.fn(() => stop);
    whileHoldingAppDuties(start);

    appDuty.set({ holder: "main", windows: ["main"] });
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();

    appDuty.set({ holder: "ws-3", windows: ["main", "ws-3"] });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stops what it started when torn down, and nothing after", () => {
    const stop = vi.fn();
    const start = vi.fn(() => stop);
    const teardown = whileHoldingAppDuties(start);
    teardown();
    expect(stop).toHaveBeenCalledTimes(1);
    appDuty.set({ holder: "ws-2", windows: ["main", "ws-2"] });
    appDuty.set({ holder: "main", windows: ["main"] });
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("sharing with the other windows", () => {
  it("says nothing when no other window is open to hear it", () => {
    tellOtherWindows("reading", { value: 1 });
    expect(eventMock.emit).not.toHaveBeenCalled();
  });

  it("names its own window on what it tells the others", () => {
    appDuty.set({ holder: "main", windows: ["main", "ws-2"] });
    tellOtherWindows("reading", { value: 1 });
    expect(eventMock.emit).toHaveBeenCalledWith("reading", {
      origin: "main",
      payload: { value: 1 },
    });
  });

  it("hears the other windows and not its own echo", async () => {
    const heard = vi.fn();
    await listenToOtherWindows("reading", heard);
    eventMock.fire("reading", { origin: "main", payload: { value: 1 } });
    eventMock.fire("reading", { origin: "ws-2", payload: { value: 2 } });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledWith({ value: 2 });
  });
});

// Rails are not an app-wide poll: they belong to the window showing their
// workspace, which is where that workspace's git refs and views are
// loaded. Only a workspace whose window is gone falls to the holder.
describe("which window runs a workspace's rails", () => {
  const both = { holder: "main", windows: ["main", "ws-2"] };

  it("is the window showing the workspace", () => {
    expect(railWindowFor({ w2: "ws-2" }, both, "w2")).toBe("ws-2");
    expect(railWindowFor({ w2: "ws-2" }, both, "w1")).toBe("main");
  });

  /// The close prompt's first rung: the main window is gone, and the
  /// workspaces it was showing are shown nowhere. Their rails still run.
  it("is the duty holder when the window showing the workspace is gone", () => {
    expect(railWindowFor({ w2: "ws-2" }, { holder: "ws-2", windows: ["ws-2"] }, "w1")).toBe("ws-2");
  });

  it("is answered for this window", () => {
    appDuty.set(both);
    workspaceWindows.set({ w2: "ws-2" });
    expect(runsRailsFor("w1")).toBe(true);
    expect(runsRailsFor("w2")).toBe(false);
  });
});
