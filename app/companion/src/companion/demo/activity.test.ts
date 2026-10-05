// The Demo Workstation is a machine with agents on it, and agents do
// things. A demo that never changed would show a reviewer a screenshot;
// this is what makes it show the app.
import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { listen } from "@tauri-apps/api/event";
import * as backend from "$lib/core/backend";
import { gavinTrees } from "$lib/core/gavinState";
import { layoutState } from "$lib/core/layoutState";
import { createChannelClient } from "$companion/channel/client";
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

  // A reviewer who renames a workspace, saves a file or adds a workspace
  // must still see it a lap later: the loop puts back what IT moved.
  it("leaves alone what a visitor changed, lap after lap", async () => {
    const demo = createDemoWorkstation();
    const client = createChannelClient(loopback(demo));
    await client.invoke("set_workspace_settings", { workspaceId: DEMO.atlas, patch: { name: "atlas" } });
    await client.invoke("set_auto_commit", { enabled: true });
    await client.invoke("write_file_for_editor", { path: `${DEMO.atlasRoot}/README.md`, content: "edited\n" });
    await client.invoke("add_workspace", { settings: { name: "weather-station", rootPath: DEMO.weatherRoot } });
    await client.invoke("set_root_config_field", { rootPath: DEMO.atlasRoot, key: "model", value: "sonnet" });

    for (let i = 0; i < ACTIVITY.length * 2; i++) demo.advance();

    expect(demo.state.workspaces.workspaces.map((w) => w.name)).toEqual([
      "atlas",
      "field-notes",
      "Scratchpad",
      "weather-station",
    ]);
    expect(demo.state.settings.autoCommit).toBe(true);
    expect(demo.state.files[`${DEMO.atlasRoot}/README.md`]).toBe("edited\n");
    expect(demo.state.trees[DEMO.atlas].contexts[0].agent?.model).toBe("sonnet");
    // ...while its own cards are back where they started.
    expect(demo.state.trees[DEMO.atlas].contexts.map((c) => c.plans)).toEqual(
      sampleState().trees[DEMO.atlas].contexts.map((c) => c.plans)
    );
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
  it("answers the agent that was waiting on the human, part-way round", async () => {
    const demo = createDemoWorkstation();
    const stop = await connectWorkstation(loopback(demo), deviceStorage());
    await settle();
    const store = () => get(layoutState).sessionStatusById["s-atlas-store"];
    expect(store()).toBe("waiting_for_input");

    const seen: string[] = [];
    for (let i = 0; i < ACTIVITY.length; i++) {
      demo.advance();
      await settle();
      seen.push(store());
    }

    expect(seen).toContain("working");
    // ...and it is asking again when the loop comes round.
    expect(seen.at(-1)).toBe("waiting_for_input");
    stop();
  });

  it("keeps an agent waiting on a menu for most of the loop", () => {
    const demo = createDemoWorkstation();
    let waitingSteps = 0;
    for (let i = 0; i < ACTIVITY.length; i++) {
      if (demo.state.sessions.some((s) => s.status === "waiting_for_input")) waitingSteps += 1;
      demo.advance();
    }
    expect(waitingSteps).toBeGreaterThanOrEqual(ACTIVITY.length - 1);
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
