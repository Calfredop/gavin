// What a visit's bundle is told of its Workstation's connection, from the
// live hub's state for it.
import { describe, expect, it } from "vitest";
import type { ConnectionState } from "$companion/channel/messages";
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

describe("sameConnectionState", () => {
  it("compares the state and, when down, the reason", () => {
    expect(sameConnectionState(UP, { state: "up" })).toBe(true);
    expect(sameConnectionState(ASLEEP, { state: "down", reason: "asleep" })).toBe(true);
    expect(sameConnectionState(ASLEEP, UNREACHABLE)).toBe(false);
    expect(sameConnectionState(UP, ASLEEP)).toBe(false);
  });
});
