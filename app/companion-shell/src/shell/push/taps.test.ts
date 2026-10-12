import { describe, expect, it } from "vitest";
import type { LiveState } from "$shell/hub/live";
import type { HubWorkstation } from "$shell/hub/workstations";
import type { UnlockState } from "$shell/unlock/unlock";
import capacitorConfig from "../../../capacitor.config";
import { clearsFor, pendingTap, stepTap, TAP_WINDOW_MS } from "./taps";

function ws(openable: boolean): HubWorkstation {
  return { id: "ws-a", name: "MBP", demo: false, summary: "", state: openable ? "ready" : "connecting", label: "", openable };
}
const locked: UnlockState = { state: "locked", why: "not-yet" };
const unlocked: UnlockState = { state: "unlocked", since: 0 };
const landing = { workspace: "w1", target: { kind: "session" as const, id: "s1" } };

describe("stepTap", () => {
  it("waits for the Unlock, then for the connection, then opens where the tap lands", () => {
    let step = stepTap(pendingTap({ workstationId: "ws-a", landing }), locked, [ws(false)], 0);
    expect(step.open).toBeNull();
    step = stepTap(step.pending, unlocked, [ws(false)], 1_000);
    expect(step).toMatchObject({ open: null, pending: { unlockedAt: 1_000 } });
    step = stepTap(step.pending, unlocked, [ws(true)], 2_000);
    expect(step.open).toEqual({ workstation: ws(true), landing });
    expect(step.pending).toBeNull();
  });

  it("gives up once the Workstation has had its time, and says so", () => {
    const waiting = stepTap(pendingTap({ workstationId: "ws-a", landing }), unlocked, [ws(false)], 1_000).pending;
    const step = stepTap(waiting, unlocked, [ws(false)], 1_000 + TAP_WINDOW_MS + 1);
    expect(step).toEqual({ pending: null, open: null, notice: "MBP cannot be reached to open what you tapped." });
  });

  it("says so when the Workstation is no longer paired", () => {
    const step = stepTap(pendingTap({ workstationId: "ws-gone", landing: null }), unlocked, [ws(true)], 0);
    expect(step.pending).toBeNull();
    expect(step.notice).toMatch(/no longer paired/);
  });
});

describe("clearsFor", () => {
  const ready = (ids: string[]): LiveState => ({
    state: "ready",
    items: ids.map((id) => ({ id, workspace: "w", kind: "waiting", text: "", target: null })),
  });

  it("clears each ready Workstation against what is still waiting there, once per change", () => {
    const first = clearsFor({ "ws-a": ready(["b", "a"]), "ws-b": { state: "connecting" } }, new Map());
    expect(first.clears).toEqual([{ workstation: "ws-a", keep: ["a", "b"] }]);
    expect(clearsFor({ "ws-a": ready(["a", "b"]) }, first.sent).clears).toEqual([]);
    expect(clearsFor({ "ws-a": ready(["a"]) }, first.sent).clears).toEqual([{ workstation: "ws-a", keep: ["a"] }]);
  });

  it("clears everything from a Workstation with nothing waiting", () => {
    expect(clearsFor({ "ws-a": ready([]) }, new Map()).clears).toEqual([{ workstation: "ws-a", keep: [] }]);
  });
});

describe("the iOS notification centre's delegate", () => {
  // PushTaps (AppDelegate.swift) is what shows a notification with the app
  // in front and hands a tap to the hub. Capacitor's bridge replaces it as
  // it loads unless told not to, and its own router does neither.
  it("is left to the shell by Capacitor", () => {
    expect(capacitorConfig.ios?.handleApplicationNotifications).toBe(false);
  });
});
