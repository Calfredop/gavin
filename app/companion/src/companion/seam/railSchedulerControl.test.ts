// The control for railScheduler.test.ts, and the only suite in this
// project that replaces a Tauri module by hand.
//
// It puts the desktop's identity back -- the window label the desktop
// falls back to outside Tauri, which is the main window's -- and runs the
// SAME state through the SAME loading. The scheduler acts, at once. That
// is what the other suite's silence is measured against: without this, a
// fixture that could never have launched anything would pass it too.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", isFocused: async () => true }),
}));

import { kanbanState } from "$lib/board/kanbanState";
import { __resetForTesting } from "$lib/orchestration/orchestrationState";
import { runsRailsFor } from "$lib/shell/appDuty";
import { DEMO } from "$companion/demo/sampleData";
import { disconnectChannel } from "$companion/remote/connection";
import { connectDemo } from "$companion/testing/demoBench";
import { aRailOwedWork, loadTheRailsAsASurfaceWould, SCHEDULER_COMMANDS } from "$companion/testing/railBench";

afterEach(() => {
  __resetForTesting();
  kanbanState.set({});
  disconnectChannel();
});

describe("the same rail, in a page that believes it is the desktop's main window", () => {
  it("is run", async () => {
    expect(runsRailsFor(DEMO.atlas)).toBe(true);

    const state = aRailOwedWork();
    const demo = connectDemo({ state });
    await loadTheRailsAsASurfaceWould(state);

    const acted = demo.commands().filter((cmd) => SCHEDULER_COMMANDS.includes(cmd));
    // The step whose card is Done is written done: the first thing a
    // scheduler owes this rail.
    expect(acted).toContain("set_step_run");
    const write = demo.received().find((m) => m.type === "invoke" && m.cmd === "set_step_run");
    expect(write).toMatchObject({ args: { stepId: "step-token-refresh", stateValue: "done" } });
  });
});
