import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above the imports, so the mock function has to be
// created by vi.hoisted rather than a plain top-level const.
const { platformMock } = vi.hoisted(() => ({ platformMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: platformMock }));

import { initPlatform, isMacSync, cmdHeld } from "./platform";

beforeEach(() => {
  platformMock.mockReset();
});

describe("platform", () => {
  it("reads false before init and true after init on macOS", async () => {
    expect(isMacSync()).toBe(false);
    platformMock.mockResolvedValue("macos");
    await initPlatform();
    expect(isMacSync()).toBe(true);
  });

  it("cmdHeld follows metaKey on macOS and ctrlKey elsewhere", async () => {
    platformMock.mockResolvedValue("macos");
    await initPlatform();
    expect(cmdHeld({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(cmdHeld({ metaKey: false, ctrlKey: true })).toBe(false);

    platformMock.mockResolvedValue("windows");
    await initPlatform();
    expect(cmdHeld({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(cmdHeld({ metaKey: true, ctrlKey: false })).toBe(false);
  });
});
