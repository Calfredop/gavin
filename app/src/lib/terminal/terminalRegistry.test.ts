import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A terminal is a DOM object and a daemon connection; neither exists under
// vitest, and neither is what these tests are about. What IS under test is the
// order the registry does things in: a repaint asked for before its listener
// exists is a repaint nobody receives.
const written: string[] = [];
let resolveListen: (() => void) | undefined;

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
    loadAddon() {}
    open() {}
    onData() {}
    registerLinkProvider() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  // Deliberately never resolved on its own: each test decides when the
  // listener becomes live, which is the whole point.
  listen: vi.fn(() => new Promise<() => void>((resolve) => {
    resolveListen = () => resolve(() => {});
  })),
}));
vi.mock("$lib/backend", () => ({
  writeInput: vi.fn().mockResolvedValue(undefined),
  snapshotSession: vi.fn().mockResolvedValue(undefined),
  viewableExtensions: vi.fn().mockResolvedValue([]),
  resolvePathUnderCursor: vi.fn().mockResolvedValue(null),
  openPathExternally: vi.fn().mockResolvedValue(undefined),
}));

import * as backend from "$lib/backend";
import {
  getOrCreateTerminal,
  restoreScreen,
  destroyTerminal,
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
