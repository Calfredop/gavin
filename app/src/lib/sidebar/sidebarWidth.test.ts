import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import { source } from "$lib/sources";
import {
  beginSidebarResize,
  clampSidebarWidth,
  loadSidebarWidth,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  resetSidebarWidth,
  saveSidebarWidth,
  SIDEBAR_WIDTH_KEY,
  sidebarWidth,
  sidebarWidthStyle,
} from "$lib/sidebar/sidebarWidth";

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

function pointer(type: string, clientX: number, buttons = 1): Event {
  const e = new Event(type);
  Object.assign(e, { clientX, buttons });
  return e;
}

beforeEach(() => {
  sidebarWidth.set(null);
});

describe("the sidebar's chosen width", () => {
  it("clamps to the range a column can sensibly be", () => {
    expect(clampSidebarWidth(10)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(9999)).toBe(MAX_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(260.4)).toBe(260);
  });

  it("reads absent, blank, corrupt or refused storage as never dragged", () => {
    expect(loadSidebarWidth(memoryStorage())).toBeNull();
    expect(loadSidebarWidth(memoryStorage({ [SIDEBAR_WIDTH_KEY]: "" }))).toBeNull();
    expect(loadSidebarWidth(memoryStorage({ [SIDEBAR_WIDTH_KEY]: "wide" }))).toBeNull();
    expect(loadSidebarWidth(undefined)).toBeNull();
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(loadSidebarWidth(throwing)).toBeNull();
  });

  it("round-trips a width, clamped, and a reset clears the key", () => {
    const storage = memoryStorage();
    saveSidebarWidth(300, storage);
    expect(loadSidebarWidth(storage)).toBe(300);
    saveSidebarWidth(5000, storage);
    expect(loadSidebarWidth(storage)).toBe(MAX_SIDEBAR_WIDTH);
    sidebarWidth.set(300);
    resetSidebarWidth(storage);
    expect(storage.data.has(SIDEBAR_WIDTH_KEY)).toBe(false);
    expect(get(sidebarWidth)).toBeNull();
  });

  it("hands CSS nothing until the column has been dragged", () => {
    expect(sidebarWidthStyle(null)).toBeUndefined();
    expect(sidebarWidthStyle(280)).toBe("280px");
  });
});

describe("dragging the sidebar's edge", () => {
  it("follows the pointer live and stores the width once, on release", () => {
    const target = new EventTarget();
    const storage = memoryStorage();
    let ended = 0;
    beginSidebarResize(200, 100, { target, storage, onEnd: () => ended++ });
    target.dispatchEvent(pointer("pointermove", 150));
    expect(get(sidebarWidth)).toBe(250);
    expect(storage.data.has(SIDEBAR_WIDTH_KEY)).toBe(false);
    target.dispatchEvent(pointer("pointermove", 180));
    target.dispatchEvent(pointer("pointerup", 180, 0));
    expect(get(sidebarWidth)).toBe(280);
    expect(storage.data.get(SIDEBAR_WIDTH_KEY)).toBe("280");
    expect(ended).toBe(1);
    // Listeners are gone: a later move changes nothing.
    target.dispatchEvent(pointer("pointermove", 400));
    expect(get(sidebarWidth)).toBe(280);
  });

  it("writes nothing for a press that never moved", () => {
    const target = new EventTarget();
    const storage = memoryStorage();
    beginSidebarResize(200, 100, { target, storage });
    target.dispatchEvent(pointer("pointerup", 100, 0));
    expect(storage.data.has(SIDEBAR_WIDTH_KEY)).toBe(false);
    expect(get(sidebarWidth)).toBeNull();
  });

  // WKWebView drops pointerup when the pressed element leaves the DOM;
  // a move with no button down is the drag's end.
  it("ends on a move with no button down", () => {
    const target = new EventTarget();
    const storage = memoryStorage();
    let ended = 0;
    beginSidebarResize(200, 100, { target, storage, onEnd: () => ended++ });
    target.dispatchEvent(pointer("pointermove", 160));
    target.dispatchEvent(pointer("pointermove", 300, 0));
    expect(ended).toBe(1);
    expect(get(sidebarWidth)).toBe(260);
    expect(storage.data.get(SIDEBAR_WIDTH_KEY)).toBe("260");
  });

  it("stays inside the range however far the pointer goes", () => {
    const target = new EventTarget();
    beginSidebarResize(250, 100, { target, storage: memoryStorage() });
    target.dispatchEvent(pointer("pointermove", -500));
    expect(get(sidebarWidth)).toBe(MIN_SIDEBAR_WIDTH);
    target.dispatchEvent(pointer("pointermove", 5000));
    expect(get(sidebarWidth)).toBe(MAX_SIDEBAR_WIDTH);
  });
});

describe("where the chosen width is drawn", () => {
  // `source` covers $lib only; the page is a route.
  const ROUTES = import.meta.glob("../../routes/+page.svelte", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const PAGE = Object.values(ROUTES)[0] ?? "";
  const SIDEBAR = source("Sidebar.svelte");

  // The chrome in the column's top row sets a floor CSS already knows
  // per platform; the choice can only widen past it.
  it("never draws the open column narrower than its chrome", () => {
    expect(PAGE).not.toBe("");
    expect(PAGE).toContain(
      "--sidebar-open-width: max(var(--sidebar-width), var(--sidebar-chosen-width, 0px));"
    );
    expect(PAGE).toContain("--rail-width: var(--sidebar-open-width);");
    expect(PAGE).toContain("style:--sidebar-chosen-width={sidebarWidthStyle($sidebarWidth)}");
  });

  // A peek borrows the open width; a peek at the default width over a
  // column the human widened would be a different sidebar.
  it("peeks at the width the column opens to", () => {
    expect(SIDEBAR).toContain("width: var(--sidebar-open-width);");
  });

  it("offers the handle only while the column is open", () => {
    expect(PAGE).toMatch(/\{#if !\$sidebarCollapsed\}\s*<div\s+class="rail-resize"/);
    expect(PAGE).toContain("ondblclick={() => resetSidebarWidth()}");
  });
});
