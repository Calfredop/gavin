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
