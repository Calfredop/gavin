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
    expect(liveLabel({ state: "desktop-app-not-running" })).toBe("Desktop app not running");
    expect(liveLabel({ state: "refused", problem: "Revoked." })).toBe("Pair again");
    expect(liveSummary({ state: "ready", items: [] })).toBe("Nothing is waiting on you.");
    expect(liveSummary({ state: "unreachable", problem: "Could not reach its Relay." })).toBe("Could not reach its Relay.");
  });

  // An app that is not running wants opening; one that is open and not
  // answering wants a look. "Not running" for both sent the human to open
  // an app that was already open in front of them.
  it("tells a desktop app that is not running from one that is open and not answering, and says what to do", () => {
    const told = (reason?: "not-connected" | "connection-lost" | "not-answering") => {
      const live = reason ? { state: "desktop-app-not-running" as const, reason } : { state: "desktop-app-not-running" as const };
      return [liveLabel(live), liveSummary(live)];
    };
    expect(told("not-connected")).toEqual([
      "Desktop app not running",
      "It is on, but Gavin’s desktop app is not running there. Open Gavin at the desk.",
    ]);
    // A Workstation too old to say why reads as the likeliest cause.
    expect(told()).toEqual(told("not-connected"));
    expect(told("not-answering")).toEqual([
      "Desktop app not answering",
      "Gavin’s desktop app is open there but did not answer in time. If this lasts, quit and reopen it at the desk.",
    ]);
    expect(told("connection-lost")).toEqual([
      "Desktop app disconnected",
      "Gavin’s desktop app dropped its connection while answering. If it is still open, it reconnects on its own.",
    ]);
  });
});
