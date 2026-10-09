// Seam 2 for the phone's own appearance (`state/appearance.ts`): the
// desktop's theme store on one end of the channel, the Demo Workstation
// on the other. What is held here is that the phone draws what it chose
// over the desk's theme -- the screen and the terminals both -- and that
// choosing never crosses the wire.
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTerminalTheme } from "$lib/terminal/terminalRegistry";
import { themeState } from "$lib/ui/themeState.svelte";
import { loopback } from "$companion/channel/port";
import { createDemoWorkstation, type DemoWorkstation } from "$companion/demo/workstation";
import { disconnectChannel } from "$companion/remote/connection";
import { appearanceKey } from "$companion/state/appearance";
import { connectWorkstation, saveSetting, setAppearance } from "$companion/state/workstation";
import { settle } from "$companion/testing/demoBench";
import { deviceStorage, resetDesktopStores } from "$companion/testing/desktopStores";
import { mark, traffic } from "$companion/testing/wire";

vi.mock("$lib/terminal/terminalRegistry", async (original) => ({
  ...(await original<typeof import("$lib/terminal/terminalRegistry")>()),
  applyTerminalTheme: vi.fn(),
}));

let disconnect: (() => void) | null = null;

afterEach(() => {
  disconnect?.();
  disconnect = null;
  disconnectChannel();
  resetDesktopStores();
  vi.unstubAllGlobals();
  vi.mocked(applyTerminalTheme).mockClear();
});

/// The phone's Light and Dark, as Control Center turns them.
function phoneIn(light: boolean) {
  const handlers = new Set<(e: { matches: boolean }) => void>();
  const list = {
    matches: light,
    addEventListener: (_: "change", h: (e: { matches: boolean }) => void) => void handlers.add(h),
    removeEventListener: (_: "change", h: (e: { matches: boolean }) => void) => void handlers.delete(h),
  };
  vi.stubGlobal("matchMedia", () => list);
  return {
    turn(toLight: boolean): void {
      list.matches = toLight;
      for (const h of handlers) h({ matches: toLight });
    },
  };
}

/// A desk on Dark, as the owner's was.
async function connected(storage = deviceStorage()): Promise<DemoWorkstation> {
  const demo = createDemoWorkstation();
  demo.state.settings.theme = "dark";
  disconnect = await connectWorkstation(loopback(demo), storage);
  await settle();
  return demo;
}

function drawn(): string | undefined {
  return vi.mocked(applyTerminalTheme).mock.calls.at(-1)?.[0];
}

function writes(demo: DemoWorkstation, from: number): string[] {
  return traffic(demo, from).filter((line) => line.startsWith("invoke set_"));
}

describe("the phone's own appearance", () => {
  it("follows the Workstation by default: a desk on Dark is dark on a phone in Light", async () => {
    phoneIn(true);
    await connected();
    expect(themeState.effective).toBe("dark");
    expect(drawn()).toBe("dark");
  });

  it("draws what the phone chose over the desk's theme, terminals included, from what the Device kept", async () => {
    phoneIn(true);
    await connected(deviceStorage({ [appearanceKey("demo")]: "light" }));
    expect(themeState.pref).toBe("dark");
    expect(themeState.effective).toBe("light");
    expect(drawn()).toBe("light");
  });

  it("follows the phone's Light and Dark when told to, and the desk's theme does not move it", async () => {
    const phone = phoneIn(true);
    const demo = await connected();
    setAppearance("phone");
    await settle();
    expect(themeState.effective).toBe("light");

    phone.turn(false);
    expect(themeState.effective).toBe("dark");
    expect(drawn()).toBe("dark");
    phone.turn(true);
    expect(themeState.effective).toBe("light");

    demo.state.settings.theme = "dark";
    demo.emit("app-settings-synced", { origin: "main" });
    await settle();
    expect(themeState.effective).toBe("light");
  });

  it("is kept on the Device and never written to the Workstation", async () => {
    phoneIn(true);
    const storage = deviceStorage();
    const demo = await connected(storage);
    const from = mark(demo);

    setAppearance("light");
    await settle();
    setAppearance("phone");
    await settle();

    expect(storage.items[appearanceKey("demo")]).toBe("phone");
    expect(writes(demo, from)).toEqual([]);
    expect(demo.state.settings.theme).toBe("dark");
  });

  it("leaves the desk's own control writing the desk, and the phone's choice standing over it", async () => {
    phoneIn(true);
    const demo = await connected(deviceStorage({ [appearanceKey("demo")]: "dark" }));
    const from = mark(demo);

    await saveSetting(() => themeState.setPref("light"));
    await settle();

    expect(writes(demo, from)).toEqual(["invoke set_theme_pref"]);
    expect(demo.state.settings.theme).toBe("light");
    expect(themeState.effective).toBe("dark");
  });

  it("follows the Workstation again once the phone hands the choice back", async () => {
    phoneIn(true);
    await connected(deviceStorage({ [appearanceKey("demo")]: "light" }));
    setAppearance("workstation");
    await settle();
    expect(themeState.local).toBeNull();
    expect(themeState.effective).toBe("dark");
  });
});
