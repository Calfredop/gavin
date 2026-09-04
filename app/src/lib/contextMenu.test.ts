import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  contextMenu,
  closeContextMenu,
  openContextMenu,
  openContextMenuFromEvent,
  openMenuUnder,
  setContextMenuEntries,
} from "./contextMenu";

beforeEach(() => closeContextMenu());

function fakeEvent(x: number, y: number) {
  return {
    clientX: x,
    clientY: y,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as MouseEvent;
}

describe("openContextMenuFromEvent", () => {
  it("opens the menu at the pointer and claims the event", () => {
    const e = fakeEvent(40, 50);
    const entries = [{ label: "Do it", onPick: () => {} }];
    openContextMenuFromEvent(e, entries);
    expect(get(contextMenu)).toEqual({ x: 40, y: 50, entries });
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopPropagation).toHaveBeenCalled();
  });

  it("still claims the event when there is nothing to show, so the native menu never appears", () => {
    const e = fakeEvent(1, 2);
    openContextMenuFromEvent(e, [{ separator: true }]);
    expect(get(contextMenu)).toBeNull();
    expect(e.preventDefault).toHaveBeenCalled();
  });
});

describe("openContextMenu", () => {
  it("ignores a list without any actionable item", () => {
    openContextMenu(0, 0, []);
    expect(get(contextMenu)).toBeNull();
  });
});

describe("openMenuUnder", () => {
  function fakeButton(rect: { left: number; bottom: number }) {
    return { getBoundingClientRect: () => rect } as unknown as HTMLElement;
  }

  it("anchors the menu at the button's bottom-left, not at the pointer", () => {
    const entries = [{ label: "Single", onPick: () => {} }];
    openMenuUnder(fakeButton({ left: 120, bottom: 36 }), entries);
    expect(get(contextMenu)).toEqual({ x: 120, y: 40, entries });
  });
});

// What a `keepOpen` checkbox needs: its own click changed the state the
// entries were built from, and the list is a plain array captured when
// the menu opened, so the tick would otherwise only appear the next
// time the menu was opened.
describe("setContextMenuEntries", () => {
  it("swaps the entries of the open menu without moving it", () => {
    openMenuUnder({ getBoundingClientRect: () => ({ left: 8, bottom: 20 }) } as unknown as HTMLElement, [
      { label: "With agent", checked: false, keepOpen: true, onPick: () => {} },
    ]);

    setContextMenuEntries([{ label: "With agent", checked: true, keepOpen: true, onPick: () => {} }]);

    const state = get(contextMenu);
    expect(state?.x).toBe(8);
    expect(state?.y).toBe(24);
    expect(state?.entries).toHaveLength(1);
    expect(state?.entries[0]).toMatchObject({ label: "With agent", checked: true });
  });

  it("does nothing when no menu is up, rather than opening one nobody asked for", () => {
    setContextMenuEntries([{ label: "With agent", onPick: () => {} }]);
    expect(get(contextMenu)).toBeNull();
  });
});
