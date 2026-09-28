// "`layoutState`'s bootstrap calls many commands, so the demo must answer
// them." (the card's first trap)
//
// The bundle does not run the desktop's bootstrap -- workstation.ts says
// why -- but the surfaces still to come load the same tables through the
// same desktop modules, one at a time. So the Demo Workstation is held to
// the whole of it now, by running the real thing: a read the desktop adds
// to its bootstrap tomorrow fails here until the demo has an answer.
//
// Run under the desk's identity, like railSchedulerControl and for the
// same reason in reverse: a window that holds the app's duties asks the
// MOST, and the most is what the demo has to be able to answer.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    isFocused: async () => true,
    theme: async () => null,
    onThemeChanged: async () => () => {},
    onCloseRequested: async () => () => {},
  }),
}));

import { get } from "svelte/store";
import { bootstrap, layoutState, teardown } from "$lib/core/layoutState";
import type { DemoWorkstation } from "$companion/demo/workstation";
import { disconnectChannel } from "$companion/remote/connection";
import { LAYOUT_SAVING_COMMANDS } from "$companion/remote/remoteRole";
import { connectDemo, settle } from "$companion/testing/demoBench";
import { resetDesktopStores } from "$companion/testing/desktopStores";

afterEach(() => {
  teardown();
  disconnectChannel();
  resetDesktopStores();
});

/// Waits until the Workstation has been asked nothing new for a while.
/// The bootstrap starts pollers and retries on timers of its own, so
/// "every promise settled" is not a moment that arrives.
async function untilQuiet(demo: DemoWorkstation): Promise<void> {
  let seen = -1;
  for (let i = 0; i < 40 && seen !== demo.commands().length; i++) {
    seen = demo.commands().length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    await settle();
  }
}

describe("the desktop's bootstrap, against the Demo Workstation", () => {
  it("is answered in full, and comes up ready", async () => {
    const demo = connectDemo();
    await bootstrap();
    await untilQuiet(demo);

    expect([...new Set(demo.unanswered())].sort()).toEqual([]);
    expect(get(layoutState).status).toBe("ready");
    expect(get(layoutState).workspaces).toHaveLength(3);
  }, 30_000);

  it("finds nothing in the demo's layout to repair, so it saves nothing", async () => {
    // The desk repairs its layout as it starts -- a tab whose session is
    // gone is closed, and the layout saved. Sample data that provoked
    // that would be sample data that disagrees with itself.
    const demo = connectDemo();
    await bootstrap();
    await untilQuiet(demo);

    const saved = demo
      .commands()
      .filter((cmd) => (LAYOUT_SAVING_COMMANDS as readonly string[]).includes(cmd));
    expect(saved).toEqual([]);
  }, 30_000);
});
