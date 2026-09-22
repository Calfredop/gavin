import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
import { source } from "$lib/sources";
import {
  contextMenu,
  closeContextMenu,
  openContextMenu,
  openContextMenuFromEvent,
  openMenuUnder,
  setContextMenuEntries,
  suppressesNativeMenu,
  isInsideContextMenu,
  CONTEXT_MENU_ATTR,
  CONTEXT_MENU_SELECTOR,
  type NativeMenuEvent,
} from "$lib/core/contextMenu";

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

/// A right-click target, duck-typed the way the module reads it.
/// `closest` answers nothing by default -- only the terminal case says yes.
function on(el: Record<string, unknown>): NativeMenuEvent["target"] {
  return { closest: () => null, ...el } as unknown as NativeMenuEvent["target"];
}

function rightClick(target: NativeMenuEvent["target"], extra: Partial<NativeMenuEvent> = {}): NativeMenuEvent {
  return { target, altKey: false, defaultPrevented: false, ...extra };
}

/// A node exactly as given -- unlike `on`, no default `closest`, so a
/// bare `{}` stays a node that cannot answer.
function bare(el: Record<string, unknown>): EventTarget {
  return el as unknown as EventTarget;
}

describe("isInsideContextMenu", () => {
  it("is false for nothing, and for a node that cannot answer", () => {
    expect(isInsideContextMenu(null)).toBe(false);
    expect(isInsideContextMenu(bare({}))).toBe(false);
  });

  it("asks closest for the shared menu layer", () => {
    expect(
      isInsideContextMenu(
        bare({
          closest: (s: string) => (s === CONTEXT_MENU_SELECTOR ? {} : null),
        })
      )
    ).toBe(true);
    expect(isInsideContextMenu(bare({ closest: () => null }))).toBe(false);
  });

  it("the layer marks itself with the same attribute the helper looks for", () => {
    expect(source("ContextMenu.svelte")).toContain(CONTEXT_MENU_ATTR);
  });
});

describe("suppressesNativeMenu", () => {
  it("takes the native menu off a plain surface", () => {
    expect(suppressesNativeMenu(rightClick(on({ tagName: "DIV" })))).toBe(true);
  });

  it("takes it off a right-click that hit nothing", () => {
    expect(suppressesNativeMenu(rightClick(null))).toBe(true);
  });

  it("leaves a text input its editing menu", () => {
    expect(suppressesNativeMenu(rightClick(on({ tagName: "INPUT", type: "text" })))).toBe(false);
  });

  it("leaves an input with no type its editing menu", () => {
    expect(suppressesNativeMenu(rightClick(on({ tagName: "INPUT" })))).toBe(false);
  });

  it("leaves a textarea its editing menu", () => {
    expect(suppressesNativeMenu(rightClick(on({ tagName: "TEXTAREA" })))).toBe(false);
  });

  it("leaves a contenteditable its editing menu", () => {
    expect(suppressesNativeMenu(rightClick(on({ tagName: "DIV", isContentEditable: true })))).toBe(false);
  });

  // A checkbox, a radio, a colour well and hundreds of buttons all take a
  // right-click in this app; Cut/Copy/Paste over one of them is noise.
  it.each(["checkbox", "radio", "color", "button", "submit"])("takes it off an <input type=%s>", (type) => {
    expect(suppressesNativeMenu(rightClick(on({ tagName: "INPUT", type })))).toBe(true);
  });

  // xterm focuses a hidden <textarea>, but a terminal is not a text
  // field -- its clipboard travels to the pty, and ⌘C/⌘V there are ours.
  it("takes it off the terminal, hidden textarea and all", () => {
    const inTerminal = on({ tagName: "TEXTAREA", closest: (s: string) => (s === ".xterm" ? {} : null) });
    expect(suppressesNativeMenu(rightClick(inTerminal))).toBe(true);
  });

  it("lets ⌥ through to WebKit, which is the only route to the inspector", () => {
    expect(suppressesNativeMenu(rightClick(on({ tagName: "DIV" }), { altKey: true }))).toBe(false);
  });

  it("stands down when something nearer the target already answered", () => {
    expect(suppressesNativeMenu(rightClick(on({ tagName: "DIV" }), { defaultPrevented: true }))).toBe(false);
  });
});
