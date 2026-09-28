// The Demo Workstation is a machine with agents on it, and agents do
// things. A demo that never changed would show a reviewer a screenshot;
// this is what makes it show the app.
import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { listen } from "@tauri-apps/api/event";
import * as backend from "$lib/core/backend";
import { gavinTrees } from "$lib/core/gavinState";
import { layoutState } from "$lib/core/layoutState";
import { loopback } from "$companion/channel/port";
import { ACTIVITY } from "$companion/demo/activity";
import { DEMO, sampleState } from "$companion/demo/sampleData";
import { createDemoWorkstation } from "$companion/demo/workstation";
import { disconnectChannel } from "$companion/remote/connection";
import { connectWorkstation } from "$companion/state/workstation";
import { connectDemo, settle } from "$companion/testing/demoBench";
import { deviceStorage, resetDesktopStores } from "$companion/testing/desktopStores";

afterEach(() => {
  disconnectChannel();
  resetDesktopStores();
});

describe("the demo's activity", () => {
  it("is a handful of steps", () => {
    expect(ACTIVITY.length).toBeGreaterThanOrEqual(4);
  });

  it("comes back to where it started, so it can run for as long as the demo is open", () => {
    const demo = createDemoWorkstation();
    for (let i = 0; i < ACTIVITY.length; i++) demo.advance();
    expect(demo.state).toEqual(sampleState());
    // ...and round again is the same round.
    const first = createDemoWorkstation();
    first.advance();
    for (let i = 0; i < ACTIVITY.length + 1; i++) demo.advance();
    expect(demo.state).toEqual(first.state);
  });

  it("changes something at every step", () => {
    const demo = createDemoWorkstation();
    for (let i = 0; i < ACTIVITY.length; i++) {
      const before = structuredClone(demo.state);
      demo.advance();
      expect(demo.state, `step ${i + 1}`).not.toEqual(before);
    }
  });

  it("says what it changed, as the events a desk would push", async () => {
    const demo = connectDemo();
    const heard = vi.fn();
    await listen("session-status-changed", (e) => heard("status", e.payload));
    await listen("gavin-tree-changed", (e) => heard("tree", (e.payload as [string, unknown])[0]));

    for (let i = 0; i < ACTIVITY.length; i++) demo.advance();
    await settle();

    const kinds = heard.mock.calls.map((call) => call[0]);
    expect(kinds).toContain("status");
    expect(kinds).toContain("tree");
  });

  it("never pushes what a read would then contradict", async () => {
    const demo = connectDemo();
    const statuses: Record<string, string> = {};
    await listen<[string, string]>("session-status-changed", (e) => {
      statuses[e.payload[0]] = e.payload[1];
    });

    for (let i = 0; i < ACTIVITY.length - 1; i++) {
      demo.advance();
      await settle();
      const read = await backend.getSessionBaselines();
      for (const [id, status] of Object.entries(statuses)) {
        expect(read.sessions.find((s) => s.id === id)?.status, `${id} after step ${i + 1}`).toBe(status);
      }
    }
  });
});

describe("the activity, as the Companion sees it", () => {
  it("answers the agent that was waiting on the human", async () => {
    const demo = createDemoWorkstation();
    const stop = await connectWorkstation(loopback(demo), deviceStorage());
    await settle();
    expect(get(layoutState).sessionStatusById["s-atlas-store"]).toBe("waiting_for_input");

    demo.advance();
    await settle();

    expect(get(layoutState).sessionStatusById["s-atlas-store"]).toBe("working");
    stop();
  });

  it("moves a plan's checklist along", async () => {
    const demo = createDemoWorkstation();
    const stop = await connectWorkstation(loopback(demo), deviceStorage());
    await settle();
    const done = () =>
      get(gavinTrees)[DEMO.atlas].contexts[0].plans.find((p) => p.fileName === "token-refresh.md")!
        .checklistDone;
    const before = done();

    for (let i = 0; i < ACTIVITY.length - 1; i++) demo.advance();
    await settle();

    expect(done()).toBeGreaterThan(before);
    stop();
  });
});
