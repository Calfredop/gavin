// Seam 2 for an agent's browser on the phone (`playwright-companion-view.md`):
// the bundle's own way in and the phone's view state (state/browser.ts,
// over the desk's `browserView.ts`) on one end of the channel, the Demo
// Workstation -- whose field-notes agent drives a browser -- on the other,
// and the wire read between.
//
// What it holds: the view is one tap from the session and never opens on
// its own; only a view on screen costs the desk a stream, which is the
// phone's own small one, asked of the desk and held by a lease the phone
// renews; and frames are listened for only while something is watched.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { layoutState } from "$lib/core/layoutState";
import type { Workspace } from "$lib/core/workspace";
import { RELEASE_GRACE_MS, type BrowserFrame } from "$lib/panes/browserView";
import { loopback } from "$companion/channel/port";
import { BROWSING_SESSION, DEMO_LEASE_MS } from "$companion/demo/browser";
import { NOTE_OFFLINE_EDIT, NOTES_HOME } from "$companion/demo/browserFrames";
import { createDemoWorkstation, type DemoWorkstation } from "$companion/demo/workstation";
import { disconnectChannel } from "$companion/remote/connection";
import {
  attachBrowser,
  BROWSER_FRAME_EVENT,
  browserProblems,
  browserShown,
  browserViews,
  hideBrowser,
  phoneBrowserBlocked,
  showBrowser,
} from "$companion/state/browser";
import { endSession } from "$companion/state/sessions";
import { connectWorkstation, openTerminal, view } from "$companion/state/workstation";
import { browserButton, browserViewShows } from "$companion/surfaces/phoneBrowser";
import { codeOf, companionSources } from "$companion/testing/companionSources";
import { settle } from "$companion/testing/demoBench";
import { deviceStorage, resetDesktopStores } from "$companion/testing/desktopStores";
import { allowedToRemoteRole } from "$companion/testing/remoteTable";
import { argsOf, mark, traffic } from "$companion/testing/wire";

const SESSION = BROWSING_SESSION;

let disconnect: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  disconnect?.();
  disconnect = null;
  disconnectChannel();
  resetDesktopStores();
  vi.useRealTimers();
});

async function visit(): Promise<DemoWorkstation> {
  const demo = createDemoWorkstation();
  disconnect = await connectWorkstation(loopback(demo), deviceStorage());
  await settle();
  return demo;
}

/// What the phone's view shows, as its template reads it.
function shown(sessionId = SESSION) {
  return browserViewShows(get(browserViews)[sessionId], phoneBrowserBlocked(get(layoutState).workspaces, null, sessionId), get(browserProblems)[sessionId] ?? null);
}

/// The human taps the terminal's browser button, and the view it opens
/// comes on screen. Returns the view's release.
async function tapOpen(sessionId = SESSION): Promise<() => void> {
  await showBrowser(sessionId);
  expect(get(browserShown)).toBe(sessionId);
  const release = attachBrowser(sessionId);
  await settle();
  return release;
}

/// The view leaves the screen, and the grace runs out.
async function tapClose(release: () => void, sessionId = SESSION): Promise<void> {
  hideBrowser(sessionId);
  release();
  vi.advanceTimersByTime(RELEASE_GRACE_MS);
  await settle();
}

const watchesSent = (demo: DemoWorkstation, from = 0) => argsOf(demo, "watch_browser_for_device", from);

describe("the browser's button beside the terminal", () => {
  it("is lit by the read-back of the browsers already running, and costs no stream", async () => {
    const demo = await visit();
    expect(traffic(demo)).toContain("invoke list_browsers");
    expect(get(browserViews)[SESSION]?.info?.url).toBe("http://localhost:5173/");
    expect(browserButton(get(browserViews)[SESSION], false)).toEqual({
      label: "Show this agent's browser · Field Notes",
      pressed: false,
    });
    // Nobody looked: no stream, no frames listened for.
    expect(watchesSent(demo)).toEqual([]);
    expect(demo.listening(BROWSER_FRAME_EVENT)).toBe(0);
  });

  it("is not drawn for an agent with no browser", async () => {
    await visit();
    expect(browserButton(get(browserViews)["s-atlas-auth"], false)).toBeNull();
  });

  it("follows the agent from page to page while nobody watches, still without a stream", async () => {
    const demo = await visit();
    demo.advance();
    await settle();
    expect(get(browserViews)[SESSION]?.info?.title).toBe("Gull colony, north cliff — Field Notes");
    expect(watchesSent(demo)).toEqual([]);
  });
});

