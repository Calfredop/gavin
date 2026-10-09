// What a visit's bundle is told of its Workstation's connection, from the
// live hub's state for it.
import { describe, expect, it } from "vitest";
import type { ConnectionState } from "$companion/channel/messages";
import { reachabilityLine } from "$companion/state/reachability";
import type { LiveState } from "$shell/hub/live";
import { connectionStateOf, sameConnectionState, UP } from "$shell/visit/connectionState";

const ASLEEP: ConnectionState = { state: "down", reason: "asleep" };
const UNREACHABLE: ConnectionState = { state: "down", reason: "unreachable" };

describe("connectionStateOf", () => {
  it("is up only once the desktop app has answered over a connection", () => {
    expect(connectionStateOf({ state: "ready", items: [] }, true, UNREACHABLE)).toEqual(UP);
    expect(connectionStateOf({ state: "ready", items: [] }, false, UP)).toEqual(UNREACHABLE);
    expect(connectionStateOf({ state: "desktop-app-not-running", reason: "not-answering" }, true, UP)).toEqual({
      state: "down",
      reason: "desktop-app-not-running",
    });
  });

  it("keeps each reason in its own words", () => {
    const cases: Array<[LiveState, ConnectionState]> = [
      [{ state: "asleep" }, ASLEEP],
      [{ state: "unreachable", problem: "x" }, UNREACHABLE],
      [{ state: "refused", problem: "x" }, UNREACHABLE],
      [{ state: "failed", problem: "x" }, UNREACHABLE],
      [{ state: "locked" }, UNREACHABLE],
    ];
    for (const [live, told] of cases) expect(connectionStateOf(live, false, UP)).toEqual(told);
  });

  it("is no news while connecting: a Workstation asleep between tries stays asleep", () => {
    expect(connectionStateOf({ state: "connecting" }, false, ASLEEP)).toEqual(ASLEEP);
    expect(connectionStateOf({ state: "connecting" }, true, ASLEEP)).toEqual(ASLEEP);
    expect(connectionStateOf({ state: "connecting" }, true, UP)).toEqual(UP);
    expect(connectionStateOf({ state: "connecting" }, false, UP)).toEqual(UNREACHABLE);
  });

  it("goes by the connection alone where the hub's state is not known", () => {
    expect(connectionStateOf(null, true, UNREACHABLE)).toEqual(UP);
    expect(connectionStateOf(null, false, UP)).toEqual(UNREACHABLE);
  });
});

// The four ways an open Workstation goes away (the owner turning Remote
// access off at the desk passes through the first two), each followed to
// the line the open UI shows.
describe("what the open Workstation's UI says when it goes away", () => {
  const said = (live: LiveState, connected: boolean): string | null =>
    reachabilityLine(connectionStateOf(live, connected, UP), "MBP16Pro");

  it.each<[string, LiveState, boolean, string]>([
    ["asleep", { state: "asleep" }, false, "MBP16Pro is asleep, or remote access is off there. Trying again…"],
    ["unreachable", { state: "unreachable", problem: "x" }, false, "Can’t reach MBP16Pro. Trying again…"],
    [
      "desktop-app-not-running",
      { state: "desktop-app-not-running" },
      true,
      "Gavin’s desktop app is not answering on MBP16Pro. Trying again…",
    ],
    ["a plain drop", { state: "ready", items: [] }, false, "Can’t reach MBP16Pro. Trying again…"],
  ])("%s", (_, live, connected, line) => {
    expect(said(live, connected)).toBe(line);
  });

  it("keeps asleep, unreachable and desktop-app-not-running apart", () => {
    const lines = new Set([
      said({ state: "asleep" }, false),
      said({ state: "unreachable", problem: "x" }, false),
      said({ state: "desktop-app-not-running", reason: "not-answering" }, true),
    ]);
    expect(lines.size).toBe(3);
  });

  it("says nothing once it is back", () => {
    expect(said({ state: "ready", items: [] }, true)).toBeNull();
  });
});

describe("sameConnectionState", () => {
  it("compares the state and, when down, the reason", () => {
    expect(sameConnectionState(UP, { state: "up" })).toBe(true);
    expect(sameConnectionState(ASLEEP, { state: "down", reason: "asleep" })).toBe(true);
    expect(sameConnectionState(ASLEEP, UNREACHABLE)).toBe(false);
    expect(sameConnectionState(UP, ASLEEP)).toBe(false);
  });
});
