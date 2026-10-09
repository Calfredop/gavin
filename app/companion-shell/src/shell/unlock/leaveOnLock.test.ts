// A paired Workstation's UI does not stay on screen after the Unlock ends.
import { describe, expect, it } from "vitest";
import { RETURN_WINDOW_MS, leavesVisitOnLock, returnFor, stepReturn } from "$shell/unlock/leaveOnLock";
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

describe("returning to the Workstation the lock left", () => {
  const MBP = workstation(false);
  const hub = (openable: boolean): HubWorkstation[] => [{ ...MBP, openable, state: openable ? "ready" : "connecting" }];
  const HUB: VisitState = { status: "hub" };

  it("remembers the paired Workstation it leaves, and nothing for the Demo", () => {
    expect(returnFor(OPEN)).toEqual({ workstation: MBP.id, unlockedAt: null });
    expect(returnFor(OPENING)).toEqual({ workstation: MBP.id, unlockedAt: null });
    expect(returnFor({ status: "open", workstation: workstation(true) })).toBeNull();
    expect(returnFor(HUB)).toBeNull();
  });

  it("waits while locked, whatever the hub lists", () => {
    const pending = returnFor(OPEN);
    expect(stepReturn(pending, locked("declined"), HUB, hub(true), 5_000)).toEqual({ pending, open: null });
    expect(stepReturn(pending, { state: "unlocking", renewing: false }, HUB, hub(true), 5_000)).toEqual({
      pending,
      open: null,
    });
  });

  it("reopens it once unlocked and it is ready again", () => {
    const pending = returnFor(OPEN);
    const connecting = stepReturn(pending, UNLOCKED, HUB, hub(false), 5_000);
    expect(connecting).toEqual({ pending: { workstation: MBP.id, unlockedAt: 5_000 }, open: null });
    const ready = stepReturn(connecting.pending, UNLOCKED, HUB, hub(true), 5_400);
    expect(ready.pending).toBeNull();
    expect(ready.open?.id).toBe(MBP.id);
  });

  it("gives up on a Workstation that is not ready soon after the Unlock, rather than jump into it later", () => {
    const waiting = stepReturn(returnFor(OPEN), UNLOCKED, HUB, hub(false), 5_000).pending;
    expect(stepReturn(waiting, UNLOCKED, HUB, hub(true), 5_000 + RETURN_WINDOW_MS + 1)).toEqual({
      pending: null,
      open: null,
    });
  });

  it("starts the wait again when the Unlock ends before it was ready", () => {
    const waiting = stepReturn(returnFor(OPEN), UNLOCKED, HUB, hub(false), 5_000).pending;
    const relocked = stepReturn(waiting, locked("background"), HUB, hub(false), 6_000).pending;
    expect(relocked).toEqual({ workstation: MBP.id, unlockedAt: null });
    expect(stepReturn(relocked, UNLOCKED, HUB, hub(true), 60_000).open?.id).toBe(MBP.id);
  });

  it("forgets it once the owner opens something else", () => {
    const other: VisitState = { status: "opening", workstation: workstation(true), detail: null };
    expect(stepReturn(returnFor(OPEN), UNLOCKED, other, hub(true), 5_000)).toEqual({ pending: null, open: null });
  });

  it("forgets a Workstation that is no longer paired", () => {
    expect(stepReturn(returnFor(OPEN), UNLOCKED, HUB, [], 5_000)).toEqual({ pending: null, open: null });
  });

  it("has nothing to do with nothing pending", () => {
    expect(stepReturn(null, UNLOCKED, HUB, hub(true), 5_000)).toEqual({ pending: null, open: null });
  });
});
