import { describe, expect, it } from "vitest";
import { resolveTheme } from "$lib/ui/theme";
import {
  appearanceKey,
  DEFAULT_APPEARANCE,
  loadAppearance,
  localThemePref,
  saveAppearance,
} from "$companion/state/appearance";
import { deviceStorage } from "$companion/testing/desktopStores";

describe("the phone's appearance", () => {
  it("follows the Workstation until the phone chooses otherwise", () => {
    expect(DEFAULT_APPEARANCE).toBe("workstation");
    expect(loadAppearance(deviceStorage(), "demo")).toBe("workstation");
    expect(loadAppearance(null, "demo")).toBe("workstation");
  });

  it("is kept per Workstation, in the Device's storage", () => {
    const storage = deviceStorage();
    saveAppearance(storage, "demo", "light");
    expect(storage.items).toEqual({ [appearanceKey("demo")]: "light" });
    expect(loadAppearance(storage, "demo")).toBe("light");
    expect(loadAppearance(storage, "other")).toBe("workstation");
  });

  it("reads anything it does not know as the default, and never throws", () => {
    expect(loadAppearance(deviceStorage({ [appearanceKey("demo")]: "sepia" }), "demo")).toBe("workstation");
    const refusing = {
      getItem: (): string | null => {
        throw new Error("storage switched off");
      },
      setItem: (): void => {
        throw new Error("storage full");
      },
    };
    expect(loadAppearance(refusing, "demo")).toBe("workstation");
    expect(() => saveAppearance(refusing, "demo", "dark")).not.toThrow();
  });

  it("decides the theme over the desk's, with the phone's own appearance as the bundle's system", () => {
    const desk = "dark";
    const phone = "light";
    const drawn = (a: Parameters<typeof localThemePref>[0]) => resolveTheme(localThemePref(a) ?? desk, phone);
    expect(drawn("workstation")).toBe("dark");
    expect(drawn("phone")).toBe("light");
    expect(drawn("light")).toBe("light");
    expect(drawn("dark")).toBe("dark");
  });
});
