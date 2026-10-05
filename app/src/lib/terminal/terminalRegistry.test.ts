import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A terminal is a DOM object and a daemon connection; neither exists under
// vitest, and neither is what these tests are about. What IS under test is the
// order the registry does things in: a repaint asked for before its listener
// exists is a repaint nobody receives.
const written: string[] = [];
let resolveListen: (() => void) | undefined;
// The OSC handlers the last terminal built registered, by identifier.
const oscHandlers = new Map<number, (payload: string) => boolean>();
// What the last terminal built does with its own typing.
let typed: ((data: string) => void) | undefined;

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      // Kept rather than discarded: the size a terminal is BORN at is the
      // half of the font-size story a later setter cannot fix.
      this.options = { ...options };
    }
    write(data: string) {
      written.push(data);
    }
    parser = {
      registerOscHandler(ident: number, handler: (payload: string) => boolean) {
        oscHandlers.set(ident, handler);
      },
    };
    loadAddon() {}
    open() {}
    onData(handler: (data: string) => void) {
      typed = handler;
    }
    registerLinkProvider() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  // Deliberately never resolved on its own: each test decides when the
  // listener becomes live, which is the whole point.
  listen: vi.fn(() => new Promise<() => void>((resolve) => {
    resolveListen = () => resolve(() => {});
  })),
}));
vi.mock("$lib/core/backend", () => ({
  writeInput: vi.fn().mockResolvedValue(undefined),
  snapshotSession: vi.fn().mockResolvedValue(undefined),
  viewableExtensions: vi.fn().mockResolvedValue([]),
  resolvePathUnderCursor: vi.fn().mockResolvedValue(null),
  openPathExternally: vi.fn().mockResolvedValue(undefined),
}));

import * as backend from "$lib/core/backend";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  getOrCreateTerminal,
  restoreScreen,
  destroyTerminal,
  setInputTransform,
  setTerminalFontSize,
} from "$lib/terminal/terminalRegistry";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("restoring a terminal's screen", () => {
  beforeEach(() => {
    written.length = 0;
    resolveListen = undefined;
    vi.mocked(backend.snapshotSession).mockClear();
    vi.stubGlobal("document", { createElement: () => ({ style: {} }) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not ask for a repaint until the listener that would receive it exists", async () => {
    getOrCreateTerminal("s1", 13);
    const restoring = restoreScreen("s1");
    await flush();
    expect(backend.snapshotSession).not.toHaveBeenCalled();

    resolveListen?.();
    await restoring;
    expect(backend.snapshotSession).toHaveBeenCalledWith("s1");
    destroyTerminal("s1");
  });

  it("repaints a session once per frontend load, however many panes mount it", async () => {
    getOrCreateTerminal("s2", 13);
    resolveListen?.();
    await restoreScreen("s2");
    // A pane remounting (a tree-shape change elsewhere) re-runs onMount
    // against the SAME terminal, which is already correct.
    await restoreScreen("s2");
    await restoreScreen("s2");
    expect(backend.snapshotSession).toHaveBeenCalledTimes(1);
    destroyTerminal("s2");
  });

  it("leaves the terminal alone when the daemon refuses the request", async () => {
    vi.mocked(backend.snapshotSession).mockRejectedValueOnce(new Error("too old"));
    getOrCreateTerminal("s3", 13);
    resolveListen?.();
    await expect(restoreScreen("s3")).resolves.toBeUndefined();
    expect(written).toEqual([]);
    destroyTerminal("s3");
  });

  it("repaints again for a session id that was torn down and rebuilt", async () => {
    getOrCreateTerminal("s4", 13);
    resolveListen?.();
    await restoreScreen("s4");
    destroyTerminal("s4");

    getOrCreateTerminal("s4", 13);
    resolveListen?.();
    await restoreScreen("s4");
    expect(backend.snapshotSession).toHaveBeenCalledTimes(2);
    destroyTerminal("s4");
  });
});

describe("terminal font size", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { createElement: () => ({ style: {} }) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a terminal at the size it was given", () => {
    expect(getOrCreateTerminal("f1", 11).term.options.fontSize).toBe(11);
    destroyTerminal("f1");
  });

  it("moves a live terminal and says a refit is owed", () => {
    const entry = getOrCreateTerminal("f2", 13);
    expect(setTerminalFontSize("f2", 16)).toBe(true);
    expect(entry.term.options.fontSize).toBe(16);
    destroyTerminal("f2");
  });

  it("reports no change when the size is already right", () => {
    // The pane refits on `true` alone, and a refit costs a resize request
    // to the daemon -- so "no change" has to be distinguishable from a
    // change, not merely harmless.
    getOrCreateTerminal("f3", 13);
    expect(setTerminalFontSize("f3", 13)).toBe(false);
    destroyTerminal("f3");
  });

  it("does nothing for a session with no terminal", () => {
    expect(setTerminalFontSize("nobody", 13)).toBe(false);
  });
});

