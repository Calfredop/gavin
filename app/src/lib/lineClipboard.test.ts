import { describe, it, expect, vi } from "vitest";
import {
  handleLineClipboard,
  lineBoundsAt,
  lineFieldFor,
  planLineClipboard,
  type LineClipboardEvent,
} from "./lineClipboard";

const TEXTAREA = { multiline: true, editable: true };
const INPUT = { multiline: false, editable: true };

describe("lineBoundsAt", () => {
  it("finds the line the caret sits in", () => {
    expect(lineBoundsAt("alpha\nbeta\ngamma", 7)).toEqual({ from: 6, to: 10 });
  });

  it("counts a caret at a line's end as that line, not the next", () => {
    expect(lineBoundsAt("alpha\nbeta", 5)).toEqual({ from: 0, to: 5 });
  });

  it("counts a caret at a line's start as that line", () => {
    expect(lineBoundsAt("alpha\nbeta", 6)).toEqual({ from: 6, to: 10 });
  });

  // lastIndexOf clamps a negative fromIndex to 0, so the naive
  // `lastIndexOf("\n", caret - 1) + 1` reports the leading break here and
  // hands back a `from` PAST the caret.
  it("keeps caret 0 on the empty first line of a value that starts with a break", () => {
    expect(lineBoundsAt("\nbeta", 0)).toEqual({ from: 0, to: 0 });
  });

  it("handles the last line, which has no break of its own", () => {
    expect(lineBoundsAt("alpha\nbeta", 8)).toEqual({ from: 6, to: 10 });
  });

  it("is defined on an empty value", () => {
    expect(lineBoundsAt("", 0)).toEqual({ from: 0, to: 0 });
  });

  it("clamps a caret past the end", () => {
    expect(lineBoundsAt("alpha", 99)).toEqual({ from: 0, to: 5 });
  });
});

describe("planLineClipboard — copy", () => {
  it("puts a textarea's line on the clipboard with its break", () => {
    expect(planLineClipboard("alpha\nbeta\ngamma", 7, "copy", TEXTAREA)).toEqual({
      text: "beta\n",
      remove: null,
    });
  });

  it("gives the last line a break too, so pasting it back makes a line", () => {
    expect(planLineClipboard("alpha\nbeta", 8, "copy", TEXTAREA)?.text).toBe("beta\n");
  });

  it("copies a single-line field WITHOUT a break", () => {
    // A trailing break here would turn a search box's contents into a
    // submitted command the moment it landed in a terminal.
    expect(planLineClipboard("main.rs", 3, "copy", INPUT)).toEqual({
      text: "main.rs",
      remove: null,
    });
  });

  it("copies a blank line in a textarea as a bare break", () => {
    expect(planLineClipboard("alpha\n\ngamma", 6, "copy", TEXTAREA)?.text).toBe("\n");
  });

  it("declines an empty single-line field rather than clobber the clipboard", () => {
    expect(planLineClipboard("", 0, "copy", INPUT)).toBeNull();
  });

  it("never removes anything on a copy, even when editable", () => {
    expect(planLineClipboard("alpha\nbeta", 2, "copy", TEXTAREA)?.remove).toBeNull();
  });
});

describe("planLineClipboard — cut", () => {
  it("takes the line and its own break, so no blank line is left", () => {
    expect(planLineClipboard("alpha\nbeta\ngamma", 7, "cut", TEXTAREA)).toEqual({
      text: "beta\n",
      remove: { from: 6, to: 11 },
    });
  });

  it("takes the PRECEDING break on the last line, which has none of its own", () => {
    const plan = planLineClipboard("alpha\nbeta", 8, "cut", TEXTAREA);
    expect(plan?.remove).toEqual({ from: 5, to: 10 });
    const value = "alpha\nbeta";
    expect(value.slice(0, 5) + value.slice(10)).toBe("alpha");
  });

  it("takes the whole value when it is the only line", () => {
    expect(planLineClipboard("alpha", 2, "cut", TEXTAREA)?.remove).toEqual({ from: 0, to: 5 });
  });

  it("clears a single-line field", () => {
    expect(planLineClipboard("main.rs", 3, "cut", INPUT)).toEqual({
      text: "main.rs",
      remove: { from: 0, to: 7 },
    });
  });

  it("degrades to a copy on a read-only field", () => {
    expect(planLineClipboard("alpha\nbeta", 7, "cut", { multiline: true, editable: false })).toEqual(
      { text: "beta\n", remove: null }
    );
  });

  it("removes a blank line together with its break", () => {
    expect(planLineClipboard("alpha\n\ngamma", 6, "cut", TEXTAREA)?.remove).toEqual({
      from: 6,
      to: 7,
    });
  });
});

