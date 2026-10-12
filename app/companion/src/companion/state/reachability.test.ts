// The page's one line about the Workstation's connection: why it cannot
// be reached while it cannot, then `Reconnected` for a moment.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import type { ConnectionState } from "$companion/channel/messages";
import {
  RECONNECTED_MS,
  connectionChanged,
  reachability,
  reachabilityBanner,
  reconnected,
  resetReachability,
} from "$companion/state/reachability";

const UP: ConnectionState = { state: "up" };
const ASLEEP: ConnectionState = { state: "down", reason: "asleep" };

const banner = () => reachabilityBanner(get(reachability), get(reconnected), "MBP16Pro");

beforeEach(() => {
  vi.useFakeTimers();
  resetReachability();
});

afterEach(() => {
  resetReachability();
  vi.useRealTimers();
});

describe("reachabilityBanner", () => {
  it("says why while down, in each reason's own words", () => {
    expect(reachabilityBanner(ASLEEP, false, "MBP16Pro")).toEqual({
      tone: "down",
      text: "MBP16Pro is asleep, or remote access is off there. Trying again…",
    });
    expect(reachabilityBanner({ state: "down", reason: "unreachable" }, false, "MBP16Pro")).toEqual({
      tone: "down",
      text: "Can’t reach MBP16Pro. Trying again…",
    });
    expect(reachabilityBanner({ state: "down", reason: "desktop-app-not-running" }, false, "MBP16Pro")).toEqual({
      tone: "down",
      text: "Gavin’s desktop app is not answering on MBP16Pro. Trying again…",
    });
  });

  it("says nothing while up, and Reconnected just after", () => {
    expect(reachabilityBanner(UP, false, "MBP16Pro")).toBeNull();
    expect(reachabilityBanner(UP, true, "MBP16Pro")).toEqual({ tone: "back", text: "Reconnected to MBP16Pro." });
    expect(reachabilityBanner(UP, true, "")).toEqual({ tone: "back", text: "Reconnected to the Workstation." });
  });

  it("puts down ahead of a Reconnected still showing", () => {
    expect(reachabilityBanner(ASLEEP, true, "MBP16Pro")?.tone).toBe("down");
  });
});

describe("reconnected", () => {
  it("shows Reconnected once the connection is back, and clears by itself", () => {
    connectionChanged(ASLEEP);
    expect(banner()?.tone).toBe("down");

    connectionChanged(UP);
    expect(banner()).toEqual({ tone: "back", text: "Reconnected to MBP16Pro." });

    vi.advanceTimersByTime(RECONNECTED_MS - 1);
    expect(banner()?.tone).toBe("back");
    vi.advanceTimersByTime(1);
    expect(banner()).toBeNull();
  });

  it("is not news when the connection was never down", () => {
    connectionChanged(UP);
    expect(get(reconnected)).toBe(false);
  });

  it("gives way at once when the connection drops again, and starts over on the next return", () => {
    connectionChanged(ASLEEP);
    connectionChanged(UP);
    vi.advanceTimersByTime(RECONNECTED_MS / 2);

    connectionChanged({ state: "down", reason: "unreachable" });
    expect(get(reconnected)).toBe(false);
    expect(banner()?.text).toBe("Can’t reach MBP16Pro. Trying again…");

    connectionChanged(UP);
    vi.advanceTimersByTime(RECONNECTED_MS / 2);
    // The first return's timer is gone: the second one runs in full.
    expect(get(reconnected)).toBe(true);
    vi.advanceTimersByTime(RECONNECTED_MS / 2);
    expect(get(reconnected)).toBe(false);
  });

  it("starts a new visit with nothing to say", () => {
    connectionChanged(ASLEEP);
    connectionChanged(UP);
    resetReachability();
    expect(banner()).toBeNull();
  });
});
