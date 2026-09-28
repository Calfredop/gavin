import { afterEach, describe, expect, it } from "vitest";
import { emit, listen } from "@tauri-apps/api/event";
import { appDuty, tellOtherWindows } from "$lib/shell/appDuty";
import { disconnectChannel } from "$companion/remote/connection";
import { connectDemo, settle } from "$companion/testing/demoBench";

afterEach(() => {
  appDuty.set({ holder: "main", windows: [] });
  disconnectChannel();
});

describe("emit", () => {
  // On the desk `emit` is how one window tells the others what it read
  // or wrote. A Device is not one of the desk's windows, and the channel
  // has no message for it: an event travels one way, to the bundle.
  it("is refused, and nothing is sent", async () => {
    const demo = connectDemo();
    await expect(emit("orchestration-written", { origin: "companion", payload: "w1" })).rejects.toBe(
      'the Companion cannot emit "orchestration-written": events only travel from the Workstation'
    );
    await settle();
    expect(demo.received()).toEqual([]);
  });

  it("does not trip the desktop module that tells its other windows", async () => {
    const demo = connectDemo();
    // As the desk reports it: a main window is open, so from where the
    // bundle stands there IS another window to tell.
    appDuty.set({ holder: "main", windows: ["main"] });
    expect(() => tellOtherWindows("usage-reading", { used: 1 })).not.toThrow();
    await settle();
    expect(demo.received()).toEqual([]);
  });
});

describe("listen", () => {
  it("rejects with a plain string when nothing is connected", async () => {
    await expect(listen("cwd-changed", () => {})).rejects.toBe("the channel is not connected");
  });
});
