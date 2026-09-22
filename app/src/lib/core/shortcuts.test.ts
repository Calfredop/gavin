import { describe, it, expect } from "vitest";
import {
  SHORTCUTS,
  matchesChord,
  formatChord,
  formatShortcut,
  digitFromCode,
  resolveIndex,
  hintDigitFor,
} from "$lib/core/shortcuts";

function ev(over: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  } as KeyboardEvent;
}

describe("matchesChord", () => {
  it("matches meta on macOS and ctrl elsewhere", () => {
    const t = SHORTCUTS["new-tab"];
    expect(matchesChord(ev({ key: "t", metaKey: true }), t, true)).toBe(true);
    expect(matchesChord(ev({ key: "t", ctrlKey: true }), t, true)).toBe(false);
    expect(matchesChord(ev({ key: "t", ctrlKey: true }), t, false)).toBe(true);
    expect(matchesChord(ev({ key: "t", metaKey: true }), t, false)).toBe(false);
  });

  it("is case-insensitive on the key", () => {
    expect(matchesChord(ev({ key: "T", metaKey: true }), SHORTCUTS["new-tab"], true)).toBe(true);
  });

  it("requires declared modifiers and rejects undeclared ones", () => {
    const splitDown = SHORTCUTS["split-down"];
    expect(matchesChord(ev({ key: "d", metaKey: true, shiftKey: true }), splitDown, true)).toBe(true);
    expect(matchesChord(ev({ key: "d", metaKey: true }), splitDown, true)).toBe(false);
    // plain cmd+d must NOT fire when shift is also down
    expect(matchesChord(ev({ key: "d", metaKey: true, shiftKey: true }), SHORTCUTS["split-right"], true)).toBe(
      false
    );
    // an undeclared alt blocks the match
    expect(matchesChord(ev({ key: "t", metaKey: true, altKey: true }), SHORTCUTS["new-tab"], true)).toBe(false);
    // the other platform's modifier must not be down either
    expect(matchesChord(ev({ key: "t", metaKey: true, ctrlKey: true }), SHORTCUTS["new-tab"], true)).toBe(false);
  });
});

// A chord two actions claim fires only the one keyboard.ts happens to
// test first, and the other's button advertises a key that does
// something else.
describe("SHORTCUTS", () => {
  it("gives every action a chord of its own", () => {
    const spelled = Object.values(SHORTCUTS).map((c) => formatChord(c, true));
    expect(new Set(spelled).size).toBe(spelled.length);
  });

  it("jumps to the next waiting session on ⇧⌘A, and Ctrl+Shift+A off macOS", () => {
    expect(formatShortcut("next-waiting", true)).toBe("⇧⌘A");
    expect(formatShortcut("next-waiting", false)).toBe("Ctrl+Shift+A");
  });
});

describe("formatChord", () => {
  it("uses Apple's modifier order and symbols on macOS", () => {
    expect(formatChord({ key: "t" }, true)).toBe("⌘T");
    expect(formatChord({ key: "d", shift: true }, true)).toBe("⇧⌘D");
    expect(formatChord({ key: "1", alt: true }, true)).toBe("⌥⌘1");
    expect(formatChord({ key: "1", shift: true, alt: true }, true)).toBe("⌥⇧⌘1");
  });

  it("spells the modifiers out elsewhere", () => {
    expect(formatChord({ key: "t" }, false)).toBe("Ctrl+T");
    expect(formatChord({ key: "d", shift: true }, false)).toBe("Ctrl+Shift+D");
    expect(formatChord({ key: "1", alt: true }, false)).toBe("Ctrl+Alt+1");
  });

  it("formatShortcut resolves the registry", () => {
    expect(formatShortcut("close-tab", true)).toBe("⌘W");
    expect(formatShortcut("split-down", false)).toBe("Ctrl+Shift+D");
  });
});

describe("digitFromCode", () => {
  it("reads the digit row and the numpad, nothing else", () => {
    expect(digitFromCode("Digit3")).toBe(3);
    expect(digitFromCode("Digit0")).toBe(0);
    expect(digitFromCode("Numpad7")).toBe(7);
    expect(digitFromCode("KeyT")).toBeNull();
    expect(digitFromCode("")).toBeNull();
  });
});

describe("resolveIndex", () => {
  it("maps 1-8 to their position", () => {
    expect(resolveIndex(1, 5)).toBe(0);
    expect(resolveIndex(5, 5)).toBe(4);
  });
  it("returns null when the position does not exist", () => {
    expect(resolveIndex(6, 5)).toBeNull();
    expect(resolveIndex(1, 0)).toBeNull();
  });
  it("maps 9 to the last and 0 to the first", () => {
    expect(resolveIndex(9, 5)).toBe(4);
    expect(resolveIndex(9, 12)).toBe(11);
    expect(resolveIndex(0, 5)).toBe(0);
  });
  it("returns null for an empty list", () => {
    expect(resolveIndex(9, 0)).toBeNull();
    expect(resolveIndex(0, 0)).toBeNull();
  });
});

describe("hintDigitFor", () => {
  it("labels positions 1-8 with their own digit", () => {
    expect(hintDigitFor(0, 5)).toBe(1);
    expect(hintDigitFor(4, 5)).toBe(5);
  });
  it("does not show the 0 alias on the first item nor 9 on a reachable last", () => {
    expect(hintDigitFor(0, 5)).not.toBe(0);
    expect(hintDigitFor(4, 5)).toBe(5);
  });
  it("labels the last item 9 only when the list is longer than 8", () => {
    expect(hintDigitFor(9, 10)).toBe(9);
    expect(hintDigitFor(8, 10)).toBeNull();
  });
  it("returns null outside the list and for an empty list", () => {
    expect(hintDigitFor(0, 0)).toBeNull();
    expect(hintDigitFor(5, 3)).toBeNull();
    expect(hintDigitFor(-1, 3)).toBeNull();
  });
});
