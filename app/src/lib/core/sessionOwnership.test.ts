import { describe, it, expect } from "vitest";
import {
  OWNER_REFUSED_PREFIX,
  agoText,
  busyQuestion,
  handOverTargets,
  lockDetail,
  lockFor,
  lockTitle,
  ownedCountByDevice,
  ownerRefusalFrom,
  ownersChangeAt,
  ownersFromList,
  ownerTypingNow,
  ownsSession,
  ownsText,
  refusalText,
  takeLabel,
  withOwnership,
  type SessionOwner,
  type SessionOwnership,
} from "$lib/core/sessionOwnership";

const NOW_S = 1_770_000_000;
const NOW = NOW_S * 1000;

const iphone: SessionOwner = { deviceId: "iphone", name: "iPhone di Cosimo", since: NOW_S - 60, typedAt: NOW_S - 12 };
const ipad: SessionOwner = { deviceId: "ipad", name: "iPad", since: NOW_S - 2 };

const change = (sessionId: string, owner: SessionOwner | null, reason: SessionOwnership["reason"] = "claimed") => ({
  sessionId,
  owner,
  reason,
  at: NOW_S,
});

describe("the owners a window holds", () => {
  it("are the Device-owned sessions of the list", () => {
    expect(ownersFromList([change("s1", iphone), change("s2", ipad)])).toEqual({ s1: iphone, s2: ipad });
  });

  it("take each push whole, and a push to the desk drops the session", () => {
    let owners = ownersFromList([change("s1", iphone)]);
    owners = withOwnership(owners, change("s1", ipad, "tookOver"));
    expect(owners).toEqual({ s1: ipad });
    owners = withOwnership(owners, change("s1", null, "released"));
    expect(owners).toEqual({});
  });
});

describe("the lock", () => {
  const owners = { s1: iphone };

  it("locks the desk out of a Device's session, and nothing else", () => {
    expect(lockFor(owners, "s1", null)).toBe(iphone);
    expect(lockFor(owners, "desk-session", null)).toBeNull();
  });

  it("locks every other Device out, never the owner", () => {
    expect(lockFor(owners, "s1", "ipad")).toBe(iphone);
    expect(lockFor(owners, "s1", "iphone")).toBeNull();
    expect(ownsSession(owners, "s1", "iphone")).toBe(true);
    expect(ownsSession(owners, "s1", null)).toBe(false);
  });

  /// A Device that has not yet read its own id cannot tell its sessions
  /// from another's: it locks nothing rather than locking itself out.
  it("locks nothing for a Device that does not yet know who it is", () => {
    expect(lockFor(owners, "s1", undefined)).toBeNull();
  });

  it("names the owner and when it last typed", () => {
    expect(lockTitle(iphone)).toBe("iPhone di Cosimo is working on this");
    expect(lockDetail(iphone, NOW)).toBe("Typed 12s ago");
    expect(lockDetail(ipad, NOW)).toBe("Took it just now");
  });

  it("counts down while the owner is away", () => {
    const away = { ...iphone, awaySince: NOW_S - 10, releasesAt: NOW_S + 20 };
    expect(lockDetail(away, NOW)).toBe("Not connected · back to the desk in 20s");
    expect(lockDetail(away, NOW + 25_000)).toBe("Not connected · back to the desk now");
  });

  it("takes back at the desk and takes over on a Device", () => {
    expect(takeLabel(null)).toBe("Take back");
    expect(takeLabel("ipad")).toBe("Take over");
  });

  it("reads the owner as typing for a few seconds after a keystroke", () => {
    expect(ownerTypingNow({ ...iphone, typedAt: NOW_S - 2 }, NOW)).toBe(true);
    expect(ownerTypingNow(iphone, NOW)).toBe(false);
    expect(ownerTypingNow(ipad, NOW)).toBe(false);
  });
});

