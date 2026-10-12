// The phone's text size setting, followed: a probe in iOS's body style,
// read as a scale on the root.
import { get } from "svelte/store";
import { describe, expect, it } from "vitest";
import { followTextScale, scaleFor, terminalFontSize, textScale } from "$companion/surfaces/textScale";

describe("the scale a system body size makes", () => {
  it("is 1 at iOS's default size, 17px", () => {
    expect(scaleFor(17)).toBe(1);
  });

  it("follows every size iOS offers, smaller and larger (measured, iOS 27)", () => {
    expect(scaleFor(14)).toBe(0.824);
    expect(scaleFor(28)).toBe(1.647);
    // The largest accessibility size: the body text more than doubles.
    expect(scaleFor(53)).toBe(3.118);
  });

  it("is 1 where the probe said nothing usable", () => {
    expect(scaleFor(NaN)).toBe(1);
    expect(scaleFor(0)).toBe(1);
  });
});

describe("the terminal's size", () => {
  it("grows with the text, to twice the desk's at most", () => {
    expect(terminalFontSize(13, 1)).toBe(13);
    expect(terminalFontSize(13, 1.647)).toBe(21);
    expect(terminalFontSize(13, 3.118)).toBe(26);
  });

  it("does not shrink under the desk's", () => {
    expect(terminalFontSize(13, 0.824)).toBe(13);
  });
});

/// A page with a system body size that the test sets.
function page(supports: boolean) {
  const state = {
    bodyPx: "17px",
    root: new Map<string, string>(),
    appended: [] as unknown[],
    removed: 0,
    resize: null as null | (() => void),
    observing: 0,
    visibility: null as null | (() => void),
  };
  const probe = {
    style: { cssText: "" },
    textContent: null as string | null,
    attributes: new Map<string, string>(),
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    },
    remove() {
      state.removed++;
    },
  };
  const scope = {
    document: {
      documentElement: { style: { setProperty: (name: string, value: string) => state.root.set(name, value) } },
      body: { appendChild: (node: unknown) => state.appended.push(node) },
      createElement: () => probe,
      addEventListener: (_: string, listener: () => void) => (state.visibility = listener),
      removeEventListener: () => (state.visibility = null),
    },
    getComputedStyle: () => ({ fontSize: state.bodyPx }),
    CSS: { supports: (property: string, value: string) => supports && property === "font" && value === "-apple-system-body" },
    ResizeObserver: class {
      constructor(callback: () => void) {
        state.resize = callback;
      }
      observe() {
        state.observing++;
      }
      disconnect() {
        state.observing--;
      }
    },
  };
  return { state, probe, scope };
}

describe("following the phone's text size", () => {
  it("puts a hidden probe in iOS's body style on the page, and the scale on the root", () => {
    const { state, probe, scope } = page(true);
    state.bodyPx = "53px";
    const stop = followTextScale(scope);
    expect(state.appended).toEqual([probe]);
    expect(probe.style.cssText).toContain("font:-apple-system-body");
    expect(probe.style.cssText).toContain("visibility:hidden");
    expect(probe.attributes.get("aria-hidden")).toBe("true");
    expect(state.root.get("--text-scale")).toBe("3.118");
    expect(get(textScale)).toBe(3.118);
    stop();
  });

  it("follows a change without a restart: WebKit resizes the probe", () => {
    const { state, scope } = page(true);
    const stop = followTextScale(scope);
    expect(state.root.get("--text-scale")).toBe("1");
    state.bodyPx = "28px";
    state.resize?.();
    expect(state.root.get("--text-scale")).toBe("1.647");
    expect(get(textScale)).toBe(1.647);
    // And when the app comes back to the front.
    state.bodyPx = "14px";
    state.visibility?.();
    expect(state.root.get("--text-scale")).toBe("0.824");
    stop();
  });

  it("lets go of the probe and its listeners", () => {
    const { state, scope } = page(true);
    const stop = followTextScale(scope);
    expect(state.observing).toBe(1);
    stop();
    expect(state.observing).toBe(0);
    expect(state.visibility).toBeNull();
    expect(state.removed).toBe(1);
  });

  it("leaves the page at its own size where there is no system body style", () => {
    const { state, scope } = page(false);
    const stop = followTextScale(scope);
    expect(state.appended).toEqual([]);
    expect(state.root.has("--text-scale")).toBe(false);
    expect(get(textScale)).toBe(1);
    stop();
  });
});