describe("a program copying through the terminal (OSC 52)", () => {
  const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

  beforeEach(() => {
    oscHandlers.clear();
    vi.mocked(writeText).mockClear();
    vi.stubGlobal("document", { createElement: () => ({ style: {} }) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("puts what the program copied on the clipboard", () => {
    getOrCreateTerminal("o1", 13);
    // Claude Code over SSH has no pbcopy on the far side: this is its copy.
    expect(oscHandlers.get(52)?.(`c;${b64("copied over ssh")}`)).toBe(true);
    expect(writeText).toHaveBeenCalledWith("copied over ssh");
    destroyTerminal("o1");
  });

  it("claims a query without answering it or touching the clipboard", () => {
    getOrCreateTerminal("o2", 13);
    expect(oscHandlers.get(52)?.("c;?")).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    destroyTerminal("o2");
  });

  it("survives a clipboard that refuses the write", async () => {
    vi.mocked(writeText).mockRejectedValueOnce("no clipboard here");
    getOrCreateTerminal("o3", 13);
    expect(oscHandlers.get(52)?.(`c;${b64("x")}`)).toBe(true);
    await flush();
    destroyTerminal("o3");
  });
});

describe("what a terminal's typing sends", () => {
  let release: (() => void) | null = null;
  beforeEach(() => {
    vi.mocked(backend.writeInput).mockClear();
    vi.stubGlobal("document", { createElement: () => ({ style: {} }) });
  });
  afterEach(() => {
    release?.();
    release = null;
    vi.unstubAllGlobals();
  });

  it("is what was typed, where nothing has asked to see it first", () => {
    getOrCreateTerminal("t1", 13);
    typed?.("ls\r");
    expect(backend.writeInput).toHaveBeenCalledWith("t1", "ls\r");
    destroyTerminal("t1");
  });

  it("goes through a transform where one is set, told whose terminal it is", () => {
    // The Companion's latched Ctrl: the next character becomes its
    // control code before it leaves.
    const transform = vi.fn((_id: string, data: string) => (data === "c" ? "\x03" : data));
    release = setInputTransform(transform);
    getOrCreateTerminal("t2", 13);
    typed?.("c");
    expect(transform).toHaveBeenCalledWith("t2", "c");
    expect(backend.writeInput).toHaveBeenCalledWith("t2", "\x03");
    destroyTerminal("t2");
  });

  it("reaches a terminal built before the transform was set", () => {
    getOrCreateTerminal("t3", 13);
    const sendKeysOf = typed;
    release = setInputTransform(() => "rewritten");
    sendKeysOf?.("x");
    expect(backend.writeInput).toHaveBeenCalledWith("t3", "rewritten");
    destroyTerminal("t3");
  });

  it("goes back to what was typed once released, and a stale release takes nothing away", () => {
    getOrCreateTerminal("t4", 13);
    const first = setInputTransform(() => "first");
    release = setInputTransform(() => "second");
    // The surface that set the first is torn down after the second
    // mounted: the second stays.
    first();
    typed?.("x");
    expect(backend.writeInput).toHaveBeenLastCalledWith("t4", "second");
    release();
    release = null;
    typed?.("x");
    expect(backend.writeInput).toHaveBeenLastCalledWith("t4", "x");
    destroyTerminal("t4");
  });
});
