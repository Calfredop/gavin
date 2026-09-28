import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPANION_WINDOW_LABEL, getCurrentWindow } from "$companion/remote/window";

afterEach(() => {
  vi.unstubAllGlobals();
});

/// A `matchMedia` for the one query the shim asks, whose answer a test
/// can change the way a phone's appearance setting does.
function stubScheme(light: boolean) {
  const handlers = new Set<(e: { matches: boolean }) => void>();
  const list = {
    matches: light,
    addEventListener: (_: "change", h: (e: { matches: boolean }) => void) => void handlers.add(h),
    removeEventListener: (_: "change", h: (e: { matches: boolean }) => void) => void handlers.delete(h),
  };
  vi.stubGlobal("matchMedia", (query: string) => {
    expect(query).toBe("(prefers-color-scheme: light)");
    return list;
  });
  return {
    turn(toLight: boolean): void {
      list.matches = toLight;
      for (const h of handlers) h({ matches: toLight });
    },
    listeners: () => handlers.size,
  };
}

describe("the Companion's window", () => {
  it("has a label no desktop window has", () => {
    expect(COMPANION_WINDOW_LABEL).toBe("companion");
    expect(getCurrentWindow().label).toBe(COMPANION_WINDOW_LABEL);
    expect(COMPANION_WINDOW_LABEL).not.toBe("main");
    expect(COMPANION_WINDOW_LABEL.startsWith("ws-")).toBe(false);
  });

  it("is always in front: what reaches a phone in the background is the shell's push", async () => {
    await expect(getCurrentWindow().isFocused()).resolves.toBe(true);
  });

  it("takes its theme from the Device", async () => {
    stubScheme(true);
    await expect(getCurrentWindow().theme()).resolves.toBe("light");
    stubScheme(false);
    await expect(getCurrentWindow().theme()).resolves.toBe("dark");
  });

  it("has no theme to report where the question cannot be asked", async () => {
    await expect(getCurrentWindow().theme()).resolves.toBeNull();
  });

  it("says when the Device's appearance changes, until told to stop", async () => {
    const scheme = stubScheme(false);
    const heard = vi.fn();
    const stop = await getCurrentWindow().onThemeChanged(heard);

    scheme.turn(true);
    expect(heard).toHaveBeenLastCalledWith({ payload: "light" });
    scheme.turn(false);
    expect(heard).toHaveBeenLastCalledWith({ payload: "dark" });

    stop();
    expect(scheme.listeners()).toBe(0);
    scheme.turn(true);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("is never asked to close: leaving is the hub's business", async () => {
    const asked = vi.fn();
    const stop = await getCurrentWindow().onCloseRequested(asked);
    stop();
    expect(asked).not.toHaveBeenCalled();
  });

  it("is never resized the way a window is: the page's own layout follows the screen", async () => {
    const resized = vi.fn();
    const stop = await getCurrentWindow().onResized(resized);
    stop();
    expect(resized).not.toHaveBeenCalled();
  });

  it("has nothing to drag, resize, minimize or close", async () => {
    const w = getCurrentWindow();
    await expect(w.isMaximized()).resolves.toBe(false);
    for (const gesture of [
      w.startDragging(),
      w.startResizeDragging("East"),
      w.toggleMaximize(),
      w.minimize(),
      w.close(),
      w.destroy(),
    ]) {
      await expect(gesture).resolves.toBeUndefined();
    }
  });
});