describe("the view, never on its own", () => {
  it("does not open when a browser launches, nor on its frames, whatever the desk's setting", async () => {
    const demo = await visit();
    demo.state.settings.playwrightPaneOpen = "auto";
    openTerminal(SESSION);
    const at = mark(demo);

    // A browser launching for another agent, and frames arriving for it.
    demo.emit("browser-changed", ["s-atlas-auth", { url: "http://localhost:3000/", title: "Atlas", tabs: 1 }]);
    await settle();
    demo.emit(BROWSER_FRAME_EVENT, {
      sessionId: "s-atlas-auth",
      seq: 1,
      data: NOTES_HOME,
      width: 1280,
      height: 800,
      url: "http://localhost:3000/",
      title: "Atlas",
    } satisfies BrowserFrame);
    demo.advance();
    await settle();

    expect(get(browserShown)).toBeNull();
    expect(get(view).sessionId).toBe(SESSION);
    // The desk would have armed its pane and watched ahead; the phone asks
    // for no stream, and reads no setting to decide it.
    expect(watchesSent(demo, at)).toEqual([]);
    expect(traffic(demo, at)).not.toContain("listen browser-frame");
    expect(demo.commands()).not.toContain("get_playwright_pane_open");
  });
});

describe("the view on screen", () => {
  it("listens for frames, then asks the desk for the phone's stream, and draws the first frame", async () => {
    const demo = await visit();
    const at = mark(demo);
    const release = await tapOpen();

    expect(traffic(demo, at)).toEqual(["listen browser-frame", "invoke watch_browser_for_device"]);
    const [asked] = watchesSent(demo, at);
    expect(asked.sessionId).toBe(SESSION);
    expect(typeof asked.watcher).toBe("string");
    const now = shown();
    expect(now.kind).toBe("frame");
    expect(now.kind === "frame" && now.frame.data).toBe(NOTES_HOME);
    release();
  });

  it("draws the agent's next page as it reaches the desk", async () => {
    const demo = await visit();
    const release = await tapOpen();
    demo.advance();
    await settle();
    const now = shown();
    expect(now.kind === "frame" && now.frame.data).toBe(NOTE_OFFLINE_EDIT);
    expect(now.kind === "frame" && now.url).toBe("http://localhost:5173/notes/gull-colony");
    release();
  });

  it("renews its lease while it stays up, at a third of what the desk says it lasts", async () => {
    const demo = await visit();
    const release = await tapOpen();
    const at = mark(demo);
    const watcher = watchesSent(demo)[0].watcher;

    vi.advanceTimersByTime(DEMO_LEASE_MS / 3);
    await settle();
    expect(watchesSent(demo, at)).toEqual([{ sessionId: SESSION, watcher }]);
    vi.advanceTimersByTime(DEMO_LEASE_MS / 3);
    await settle();
    expect(watchesSent(demo, at)).toHaveLength(2);
    release();
  });

  it("lets the stream go once it has been off the screen for the grace, and stops listening", async () => {
    const demo = await visit();
    const release = await tapOpen();
    const watcher = watchesSent(demo)[0].watcher;
    const at = mark(demo);

    await tapClose(release);
    expect(argsOf(demo, "unwatch_browser_for_device", at)).toEqual([{ sessionId: SESSION, watcher }]);
    expect(traffic(demo, at)).toContain("unlisten");
    expect(demo.listening(BROWSER_FRAME_EVENT)).toBe(0);
    expect(demo.state.browsers[SESSION].watchers).toEqual([]);

    // And renews nothing after.
    const after = mark(demo);
    vi.advanceTimersByTime(DEMO_LEASE_MS);
    await settle();
    expect(watchesSent(demo, after)).toEqual([]);
  });

  it("keeps the stream it has through a view closed and opened again inside the grace", async () => {
    const demo = await visit();
    const first = await tapOpen();
    hideBrowser(SESSION);
    first();
    vi.advanceTimersByTime(RELEASE_GRACE_MS / 2);
    const second = await tapOpen();
    vi.advanceTimersByTime(RELEASE_GRACE_MS);
    await settle();
    expect(argsOf(demo, "unwatch_browser_for_device")).toEqual([]);
    expect(watchesSent(demo)).toHaveLength(1);
    second();
  });

  it("keeps only the frames of what it watches", async () => {
    const demo = await visit();
    const release = await tapOpen();
    demo.emit(BROWSER_FRAME_EVENT, {
      sessionId: "s-atlas-auth",
      seq: 1,
      data: NOTES_HOME,
      width: 1280,
      height: 800,
      url: "http://localhost:3000/",
      title: "Another phone's",
    } satisfies BrowserFrame);
    await settle();
    expect(get(browserViews)["s-atlas-auth"]).toBeUndefined();
    release();
  });

  it("asks again when the connection comes back, since the desk may have let the lease run out", async () => {
    const demo = await visit();
    const release = await tapOpen();
    demo.reach({ state: "down", reason: "unreachable" });
    await settle();
    const at = mark(demo);
    demo.reach({ state: "up" });
    await settle();
    expect(watchesSent(demo, at)).toHaveLength(1);
    expect(traffic(demo, at)).toContain("invoke list_browsers");
    release();
  });

  it("says why when the desk will not stream, and asks again while it stays up", async () => {
    const demo = await visit();
    demo.unavailable = "desktop app not running";
    const release = await tapOpen();
    expect(shown()).toEqual({ kind: "blocked", reason: "desktop app not running" });

    demo.unavailable = null;
    vi.advanceTimersByTime(5000);
    await settle();
    expect(shown().kind).toBe("frame");
    expect(get(browserProblems)[SESSION]).toBeUndefined();
    release();
  });

  it("goes with its session", async () => {
    const demo = await visit();
    openTerminal(SESSION);
    const release = await tapOpen();
    const at = mark(demo);
    // Ended from the phone: the desk ends the browser with it.
    await endSession(SESSION);
    await settle();
    release();
    expect(get(browserShown)).toBeNull();
    expect(get(browserViews)[SESSION]).toBeUndefined();
    expect(get(view).sessionId).toBeNull();
    expect(argsOf(demo, "unwatch_browser_for_device", at)).toHaveLength(1);
  });

  it("sends only what a Device may send, and never the desk's own watch", async () => {
    const demo = await visit();
    const release = await tapOpen();
    demo.advance();
    vi.advanceTimersByTime(DEMO_LEASE_MS);
    await settle();
    await tapClose(release);

    const sent = [...new Set(demo.commands())];
    expect(sent.filter((cmd) => !allowedToRemoteRole(cmd))).toEqual([]);
    expect(sent).not.toContain("watch_browser");
    expect(sent).not.toContain("unwatch_browser");
    expect(demo.unanswered()).toEqual([]);
  });
});

