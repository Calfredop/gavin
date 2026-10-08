// A paired Workstation's UI does not stay on screen after the Unlock ends.
import { describe, expect, it } from "vitest";
import { leavesVisitOnLock } from "$shell/unlock/leaveOnLock";
import type { LockedWhy, UnlockState } from "$shell/unlock/unlock";
import type { VisitState } from "$shell/visit/visit";
import type { HubWorkstation } from "$shell/hub/workstations";

const workstation = (demo: boolean): HubWorkstation => ({
  id: demo ? "demo" : "ws-b8b62138dff5ea6a",
  name: demo ? "Demo Workstation" : "MBP16Pro",
  demo,
  summary: "",
  state: "ready",
  label: "Ready",
  openable: true,
});

const locked = (why: LockedWhy): UnlockState => ({ state: "locked", why });
const UNLOCKED: UnlockState = { state: "unlocked", since: 1_000 };

const OPEN: VisitState = { status: "open", workstation: workstation(false) };
const OPENING: VisitState = { status: "opening", workstation: workstation(false), detail: "Fetching its UI" };

describe("leaving a paired Workstation when the Unlock ends", () => {
  it.each<LockedWhy>(["background", "screen-locked", "declined", "failed", "ended"])(
    "leaves an open visit when the Unlock is locked: %s",
    (why) => {
      expect(leavesVisitOnLock(locked(why), OPEN)).toBe(true);
    }
  );

  it("leaves a visit that is still opening, which needs a connection it no longer has", () => {
    expect(leavesVisitOnLock(locked("background"), OPENING)).toBe(true);
  });

  it("stays while unlocked", () => {
    expect(leavesVisitOnLock(UNLOCKED, OPEN)).toBe(false);
  });

  it("stays while the prompt is up, whether first or renewing", () => {
    expect(leavesVisitOnLock({ state: "unlocking", renewing: false }, OPEN)).toBe(false);
    expect(leavesVisitOnLock({ state: "unlocking", renewing: true }, OPEN)).toBe(false);
  });

  it("does not leave the Demo Workstation, which needs no Unlock and shows nothing of the owner's", () => {
    const demo: VisitState = { status: "open", workstation: workstation(true) };
    expect(leavesVisitOnLock(locked("background"), demo)).toBe(false);
    expect(leavesVisitOnLock(locked("declined"), { ...demo, status: "opening", detail: null })).toBe(false);
  });

  it("has nothing to leave from the hub or a failed visit", () => {
    expect(leavesVisitOnLock(locked("background"), { status: "hub" })).toBe(false);
    expect(
      leavesVisitOnLock(locked("background"), { status: "failed", workstation: workstation(false), reason: "no" })
    ).toBe(false);
  });
});
