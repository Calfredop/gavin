import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above the imports, so the mock function has to be
// created by vi.hoisted rather than a plain top-level const.
const { platformMock } = vi.hoisted(() => ({ platformMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: platformMock }));

// The module caches its answer, so each case re-imports it fresh.
async function freshPlatform() {
  vi.resetModules();
  return import("$lib/core/platform");
}

beforeEach(() => {
  platformMock.mockReset();
});

describe("isMacSync", () => {
  it("is true on macOS and false elsewhere", async () => {
    platformMock.mockReturnValue("macos");
    expect((await freshPlatform()).isMacSync()).toBe(true);

    platformMock.mockReturnValue("windows");
    expect((await freshPlatform()).isMacSync()).toBe(false);
  });

  it("asks the plugin only once", async () => {
    platformMock.mockReturnValue("macos");
    const { isMacSync } = await freshPlatform();
    isMacSync();
    isMacSync();
    expect(platformMock).toHaveBeenCalledTimes(1);
  });

  it("answers false instead of throwing outside a Tauri window, and retries later", async () => {
    platformMock.mockImplementation(() => {
      throw new TypeError("__TAURI_OS_PLUGIN_INTERNALS__ is undefined");
    });
    const { isMacSync } = await freshPlatform();
    expect(isMacSync()).toBe(false);

    // The failure must not be cached: once the global exists, the real
    // answer has to win.
    platformMock.mockReturnValue("macos");
    expect(isMacSync()).toBe(true);
  });
});

describe("currentPlatform", () => {
  it("answers with the one it is on", async () => {
    platformMock.mockReturnValue("linux");
    expect((await freshPlatform()).currentPlatform()).toBe("linux");

    platformMock.mockReturnValue("windows");
    expect((await freshPlatform()).currentPlatform()).toBe("windows");
  });

  // The whole reason the return type has a null in it. A platform gate
  // that treated "I could not tell" as "not supported" would refuse in
  // every unit test and every browser preview.
  it("answers null for a platform it does not know, and outside a Tauri window", async () => {
    platformMock.mockReturnValue("ios");
    expect((await freshPlatform()).currentPlatform()).toBeNull();

    platformMock.mockImplementation(() => {
      throw new TypeError("__TAURI_OS_PLUGIN_INTERNALS__ is undefined");
    });
    const outside = await freshPlatform();
    expect(outside.currentPlatform()).toBeNull();

    // Same retry rule isMacSync has: a throw is not an answer, so it is
    // not cached as one.
    platformMock.mockReturnValue("linux");
    expect(outside.currentPlatform()).toBe("linux");
  });

  // A known-but-unsupported platform IS an answer, unlike a throw, so
  // asking again must not re-enter the plugin.
  it("caches an unknown platform, and shares one read with isMacSync", async () => {
    platformMock.mockReturnValue("ios");
    const { currentPlatform, isMacSync } = await freshPlatform();
    currentPlatform();
    currentPlatform();
    isMacSync();
    expect(platformMock).toHaveBeenCalledTimes(1);
  });
});

describe("cmdHeld", () => {
  it("follows metaKey on macOS and ctrlKey elsewhere", async () => {
    platformMock.mockReturnValue("macos");
    const mac = await freshPlatform();
    expect(mac.cmdHeld({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(mac.cmdHeld({ metaKey: false, ctrlKey: true })).toBe(false);

    platformMock.mockReturnValue("windows");
    const other = await freshPlatform();
    expect(other.cmdHeld({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(other.cmdHeld({ metaKey: true, ctrlKey: false })).toBe(false);
  });
});