describe("a browser the phone cannot show", () => {
  const onHost: Workspace = {
    id: "ws-lab",
    name: "lab",
    rootPath: "/srv/lab",
    ssh: { host: "lab-box" },
    activePageId: "p1",
    pages: [{ id: "p1", name: "Agents", layout: { type: "leaf", tabs: ["s-lab"], activeTabIndex: 0 } }],
  } as Workspace;

  it("is an ssh session's, whose host's link carries the desk's frames alone", () => {
    expect(phoneBrowserBlocked([onHost], null, "s-lab")).toMatch(/runs on lab-box/);
    expect(phoneBrowserBlocked([onHost], null, "s-elsewhere")).toBeNull();
  });

  it("is one an older daemon cannot screencast", () => {
    const older = { daemonVersion: 64, appVersion: 65, compatible: true } as never;
    expect(phoneBrowserBlocked([], older, "s-x")).toMatch(/Needs daemon v65/);
  });

  it("still has its button, and the view says why", () => {
    const running = { info: { url: "http://x/", title: "X", tabs: 1 }, frame: null };
    expect(browserButton(running, false)?.pressed).toBe(false);
    expect(browserViewShows(running, "the reason", null)).toEqual({ kind: "blocked", reason: "the reason" });
  });
});

describe("the bundle's source", () => {
  it("runs the desk's browser rules on its own ports, never the desk's instance or pane", () => {
    const reaching = Object.entries(companionSources())
      .filter(([, text]) => /\$lib\/panes\/(browserViewState|BrowserPane)/.test(codeOf(text)))
      .map(([name]) => name);
    expect(reaching).toEqual([]);
  });
});
