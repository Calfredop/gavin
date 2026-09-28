// "The Companion never starts the rail scheduler. The desktop window
// stays the only place rails tick." (spec, Forwarding; ADR 0003)
//
// The rule is harder to keep than it reads. The desktop's scheduler is
// not only `startScheduler`: a plan ARRIVING ticks by hand -- every
// fetch, refresh and push of a workspace's orchestration runs a pass --
// and the only thing between that pass and a write is `runsRailsFor`,
// which asks whose window this is. Outside Tauri the desktop answers
// "main", the label of the one window that DOES run rails. So a bundle
// that merely loaded a rail to draw it would run it, beside the desk.
//
// What is pinned here is therefore the outcome, at the wire: with a rail
// owed work and everything a surface would load loaded, nothing a
// scheduler sends ever reaches the Workstation. railSchedulerControl
// runs the same state under the desktop's identity and watches it act,
// which is what makes the silence here mean something.
import { afterEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { kanbanState } from "$lib/board/kanbanState";
import { handleSessionStatusChanged, layoutState, recordSessionExit } from "$lib/core/layoutState";
import {
  orchestrations,
  refreshOrchestration,
  startScheduler,
  tick,
  __resetForTesting,
} from "$lib/orchestration/orchestrationState";
import { holdsAppDutiesNow, runsRailsFor } from "$lib/shell/appDuty";
import { currentWindowLabel } from "$lib/shell/appWindowState";
import { DEMO } from "$companion/demo/sampleData";
import { disconnectChannel } from "$companion/remote/connection";
import { connectDemo, settle } from "$companion/testing/demoBench";
import { codeOf, companionSources } from "$companion/testing/companionSources";
import { aRailOwedWork, loadTheRailsAsASurfaceWould, SCHEDULER_COMMANDS } from "$companion/testing/railBench";

afterEach(() => {
  __resetForTesting();
  kanbanState.set({});
  disconnectChannel();
});

function schedulerTraffic(commands: string[]): string[] {
  return commands.filter((cmd) => SCHEDULER_COMMANDS.includes(cmd));
}

describe("whose window the bundle says it is", () => {
  it("is the Companion's, not a desktop window's", () => {
    expect(getCurrentWindow().label).toBe("companion");
    expect(currentWindowLabel()).toBe("companion");
  });

  it("runs no workspace's rails, and holds none of the app's duties", () => {
    for (const id of [DEMO.atlas, DEMO.notes, DEMO.scratch]) expect(runsRailsFor(id)).toBe(false);
    expect(holdsAppDutiesNow()).toBe(false);
  });
});

describe("a rail that is owed work", () => {
  it("is loaded, and left alone", async () => {
    const state = aRailOwedWork();
    const demo = connectDemo({ state });
    await loadTheRailsAsASurfaceWould(state);

    // The plan really is in hand -- this is not silence for want of input.
    const orch = get(orchestrations)[DEMO.atlas];
    expect(orch.railRuns).toEqual([{ railId: "rail-auth", state: "running", currentStageId: "stage-auth-1" }]);
    expect(get(kanbanState)[DEMO.atlas]).toBeDefined();
    expect(demo.commands()).toContain("get_orchestration");

    expect(schedulerTraffic(demo.commands())).toEqual([]);
    expect(get(orchestrations)[DEMO.atlas]).toEqual(orch);
  });

  it("is left alone when its plan is read again, and when a pass is asked for by name", async () => {
    const state = aRailOwedWork();
    const demo = connectDemo({ state });
    await loadTheRailsAsASurfaceWould(state);

    await refreshOrchestration(DEMO.atlas);
    await tick(DEMO.atlas);
    await settle();

    expect(schedulerTraffic(demo.commands())).toEqual([]);
  });

  it("is left alone even by a scheduler something started", async () => {
    const state = aRailOwedWork();
    const demo = connectDemo({ state });
    await loadTheRailsAsASurfaceWould(state);

    const stop = startScheduler();
    // Every kind of thing the scheduler wakes for: a status, an exit,
    // the layout itself.
    handleSessionStatusChanged("s-atlas-auth", "idle");
    recordSessionExit("s-atlas-auth", 0);
    layoutState.update((s) => ({ ...s }));
    await settle();
    stop();

    expect(schedulerTraffic(demo.commands())).toEqual([]);
  });
});

describe("the bundle's own code", () => {
  // The three doors to the desktop's duties. The identity above makes
  // each of them inert for rails; this keeps the bundle from opening
  // them at all, because the scheduler is not the only thing behind
  // them (the launch queue, auto-resume, the reclaim of idle sessions).
  const DOORS = [/\binitOrchestrationListeners\b/, /\bstartScheduler\b/, /\bbootstrap\s*\(/];

  it("is found by this guard", () => {
    const names = Object.keys(companionSources());
    expect(names.length).toBeGreaterThan(10);
    expect(names).toContain("companion/remote/core.ts");
    expect(names).toContain("companion/state/workstation.ts");
    expect(names).toContain("routes/+page.svelte");
  });

  it("never starts the scheduler, and never runs the desktop's bootstrap", () => {
    const opened = Object.entries(companionSources()).flatMap(([name, text]) =>
      DOORS.filter((door) => door.test(codeOf(text))).map((door) => `${name}: ${door}`)
    );
    expect(opened).toEqual([]);
  });
});
