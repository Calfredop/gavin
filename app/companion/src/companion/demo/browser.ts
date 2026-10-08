// The demo's agent browsers: field-notes' agent ("offline sync") checks
// the app's offline mode in a browser of its own, as an agent with
// Playwright does, and the desk streams it to a phone that asks.
//
// What the desk does for a Device (`browser_view.rs`), cut down: a watch
// is a lease per watcher, the first one starts the stream -- whose first
// frame follows at once, as a screencast's does -- and a frame goes to
// the Devices as `browser-frame` only while some lease holds. The demo
// keeps no clock, so a lease here ends when it is let go, never by
// running out. Every page change is pushed as `browser-changed`, which a
// desk pushes to everyone, watching or not.
import type { BrowserFrame, BrowserInfo, LiveBrowser } from "$lib/panes/browserView";
import { DemoFailure, text, type Answer, type DemoCommand, type DemoContext } from "$companion/demo/answer";
import { NOTE_OFFLINE_EDIT, NOTES_HOME, NOTES_SYNCED } from "$companion/demo/browserFrames";

/// The session whose agent has a browser when the demo starts.
export const BROWSING_SESSION = "s-notes-sync";

/// What a desk says a Device's lease lasts (`DEVICE_LEASE`).
export const DEMO_LEASE_MS = 30_000;

/// One running browser.
export interface DemoBrowser {
  /// Which of `PAGES` it shows.
  page: number;
  /// The last frame's number.
  seq: number;
  /// The watchers holding a lease on its stream, in the order they came.
  watchers: string[];
}

interface Page {
  url: string;
  title: string;
  data: string;
}

/// What the agent goes through, round and round: the list, a note edited
/// offline, the change synced.
const PAGES: Page[] = [
  { url: "http://localhost:5173/", title: "Field Notes", data: NOTES_HOME },
  {
    url: "http://localhost:5173/notes/gull-colony",
    title: "Gull colony, north cliff — Field Notes",
    data: NOTE_OFFLINE_EDIT,
  },
  { url: "http://localhost:5173/?synced=1", title: "Field Notes", data: NOTES_SYNCED },
];

export function sampleBrowsers(): Record<string, DemoBrowser> {
  return { [BROWSING_SESSION]: { page: 0, seq: 0, watchers: [] } };
}

function infoOf(browser: DemoBrowser): BrowserInfo {
  const { url, title } = PAGES[browser.page];
  return { url, title, tabs: 1 };
}

function frameOf(sessionId: string, browser: DemoBrowser): BrowserFrame {
  const { url, title, data } = PAGES[browser.page];
  // The browser's own size, as the daemon reports it: the picture is the
  // phone's, the page it was taken of is not.
  return { sessionId, seq: browser.seq, data, width: 1280, height: 800, url, title };
}

/// A frame of what the browser shows now, to the Devices -- while any of
/// them holds a lease.
function screencast(demo: DemoContext, sessionId: string, browser: DemoBrowser): void {
  if (browser.watchers.length === 0) return;
  browser.seq += 1;
  demo.emit("browser-frame", frameOf(sessionId, browser));
}

/// The agent moves its browser on a page, as the activity loop runs.
export function turnPage(demo: DemoContext): void {
  for (const [sessionId, browser] of Object.entries(demo.state.browsers)) {
    browser.page = (browser.page + 1) % PAGES.length;
    demo.emit("browser-changed", [sessionId, infoOf(browser)]);
    screencast(demo, sessionId, browser);
  }
}

/// The session ended, and its browser with it: said as the desk says it.
export function closeBrowser(demo: DemoContext, sessionId: string): void {
  const browser = demo.state.browsers[sessionId];
  if (!browser) return;
  delete demo.state.browsers[sessionId];
  demo.emit("browser-changed", [sessionId, null]);
  if (browser.watchers.length > 0) demo.emit("browser-gone", sessionId);
}

function sessionArg(args: Record<string, unknown>, demo: DemoContext): string {
  const id = text(args, "sessionId");
  if (!demo.state.terminals[id]) throw new DemoFailure(`unknown session: ${id}`);
  return id;
}

export const BROWSER_COMMANDS: Record<string, DemoCommand> = {
  list_browsers: (_args, demo): Answer<"listBrowsers"> =>
    Object.entries(demo.state.browsers).map(
      ([sessionId, browser]): LiveBrowser => ({ sessionId, browser: infoOf(browser) })
    ),

  // A session with no browser yet is watched all the same, as the daemon
  // holds a watch for a browser launched later.
  watch_browser_for_device: (args, demo): Answer<"watchBrowserForDevice"> => {
    const sessionId = sessionArg(args, demo);
    const watcher = text(args, "watcher");
    const browser = demo.state.browsers[sessionId];
    if (!browser) return { frame: null, leaseMs: DEMO_LEASE_MS };
    if (browser.watchers.includes(watcher)) return { frame: frameOf(sessionId, browser), leaseMs: DEMO_LEASE_MS };
    const starting = browser.watchers.length === 0;
    browser.watchers.push(watcher);
    // A stream already running hands over its newest frame. One starting
    // has none to hand: its first frame follows as an event.
    if (!starting) return { frame: frameOf(sessionId, browser), leaseMs: DEMO_LEASE_MS };
    screencast(demo, sessionId, browser);
    return { frame: null, leaseMs: DEMO_LEASE_MS };
  },

  unwatch_browser_for_device: (args, demo): Answer<"unwatchBrowserForDevice"> => {
    const browser = demo.state.browsers[text(args, "sessionId")];
    const watcher = text(args, "watcher");
    if (browser) browser.watchers = browser.watchers.filter((w) => w !== watcher);
  },
};
