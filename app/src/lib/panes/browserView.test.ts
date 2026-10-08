import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  chipFor,
  createBrowserViews,
  DEFAULT_PANE_OPEN,
  normalizePaneOpen,
  paneOpenFromSelect,
  paneOpenOptions,
  paneShows,
  RELEASE_GRACE_MS,
  resolvePaneOpen,
  type BrowserFrame,
  type BrowserInfo,
  type LiveBrowser,
  type PaneOpenSetting,
} from "$lib/panes/browserView";
import { searchSettings, type SettingsSection } from "$lib/core/settingsSearch";
import { source } from "$lib/sources";

const INFO: BrowserInfo = { url: "https://example.test/", title: "Example", tabs: 1 };

function frame(sessionId: string, seq: number, url = "https://example.test/"): BrowserFrame {
  return { sessionId, seq, data: `jpeg-${seq}`, width: 1280, height: 800, url, title: "Example" };
}

/// A manual clock: `later` queues, `tick` runs what is due.
function clock() {
  let now = 0;
  const queue: { at: number; fn: () => void }[] = [];
  return {
    later: (fn: () => void, ms: number) => void queue.push({ at: now + ms, fn }),
    tick(ms: number) {
      now += ms;
      const due = queue.filter((q) => q.at <= now);
      for (const q of due) queue.splice(queue.indexOf(q), 1);
      for (const q of due) q.fn();
    },
  };
}

/// The ports a window gives the module, every one a spy, with the
/// session's setting and daemon verdict set per test.
function harness(opts: { setting?: PaneOpenSetting | null; blocked?: string | null; live?: LiveBrowser[] } = {}) {
  const time = clock();
  const state = {
    setting: opts.setting === undefined ? ("auto" as PaneOpenSetting | null) : opts.setting,
    blocked: opts.blocked ?? null,
    live: opts.live ?? [],
  };
  const ports = {
    watch: vi.fn(async (_sessionId: string): Promise<BrowserFrame | null> => null),
    unwatch: vi.fn(async (_sessionId: string): Promise<void> => {}),
    listBrowsers: vi.fn(async (): Promise<LiveBrowser[]> => state.live),
    openSettingFor: vi.fn((_sessionId: string): PaneOpenSetting | null => state.setting),
    blockedReason: vi.fn((_sessionId: string): string | null => state.blocked),
    openPane: vi.fn(async (_sessionId: string, _focus: boolean): Promise<boolean> => true),
    later: time.later,
  };
  const views = createBrowserViews(ports);
  return { ports, views, state, tick: time.tick };
}

/// Lets the watch's promise settle.
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("the open setting", () => {
  it("reads only the two words it knows", () => {
    expect(normalizePaneOpen("auto")).toBe("auto");
    expect(normalizePaneOpen("chip")).toBe("chip");
    expect(normalizePaneOpen("always")).toBeNull();
    expect(normalizePaneOpen(undefined)).toBeNull();
    expect(normalizePaneOpen(1)).toBeNull();
  });

  it("is the workspace's when it has one, in both directions", () => {
    expect(resolvePaneOpen("chip", "auto")).toBe("chip");
    expect(resolvePaneOpen("auto", "chip")).toBe("auto");
  });

  it("inherits the app value when the workspace has none", () => {
    expect(resolvePaneOpen(undefined, "chip")).toBe("chip");
    expect(resolvePaneOpen(undefined, "auto")).toBe("auto");
    // A hand-edited word the app does not know reads as no setting.
    expect(resolvePaneOpen("sometimes", "chip")).toBe("chip");
  });

  it("falls through to opening automatically when nobody chose", () => {
    expect(DEFAULT_PANE_OPEN).toBe("auto");
    expect(resolvePaneOpen(undefined, null)).toBe("auto");
  });

  it("names what Default means in the picker's first row", () => {
    expect(paneOpenOptions("chip")).toEqual([
      { value: "", label: "Default (Open from the tab chip)" },
      { value: "auto", label: "Open automatically" },
      { value: "chip", label: "Open from the tab chip" },
    ]);
    expect(paneOpenFromSelect("")).toBeNull();
    expect(paneOpenFromSelect("chip")).toBe("chip");
  });
});