describe("lineFieldFor", () => {
  it("takes a textarea as multiline", () => {
    expect(lineFieldFor({ tagName: "TEXTAREA" } as unknown as EventTarget)).toEqual({
      multiline: true,
      editable: true,
    });
  });

  it("takes a bare input, which is type text", () => {
    expect(lineFieldFor({ tagName: "INPUT" } as unknown as EventTarget)).toEqual({
      multiline: false,
      editable: true,
    });
  });

  it.each(["text", "search", "url", "tel"])("takes an input of type %s", (type) => {
    expect(lineFieldFor({ tagName: "INPUT", type } as unknown as EventTarget)).not.toBeNull();
  });

  // Reading selectionStart on these throws InvalidStateError, and the app
  // ships all three.
  it.each(["number", "color", "checkbox", "radio", "button", "submit", "password"])(
    "refuses an input of type %s",
    (type) => {
      expect(lineFieldFor({ tagName: "INPUT", type } as unknown as EventTarget)).toBeNull();
    }
  );

  it("marks a readonly field uneditable", () => {
    expect(lineFieldFor({ tagName: "TEXTAREA", readOnly: true } as unknown as EventTarget)).toEqual({
      multiline: true,
      editable: false,
    });
  });

  it("marks a disabled field uneditable", () => {
    expect(lineFieldFor({ tagName: "INPUT", disabled: true } as unknown as EventTarget)).toEqual({
      multiline: false,
      editable: false,
    });
  });

  it("leaves xterm's helper textarea to the terminal", () => {
    const target = { tagName: "TEXTAREA", closest: (s: string) => (s === ".xterm" ? {} : null) };
    expect(lineFieldFor(target as unknown as EventTarget)).toBeNull();
  });

  it("leaves a contenteditable to CodeMirror, which already does this", () => {
    const target = { tagName: "DIV", isContentEditable: true };
    expect(lineFieldFor(target as unknown as EventTarget)).toBeNull();
  });

  it("refuses a non-object target", () => {
    expect(lineFieldFor(null)).toBeNull();
    expect(lineFieldFor(undefined)).toBeNull();
  });
});

/// A field that behaves like a real one: setRangeText actually edits, and
/// setSelectionRange actually moves, so the handler's two removal routes
/// can be told apart by their effect rather than by a spy.
function field(value: string, caret: number, extra: Record<string, unknown> = {}) {
  const el = {
    tagName: "TEXTAREA",
    value,
    selectionStart: caret,
    selectionEnd: caret,
    events: [] as string[],
    setSelectionRange(start: number, end: number) {
      el.selectionStart = start;
      el.selectionEnd = end;
    },
    setRangeText(replacement: string, start: number, end: number) {
      el.value = el.value.slice(0, start) + replacement + el.value.slice(end);
      el.selectionStart = start + replacement.length;
      el.selectionEnd = el.selectionStart;
    },
    dispatchEvent(event: unknown) {
      el.events.push((event as { type: string }).type);
      return true;
    },
    ...extra,
  };
  return el;
}

function clipboardEvent(type: string, target: unknown): LineClipboardEvent & {
  written: string | null;
  prevented: boolean;
} {
  const event = {
    type,
    target: target as EventTarget,
    defaultPrevented: false,
    written: null as string | null,
    prevented: false,
    clipboardData: {
      setData(_format: string, data: string) {
        event.written = data;
      },
    },
    preventDefault() {
      event.prevented = true;
    },
  };
  return event;
}

