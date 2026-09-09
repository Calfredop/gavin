import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import { source } from "./sources";
import {
  endSidebarPeek,
  peekSidebar,
  sidebarPeek,
  sidebarShowsFull,
  sidebarShowsRail,
} from "./sidebarPeek";

const SOURCE = source("sidebarPeek.ts");

beforeEach(() => {
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