describe("opening the pane", () => {
  it("auto-opens beside the tab on the first frame, and never again on later ones", async () => {
    const { ports, views } = harness({ setting: "auto" });

    views.changed("s1", INFO);
    // The browser launched: the module subscribes ahead of its first frame.
    expect(ports.watch).toHaveBeenCalledWith("s1");
    expect(ports.openPane).not.toHaveBeenCalled();

    views.frame(frame("s1", 1));
    expect(ports.openPane).toHaveBeenCalledTimes(1);
    expect(ports.openPane).toHaveBeenCalledWith("s1", false);

    views.frame(frame("s1", 2));
    views.changed("s1", { ...INFO, url: "https://example.test/next" });
    views.frame(frame("s1", 3));
    expect(ports.openPane).toHaveBeenCalledTimes(1);
    expect(get(views.views).s1.frame?.seq).toBe(3);
  });

  it("with the chip setting opens no pane and lights the chip", () => {
    const { ports, views } = harness({ setting: "chip" });

    views.changed("s1", INFO);
    views.frame(frame("s1", 1));

    expect(ports.openPane).not.toHaveBeenCalled();
    // Nobody is looking, so nothing is streamed either.
    expect(ports.watch).not.toHaveBeenCalled();
    expect(chipFor(get(views.views).s1, null)).not.toBeNull();
  });

  it("asks the setting again when the frame lands", () => {
    // Moved to the chip between the launch and the first frame: the
    // human's latest word wins.
    const { ports, views, state } = harness({ setting: "auto" });
    views.changed("s1", INFO);
    state.setting = "chip";

    views.frame(frame("s1", 1));

    expect(ports.openPane).not.toHaveBeenCalled();
  });

  it("does not open a pane in a window that shows no workspace holding the session", () => {
    const { ports, views } = harness({ setting: null });
    views.changed("s1", INFO);
    views.frame(frame("s1", 1));
    expect(ports.watch).not.toHaveBeenCalled();
    expect(ports.openPane).not.toHaveBeenCalled();
  });

  it("does not pop a pane for a browser that was already running when the window loaded", async () => {
    const { ports, views } = harness({ setting: "auto", live: [{ sessionId: "s1", browser: INFO }] });

    await views.seed();
    views.changed("s1", { ...INFO, url: "https://example.test/next" });
    views.frame(frame("s1", 1));

    expect(ports.openPane).not.toHaveBeenCalled();
    expect(chipFor(get(views.views).s1, null)).not.toBeNull();
  });

  it("re-arms for a browser that stopped before it ever drew a frame", () => {
    const { ports, views, tick } = harness({ setting: "auto" });
    views.changed("s1", INFO);
    views.changed("s1", null);
    tick(RELEASE_GRACE_MS);
    expect(ports.unwatch).toHaveBeenCalledWith("s1");

    views.changed("s1", INFO);
    views.frame(frame("s1", 1));
    expect(ports.openPane).toHaveBeenCalledTimes(1);
  });
});

describe("hide and reopen", () => {
  it("lets go of the stream once the pane is hidden, and the chip brings it back", async () => {
    const { ports, views, tick } = harness({ setting: "auto" });
    views.changed("s1", INFO);
    views.frame(frame("s1", 1));
    // The pane the first frame opened mounts and takes over the stream.
    const release = views.attach("s1");
    tick(RELEASE_GRACE_MS);
    expect(ports.unwatch).not.toHaveBeenCalled();

    // Closing the pane only hides it: the browser and its chip stay.
    release();
    tick(RELEASE_GRACE_MS);
    expect(ports.unwatch).toHaveBeenCalledWith("s1");
    expect(chipFor(get(views.views).s1, null)).not.toBeNull();

    ports.watch.mockClear();
    await views.openFromChip("s1");
    expect(ports.openPane).toHaveBeenLastCalledWith("s1", true);
    views.attach("s1");
    expect(ports.watch).toHaveBeenCalledWith("s1");
    // Reopening is not a first frame: no auto-open follows it.
    views.frame(frame("s1", 2));
    expect(ports.openPane).toHaveBeenCalledTimes(2);
  });

  it("keeps the stream through a quick hide and show", () => {
    const { ports, views, tick } = harness({ setting: "chip" });
    views.changed("s1", INFO);
    const release = views.attach("s1");
    expect(ports.watch).toHaveBeenCalledTimes(1);

    release();
    tick(RELEASE_GRACE_MS / 2);
    views.attach("s1");
    tick(RELEASE_GRACE_MS * 2);

    expect(ports.unwatch).not.toHaveBeenCalled();
    expect(ports.watch).toHaveBeenCalledTimes(1);
  });

  it("draws the frame the host already holds when a pane mounts on a running stream", async () => {
    const { ports, views } = harness({ setting: "chip" });
    ports.watch.mockResolvedValueOnce(frame("s1", 7));
    views.changed("s1", INFO);

    views.attach("s1");
    await settle();

    expect(get(views.views).s1.frame?.seq).toBe(7);
  });

  it("drops what a superseded watch resolves with", async () => {
    // Shown, hidden past the grace, and shown again: the first watch's
    // late answer must not land over the second's.
    const { ports, views, tick } = harness({ setting: "chip" });
    let first!: (f: BrowserFrame | null) => void;
    ports.watch.mockImplementationOnce(() => new Promise((resolve) => (first = resolve)));
    views.changed("s1", INFO);
    const release = views.attach("s1");
    release();
    tick(RELEASE_GRACE_MS);
    ports.watch.mockResolvedValueOnce(frame("s1", 9));
    views.attach("s1");
    await settle();

    first(frame("s1", 3));
    await settle();

    expect(get(views.views).s1.frame?.seq).toBe(9);
  });
});

