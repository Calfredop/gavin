// The Tauri plugins the desktop's modules import. Each names something
// the DESK's window can do natively; none of their own code may ship in
// a bundle, because all of it ends in a call to a native bridge this page
// does not have and must never be given (ADR 0005).
import { afterEach, describe, expect, it, vi } from "vitest";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { platform } from "@tauri-apps/plugin-os";
import { currentPlatform, isMacSync } from "$lib/core/platform";
import { disconnectChannel } from "$companion/remote/connection";
import { connectDemo, settle } from "$companion/testing/demoBench";

afterEach(() => {
  vi.unstubAllGlobals();
  disconnectChannel();
});

describe("notifications", () => {
  // What reaches a phone is the shell's encrypted push. A bundle raising
  // one of its own would be a second, unencrypted route to the same tray.
  it("are never the bundle's to raise", async () => {
    const demo = connectDemo();
    await expect(isPermissionGranted()).resolves.toBe(false);
    await expect(requestPermission()).resolves.toBe("denied");
    expect(() => sendNotification({ title: "gavin", body: "token refresh finished" })).not.toThrow();
    expect(() => sendNotification("token refresh finished")).not.toThrow();
    await settle();
    expect(demo.received()).toEqual([]);
  });
});

describe("the clipboard", () => {
  it("is the page's own", async () => {
    const clipboard = { writeText: vi.fn(async () => {}), readText: vi.fn(async () => "pasted") };
    vi.stubGlobal("navigator", { clipboard });
    await writeText("git switch feat/x");
    expect(clipboard.writeText).toHaveBeenCalledWith("git switch feat/x");
    await expect(readText()).resolves.toBe("pasted");
  });

  it("rejects with a plain string where the page has none", async () => {
    vi.stubGlobal("navigator", {});
    await expect(writeText("x")).rejects.toBe("this Companion has no clipboard to write to");
    await expect(readText()).rejects.toBe("this Companion has no clipboard to read from");
  });

  it("rejects with the page's own reason when the page refuses", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: async () => {
          throw new Error("NotAllowedError");
        },
      },
    });
    await expect(writeText("x")).rejects.toBe("NotAllowedError");
  });

  it("is never the desk's", async () => {
    const demo = connectDemo();
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => {}, readText: async () => "" } });
    await writeText("x");
    await readText();
    await settle();
    expect(demo.received()).toEqual([]);
  });
});

describe("the file picker", () => {
  // It opens on the desk, in front of nobody. Choosing a folder from a
  // Device is a surface of its own, browsing the Workstation's folders.
  it("answers as a picker the human closed, and opens nothing", async () => {
    const demo = connectDemo();
    await expect(open({ directory: true })).resolves.toBeNull();
    await expect(open()).resolves.toBeNull();
    await settle();
    expect(demo.received()).toEqual([]);
  });
});

describe("the platform", () => {
  // The desktop asks this for two different things -- which keys a
  // shortcut is drawn with, and how a command is quoted for the machine
  // that will run it. On a Device those are two different machines, so
  // the bundle declines to answer rather than answer for the wrong one.
  it("cannot be told, which the desktop reads as gating nothing", () => {
    expect(() => platform()).toThrow();
    expect(currentPlatform()).toBeNull();
    expect(isMacSync()).toBe(false);
  });
});