describe("handleLineClipboard", () => {
  it("copies the caret's line and leaves the value alone", () => {
    const el = field("alpha\nbeta\ngamma", 7);
    const event = clipboardEvent("copy", el);
    expect(handleLineClipboard(event)).toBe(true);
    expect(event.written).toBe("beta\n");
    expect(event.prevented).toBe(true);
    expect(el.value).toBe("alpha\nbeta\ngamma");
    expect(el.events).toEqual([]);
  });

  it("cuts the line out and announces the edit, so bind:value follows", () => {
    const el = field("alpha\nbeta\ngamma", 7);
    const event = clipboardEvent("cut", el);
    expect(handleLineClipboard(event)).toBe(true);
    expect(event.written).toBe("beta\n");
    expect(el.value).toBe("alpha\ngamma");
    // execCommand is unavailable under node, so this is the fallback
    // route -- the one that has to fire `input` itself.
    expect(el.events).toEqual(["input"]);
  });

  it("leaves the caret at the start of the line that moved up", () => {
    const el = field("alpha\nbeta\ngamma", 7);
    handleLineClipboard(clipboardEvent("cut", el));
    expect(el.selectionStart).toBe(6);
    expect(el.value.slice(6)).toBe("gamma");
  });

  it("cut then paste restores the document exactly", () => {
    const el = field("alpha\nbeta\ngamma", 7);
    const event = clipboardEvent("cut", el);
    handleLineClipboard(event);
    const pasted = el.value.slice(0, 6) + event.written + el.value.slice(6);
    expect(pasted).toBe("alpha\nbeta\ngamma");
  });

  it("stands aside when there is a real selection", () => {
    const el = field("alpha\nbeta", 0, { selectionStart: 2, selectionEnd: 4 });
    const event = clipboardEvent("copy", el);
    expect(handleLineClipboard(event)).toBe(false);
    expect(event.prevented).toBe(false);
    expect(event.written).toBeNull();
  });

  it("stands aside once something nearer the target has answered", () => {
    const el = field("alpha\nbeta", 2);
    const event = clipboardEvent("copy", el);
    event.defaultPrevented = true;
    expect(handleLineClipboard(event)).toBe(false);
    expect(event.written).toBeNull();
  });

  it("stands aside on a paste", () => {
    const el = field("alpha\nbeta", 2);
    expect(handleLineClipboard(clipboardEvent("paste", el))).toBe(false);
  });

  it("stands aside on a field whose selection API is undefined", () => {
    const el = field("7", 0, { tagName: "INPUT", type: "number", selectionStart: null, selectionEnd: null });
    expect(handleLineClipboard(clipboardEvent("copy", el))).toBe(false);
  });

  it("copies but does not cut a read-only field", () => {
    const el = field("alpha\nbeta", 7, { readOnly: true });
    const event = clipboardEvent("cut", el);
    expect(handleLineClipboard(event)).toBe(true);
    expect(event.written).toBe("beta\n");
    expect(el.value).toBe("alpha\nbeta");
  });

  it("gives up rather than swallow the event when there is no clipboardData", () => {
    const el = field("alpha\nbeta", 7);
    const event = clipboardEvent("copy", el);
    event.clipboardData = null;
    expect(handleLineClipboard(event)).toBe(false);
    expect(event.prevented).toBe(false);
    expect(el.value).toBe("alpha\nbeta");
  });

  it("prefers execCommand, which keeps the field's own undo stack", () => {
    const el = field("alpha\nbeta\ngamma", 7);
    const exec = vi.fn(() => {
      el.value = el.value.slice(0, el.selectionStart) + el.value.slice(el.selectionEnd);
      return true;
    });
    vi.stubGlobal("document", { execCommand: exec });
    try {
      expect(handleLineClipboard(clipboardEvent("cut", el))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exec).toHaveBeenCalledWith("delete");
    expect(el.value).toBe("alpha\ngamma");
    // The native route fires `input` itself; a second one would make every
    // keystroke-counting listener double-count.
    expect(el.events).toEqual([]);
  });

  it("falls back when execCommand claims success but changes nothing", () => {
    const el = field("alpha\nbeta\ngamma", 7);
    vi.stubGlobal("document", { execCommand: () => true });
    try {
      expect(handleLineClipboard(clipboardEvent("cut", el))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(el.value).toBe("alpha\ngamma");
    expect(el.events).toEqual(["input"]);
  });

  it("falls back when execCommand throws", () => {
    const el = field("alpha\nbeta\ngamma", 7);
    vi.stubGlobal("document", {
      execCommand: () => {
        throw new Error("nope");
      },
    });
    try {
      handleLineClipboard(clipboardEvent("cut", el));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(el.value).toBe("alpha\ngamma");
    expect(el.events).toEqual(["input"]);
  });
});

// The whole feature hangs off one call in one file. Nothing else imports
// this module, so dropping that line would take the gesture out of the
// app with every test above still green -- the same failure shape
// autoCommitSurfaces.test.ts exists to pin.
describe("the listener is actually installed", () => {
  const PAGE = import.meta.glob("../routes/*.svelte", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  const source = PAGE["../routes/+page.svelte"];

  it("has a source to read", () => {
    expect(source).toBeTruthy();
  });

  it("imports and installs it alongside the other window listeners", () => {
    expect(source).toContain("installLineClipboard");
    expect(source).toContain("uninstallLineClipboard = installLineClipboard()");
  });

  it("tears it down with them", () => {
    expect(source).toContain("uninstallLineClipboard?.()");
  });
});
