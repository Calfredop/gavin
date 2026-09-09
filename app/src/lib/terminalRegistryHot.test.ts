import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The failure this file guards against is invisible to every other suite.
// `import.meta.hot` is undefined under vitest (and in the bundled app), so
// the real `hotState` always builds fresh state and terminalRegistry can
// never be caught losing any -- which is exactly how the black terminals
// shipped green in the first place.
//
// What CAN be staged is the half that matters: a SECOND execution of the
// module against the bag the first one filled. `vi.resetModules()` supplies
// the second execution; the `./hotState` mock below supplies the surviving
// bag, standing in for `import.meta.hot.data`.
//
// So this is a contract test, not a test of `hotState` itself (see
// hotState.test.ts): it fails the moment any of this module's live state
// goes back to a module-level `const`/`let`, whatever else stays green.
const hot = vi.hoisted(() => ({
  bag: {} as Record<string, unknown>,
  // Counted here rather than off the mocks: `vi.resetModules()` re-runs every
  // mock factory, so each execution gets brand-new `vi.fn()`s and their call
  // counts start over -- which is the one thing we must see ACROSS the two.
  listens: 0,
  snapshots: [] as string[],
}));

vi.mock("$lib/hotState", () => ({
  hotState: (key: string, fresh: () => unknown) => {
    if (!(key in hot.bag)) hot.bag[key] = fresh();
    return hot.bag[key];
  },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown>;
    // Records what it was constructed with, unlike the other suite's stub:
    // a terminal built after the reload must start in the theme the app is
    // actually using, and the constructor is where that is decided.
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
    }
    loadAddon() {}
    open() {}
    onData() {}
    registerLinkProvider() {}
    write() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => {
    hot.listens += 1;
    return () => {};
  }),
}));
vi.mock("$lib/ui/terminalTheme", () => ({ xtermTheme: (theme: string) => ({ theme }) }));
vi.mock("$lib/backend", () => ({
  writeInput: vi.fn().mockResolvedValue(undefined),
  snapshotSession: vi.fn(async (sessionId: string) => {
    hot.snapshots.push(sessionId);
  }),
  viewableExtensions: vi.fn().mockResolvedValue([]),
  resolvePathUnderCursor: vi.fn().mockResolvedValue(null),
  openPathExternally: vi.fn().mockResolvedValue(undefined),
}));

type Registry = typeof import("$lib/terminalRegistry");

/// One execution of terminalRegistry.ts, as Vite produces when an edit
/// anywhere in its dependency cone invalidates it.
async function execute(): Promise<Registry> {
  vi.resetModules();
  return import("$lib/terminalRegistry");
}

describe("terminalRegistry across a hot reload", () => {
  beforeEach(() => {
    hot.listens = 0;
    hot.snapshots.length = 0;
    vi.stubGlobal("document", { createElement: () => ({ style: {} }) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hands the re-executed module the terminal the first one built", async () => {
    const before = await execute();
    const entry = before.getOrCreateTerminal("s1", 13);

    const after = await execute();

    // Same entry means same Terminal and same container element, so the
    // remounted pane re-appends the node it already had, scrollback and all.
    // A fresh entry here IS the black terminal.
    expect(after.getOrCreateTerminal("s1", 13)).toBe(entry);
    expect(after.getTerminal("s1")).toBe(entry.term);
    after.destroyTerminal("s1");
  });

  it("does not register a second pty-output listener for a session it already has", async () => {
    const before = await execute();
    before.getOrCreateTerminal("s2", 13);
    expect(hot.listens).toBe(1);

    const after = await execute();
    after.getOrCreateTerminal("s2", 13);

    // Every extra listener is a permanent duplicate: nothing unlistens it
    // until the session dies, and each one writes the same bytes again.
    expect(hot.listens).toBe(1);
    after.destroyTerminal("s2");
  });

  it("keeps the theme, so a terminal created after the reload is not dark again", async () => {
    const before = await execute();
    before.applyTerminalTheme("light");

    const after = await execute();

    // The theme lives beside the terminals for this reason: it is applied
    // once, by bootstrap, and a module-level `let` reverts it to the "dark"
    // initialiser on every reload with nothing to set it right again.
    expect(after.getOrCreateTerminal("s3", 13).term.options.theme).toEqual({ theme: "light" });
    after.destroyTerminal("s3");
  });

  it("does not re-ask the daemon for a screen the surviving terminal still shows", async () => {
    const before = await execute();
    before.getOrCreateTerminal("s4", 13);
    await before.restoreScreen("s4");
    expect(hot.snapshots).toEqual(["s4"]);

    const after = await execute();
    await after.restoreScreen("s4");

    // The repaint is for a terminal that lost its contents. This one did not,
    // and a snapshot would only overwrite live scrollback with 500 rows.
    expect(hot.snapshots).toEqual(["s4"]);
    after.destroyTerminal("s4");
  });

  it("still starts clean when a real page load leaves nothing to adopt", async () => {
    const before = await execute();
    const entry = before.getOrCreateTerminal("s5", 13);
    // A reload gets a fresh realm and an empty bag -- which the real
    // `hotState` also produces from an undefined `data`. The terminal is
    // genuinely gone then, and restoreScreen is what covers it.
    for (const key of Object.keys(hot.bag)) delete hot.bag[key];

    const after = await execute();

    expect(after.getOrCreateTerminal("s5", 13)).not.toBe(entry);
    await after.restoreScreen("s5");
    expect(hot.snapshots).toEqual(["s5"]);
    after.destroyTerminal("s5");
  });
});