describe("a refusal", () => {
  it("is read out of the daemon's message, with or without words in front", () => {
    const busy = { kind: "busy", sessionId: "s1", owner: iphone, typedAt: NOW_S };
    const message = `${OWNER_REFUSED_PREFIX}${JSON.stringify(busy)}`;
    expect(ownerRefusalFrom(message)).toEqual(busy);
    expect(ownerRefusalFrom(new Error(`Couldn't send: ${message}`))).toEqual(busy);
    expect(ownerRefusalFrom("gavin-daemon: no such session")).toBeNull();
    expect(ownerRefusalFrom(`${OWNER_REFUSED_PREFIX}{not json`)).toBeNull();
    expect(ownerRefusalFrom(undefined)).toBeNull();
  });

  it("asks before taking from whoever is typing, the desk included", () => {
    expect(busyQuestion({ kind: "busy", sessionId: "s1", owner: iphone, typedAt: NOW_S })).toBe(
      "iPhone di Cosimo is typing right now. Take over anyway?"
    );
    expect(busyQuestion({ kind: "busy", sessionId: "s1", typedAt: NOW_S })).toBe(
      "The desk is typing right now. Take over anyway?"
    );
  });

  it("says who has it now", () => {
    expect(refusalText({ kind: "owned", sessionId: "s1", owner: iphone })).toBe(
      "iPhone di Cosimo is working on this session. Take over to type here."
    );
    expect(refusalText({ kind: "owned", sessionId: "s1", owner: iphone }, null)).toBe(
      "iPhone di Cosimo is working on this session. Take back to type here."
    );
    expect(refusalText({ kind: "changed", sessionId: "s1", owner: ipad })).toBe("iPad took this session first.");
    expect(refusalText({ kind: "changed", sessionId: "s1" })).toBe("This session went back to the desk first.");
    expect(refusalText({ kind: "notConnected", sessionId: "s1", deviceId: "ipad" })).toMatch(/no longer connected/);
  });
});

describe("handing a session over", () => {
  const devices = [
    { deviceId: "iphone", name: "iPhone" },
    { deviceId: "ipad", name: "iPad" },
    { deviceId: "pixel", name: "Pixel" },
  ];

  it("offers the other live Devices and the desk to the owner", () => {
    expect(handOverTargets(devices, { s1: iphone }, "s1", "iphone")).toEqual([
      { deviceId: "ipad", name: "iPad" },
      { deviceId: "pixel", name: "Pixel" },
      null,
    ]);
  });

  it("offers the desk nothing it already holds, nor the asking Device itself", () => {
    expect(handOverTargets(devices, {}, "s1", null)).toEqual(devices);
    expect(handOverTargets(devices, {}, "s1", "ipad").map((d) => d?.deviceId)).toEqual(["iphone", "pixel"]);
  });
});

describe("the Devices panel's count", () => {
  it("says how many sessions each Device owns", () => {
    const counts = ownedCountByDevice({ s1: iphone, s2: iphone, s3: ipad });
    expect(counts).toEqual({ iphone: 2, ipad: 1 });
    expect(ownsText(counts.iphone)).toBe("owns 2 sessions");
    expect(ownsText(counts.ipad)).toBe("owns 1 session");
    expect(ownsText(undefined)).toBeNull();
  });
});

describe("the lock's clock", () => {
  it("ticks every second through a countdown, every few otherwise, and never with no owner", () => {
    expect(ownersChangeAt({}, NOW)).toBeNull();
    expect(ownersChangeAt({ s1: iphone }, NOW)).toBe(NOW + 5000);
    expect(ownersChangeAt({ s1: { ...iphone, releasesAt: NOW_S + 3 } }, NOW)).toBe(NOW + 1000);
  });

  it("words an age", () => {
    expect([agoText(2), agoText(42), agoText(185), agoText(7300)]).toEqual(["just now", "42s ago", "3m ago", "2h ago"]);
  });
});
