import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";
import { source } from "$lib/sources";
import {
  createPeekHoverController,
  endSidebarPeek,
  peekSidebar,
  PEEK_HOVER_CLOSE_MS,
  PEEK_HOVER_OPEN_MS,
  sidebarPeek,
  sidebarShowsFull,
  sidebarShowsRail,
} from "$lib/sidebar/sidebarPeek";

const SOURCE = source("sidebarPeek.ts");

beforeEach(() => {
  endSidebarPeek();
});

afterEach(() => {
  vi.useRealTimers();
  endSidebarPeek();
});

describe("peeking at a collapsed sidebar", () => {
  it("opens on a press and closes again", () => {
    expect(get(sidebarPeek)).toBe(false);
    peekSidebar();
    expect(get(sidebarPeek)).toBe(true);
    endSidebarPeek();
    expect(get(sidebarPeek)).toBe(false);
  });

  // Nothing writes it to storage: a peek is a gesture, and a window that
  // reopened mid-peek would be a window whose sidebar is wedged open
  // over its content with no pointer anywhere near it.
  it("is not remembered anywhere", () => {
    expect(SOURCE).not.toContain("localStorage");
    expect(SOURCE).not.toContain("Storage");
  });
});

describe("which sidebar the column draws", () => {
  // The two questions every surface asks, so none of them combines the
  // flags itself. An expanded sidebar is never a rail, peek or no peek --
  // the peek flag can outlive an expand, and a stale true must not be
  // able to turn an open sidebar into anything.
  it("draws the rail only while collapsed and not peeking", () => {
    expect(sidebarShowsRail(true, false)).toBe(true);
    expect(sidebarShowsRail(true, true)).toBe(false);
    expect(sidebarShowsRail(false, false)).toBe(false);
    expect(sidebarShowsRail(false, true)).toBe(false);
  });

  it("draws the full column whenever it is not drawing the rail", () => {
    for (const collapsed of [true, false]) {
      for (const peeking of [true, false]) {
        expect(sidebarShowsFull(collapsed, peeking)).toBe(!sidebarShowsRail(collapsed, peeking));
      }
    }
  });
});

describe("hovering the collapsed rail", () => {
  // A glance across the icon rail must not flash the overlay. The
  // pointer has to stay on it for the dwell; leaving before that
  // cancels, and leaving after it waits out a shorter close delay so a
  // restyle under the cursor cannot slam the column shut.
  it("opens only after the dwell, and not at all if the pointer leaves first", () => {
    vi.useFakeTimers();
    const hover = createPeekHoverController();
    hover.enter({ enabled: true, collapsed: true, peeking: false });
    vi.advanceTimersByTime(PEEK_HOVER_OPEN_MS - 1);
    expect(get(sidebarPeek)).toBe(false);
    hover.leave({ enabled: true, peeking: false });
    vi.advanceTimersByTime(PEEK_HOVER_OPEN_MS);
    expect(get(sidebarPeek)).toBe(false);

    hover.enter({ enabled: true, collapsed: true, peeking: false });
    vi.advanceTimersByTime(PEEK_HOVER_OPEN_MS);
    expect(get(sidebarPeek)).toBe(true);
    hover.cancel();
  });

  it("keeps a peek that the pointer re-enters before the close delay", () => {
    vi.useFakeTimers();
    peekSidebar();
    const hover = createPeekHoverController();
    hover.leave({ enabled: true, peeking: true });
    vi.advanceTimersByTime(PEEK_HOVER_CLOSE_MS - 1);
    expect(get(sidebarPeek)).toBe(true);
    hover.enter({ enabled: true, collapsed: true, peeking: true });
    vi.advanceTimersByTime(PEEK_HOVER_CLOSE_MS);
    expect(get(sidebarPeek)).toBe(true);
    hover.cancel();
  });

  it("closes after the leave delay, and at once when hover-to-open is off", () => {
    vi.useFakeTimers();
    peekSidebar();
    const hover = createPeekHoverController();
    hover.leave({ enabled: true, peeking: true });
    vi.advanceTimersByTime(PEEK_HOVER_CLOSE_MS - 1);
    expect(get(sidebarPeek)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(get(sidebarPeek)).toBe(false);

    peekSidebar();
    hover.leave({ enabled: false, peeking: true });
    expect(get(sidebarPeek)).toBe(false);
    hover.cancel();
  });

  it("does nothing when the setting is off or the sidebar is expanded", () => {
    vi.useFakeTimers();
    const hover = createPeekHoverController();
    hover.enter({ enabled: false, collapsed: true, peeking: false });
    hover.enter({ enabled: true, collapsed: false, peeking: false });
    vi.advanceTimersByTime(PEEK_HOVER_OPEN_MS);
    expect(get(sidebarPeek)).toBe(false);
    hover.cancel();
  });

  // The shared menu mounts at the app root, under the cursor, so
  // opening it is a mouseleave of the column. That leave must not
  // dismiss a peek the human is still using.
  it("does not close while a hold (an open context menu) is up", () => {
    vi.useFakeTimers();
    peekSidebar();
    const hover = createPeekHoverController();
    hover.leave({ enabled: true, peeking: true, hold: true });
    vi.advanceTimersByTime(PEEK_HOVER_CLOSE_MS);
    expect(get(sidebarPeek)).toBe(true);
    hover.leave({ enabled: false, peeking: true, hold: true });
    expect(get(sidebarPeek)).toBe(true);
    hover.cancel();
  });
});

describe("the hover peek is wired through, not re-derived in the template", () => {
  it("the sidebar drives enter/leave through the controller", () => {
    const sidebar = source("Sidebar.svelte");
    expect(sidebar).toContain("createPeekHoverController");
    expect(sidebar).toContain("sidebarPeekOnHover");
    expect(sidebar).toContain("isInsideContextMenu");
    expect(sidebar).toContain("hold:");
  });

  it("Settings draws the toggle next to Scratchpad", () => {
    const settings = source("GlobalSettingsModal.svelte");
    expect(settings).toContain("sidebarPeekOnHover");
    expect(settings).toContain("Hover to expand");
  });
});
