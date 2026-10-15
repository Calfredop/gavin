import { describe, expect, it } from "vitest";
import { borrowTitle, withBorrow } from "$lib/terminal/ptyBorrow";

const iphone = { deviceId: "d1", name: "iPhone" };
const ipad = { deviceId: "d2", name: "iPad" };

describe("withBorrow", () => {
  it("names the Device a session is sized for", () => {
    expect(withBorrow({}, { sessionId: "s", device: iphone })).toEqual({ s: iphone });
  });

  it("takes the latest Device, whole", () => {
    expect(withBorrow({ s: iphone }, { sessionId: "s", device: ipad })).toEqual({ s: ipad });
  });

  it("forgets the session once the desk has its size back, and only that one", () => {
    expect(withBorrow({ s: iphone, t: ipad }, { sessionId: "s", device: null })).toEqual({ t: ipad });
  });

  it("leaves what it was given alone", () => {
    const before = { s: iphone };
    withBorrow(before, { sessionId: "s", device: null });
    expect(before).toEqual({ s: iphone });
  });
});

describe("borrowTitle", () => {
  it("says which Device has the session open", () => {
    expect(borrowTitle(iphone)).toBe("Open on iPhone");
  });
});
