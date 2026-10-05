import { describe, expect, it } from "vitest";
import { liveLabel, liveSummary, reconnectDelay, RECONNECT } from "$shell/hub/live";

describe("a Workstation's live state", () => {
  it("backs off from a second to half a minute, doubling", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map((n) => reconnectDelay(n))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
    expect(reconnectDelay(0)).toBe(RECONNECT.floorMs);
  });

  it("names every state for the hub", () => {
    expect(liveLabel("desktop-app-not-running")).toBe("Desktop app not running");
    expect(liveLabel("refused")).toBe("Pair again");
    expect(liveSummary({ state: "ready", items: [] })).toBe("Nothing is waiting on you.");
    expect(liveSummary({ state: "unreachable", problem: "Could not reach its Relay." })).toBe("Could not reach its Relay.");
  });
});