describe("teardown", () => {
  it("forgets the session when it ends, and ignores anything after", async () => {
    const { ports, views } = harness({ setting: "auto" });
    views.changed("s1", INFO);
    views.frame(frame("s1", 1));
    views.attach("s1");

    views.ended("s1");

    expect(ports.unwatch).toHaveBeenCalledWith("s1");
    expect(get(views.views).s1).toBeUndefined();
    views.frame(frame("s1", 2));
    views.changed("s1", INFO);
    expect(get(views.views).s1).toBeUndefined();
    expect(ports.openPane).toHaveBeenCalledTimes(1);
  });

  it("a pane released after its session ended asks nothing of the host", () => {
    const { ports, views, tick } = harness({ setting: "chip" });
    views.changed("s1", INFO);
    const release = views.attach("s1");
    views.ended("s1");
    ports.unwatch.mockClear();

    release();
    tick(RELEASE_GRACE_MS);

    expect(ports.unwatch).not.toHaveBeenCalled();
  });

  it("a browser that stops leaves the last frame up, marked stopped", () => {
    const { views } = harness({ setting: "chip" });
    views.changed("s1", INFO);
    views.attach("s1");
    views.frame(frame("s1", 1));

    views.changed("s1", null);

    const shows = paneShows(get(views.views).s1, null);
    expect(shows).toMatchObject({ kind: "frame", stopped: true });
    expect(chipFor(get(views.views).s1, null)).toBeNull();
  });
});

describe("an older daemon", () => {
  const BLOCKED = "Needs daemon v65; the running daemon is v64. Restart the daemon to enable this.";

  it("is never asked for a stream, and no pane opens", () => {
    const { ports, views } = harness({ setting: "auto", blocked: BLOCKED });
    views.changed("s1", INFO);
    views.attach("s1");
    views.frame(frame("s1", 1));
    expect(ports.watch).not.toHaveBeenCalled();
    expect(ports.openPane).not.toHaveBeenCalled();
  });

  it("puts the reason where the view would be, and draws no chip", () => {
    expect(paneShows(undefined, BLOCKED)).toEqual({ kind: "blocked", reason: BLOCKED });
    expect(chipFor({ info: INFO, frame: null }, BLOCKED)).toBeNull();
  });
});

describe("the read-back", () => {
  it("lights the chip of every browser the daemons list, and turns off the rest", async () => {
    const { views, state } = harness({ setting: "chip" });
    views.changed("gone", INFO);
    state.live = [{ sessionId: "s1", browser: INFO }];

    await views.seed();

    expect(chipFor(get(views.views).s1, null)).not.toBeNull();
    expect(chipFor(get(views.views).gone, null)).toBeNull();
  });

  it("does not overwrite a change that arrived while it was in flight", async () => {
    const { ports, views } = harness({ setting: "chip" });
    let answer!: (list: LiveBrowser[]) => void;
    ports.listBrowsers.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));

    const seeding = views.seed();
    views.changed("s1", INFO);
    answer([]);
    await seeding;

    expect(chipFor(get(views.views).s1, null)).not.toBeNull();
  });

  it("asks again for every stream still wanted once a link is back", () => {
    const { ports, views } = harness({ setting: "chip" });
    views.changed("s1", INFO);
    views.changed("s2", INFO);
    views.attach("s1");
    ports.watch.mockClear();

    views.reassert();

    expect(ports.watch).toHaveBeenCalledTimes(1);
    expect(ports.watch).toHaveBeenCalledWith("s1");
  });
});

describe("what the pane shows", () => {
  it("waits for a running browser's first frame", () => {
    expect(paneShows({ info: INFO, frame: null }, null)).toEqual({ kind: "waiting" });
  });

  it("says so when no browser is running", () => {
    expect(paneShows(undefined, null)).toEqual({ kind: "idle" });
  });

  it("shows the newest frame and the page it is of", () => {
    const shows = paneShows({ info: INFO, frame: frame("s1", 4, "https://example.test/now") }, null);
    expect(shows).toMatchObject({ kind: "frame", stopped: false, url: "https://example.test/now" });
  });

  it("names the page and the tab count on the chip", () => {
    expect(chipFor({ info: { ...INFO, tabs: 2 }, frame: null }, null)?.tip).toBe(
      "Show this agent's browser · Example · 2 tabs"
    );
    expect(chipFor({ info: { url: "about:blank", title: "", tabs: 1 }, frame: null }, null)?.tip).toBe(
      "Show this agent's browser · about:blank"
    );
  });
});

// "Settings search must find the setting": the two panels' SECTIONS
// entries, read from their source like settingsSearchSurfaces does, run
// through the real matcher.
describe("settings search finds the setting", () => {
  function browserSection(file: string): SettingsSection {
    const text = source(file);
    const entry = text.match(/\{\s*id: "browser",\s*keywords: (\[[\s\S]*?\]),?\s*\}/);
    expect(entry, `${file} has no "browser" section`).not.toBeNull();
    return { id: "browser", keywords: JSON.parse((entry as RegExpMatchArray)[1].replace(/,\s*\]$/, "]")) };
  }

  it.each(["GlobalSettingsView.svelte", "SettingsHubView.svelte"])("in %s", (file) => {
    const sections = [browserSection(file)];
    for (const query of ["playwright", "browser", "open automatically", "tab chip", "live view"]) {
      expect(searchSettings(sections, query).visible("browser"), query).toBe(true);
    }
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
