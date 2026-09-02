import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  contextMenu,
  closeContextMenu,
  openContextMenu,
  openContextMenuFromEvent,
  openMenuUnder,
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
