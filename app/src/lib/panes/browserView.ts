// The live view of an agent's browser (`playwright-live-pane.md`).
//
// Every agent session can own one headless browser, launched by the
// daemon on the agent's first `browser_*` call
// (`docs/superpowers/specs/2026-10-08-playwright-integration-design.md`).
// This module is what the desk knows about those browsers, and when it
// shows one:
//
// - `BrowserChanged` says a session's browser launched, navigated or
//   stopped. It lights the tab's browser chip, and on a LAUNCH it arms
//   the auto-open: the module starts watching ahead of the first frame.
// - The first `BrowserFrame` of an armed session opens the pane beside
//   its tab when the session's workspace says `auto`. Never a second
//   time: closing the pane only hides it, and the chip reopens it.
// - A pane on screen holds the stream; nothing else does. A hidden pane,
//   a background page and a chip nobody pressed cost the daemon no
//   screencast at all.
// - `ListBrowsers` is the read-back after a reload, so a live browser's
//   chip does not wait for its next navigation.
//
// Pure, on purpose: no Tauri import, and every effect goes through the
// ports a window hands in (`browserViewState.ts`). The Companion's phone
// view runs it on ports of its own (`app/companion/.../state/browser.ts`):
// a smaller stream the desk opens for it, and an open setting that is
// always the chip, since a phone's view never opens on its own.

import { writable, type Readable } from "svelte/store";

// --- The open setting ---------------------------------------------------

/// When a session's pane opens: on its browser's first frame, or only
/// when the tab's chip is pressed. App-wide in Settings, overridable per
/// workspace, both stored as an absence when nobody chose (the terminal
/// font size's convention).
export type PaneOpenSetting = "auto" | "chip";

/// What nobody choosing comes to.
export const DEFAULT_PANE_OPEN: PaneOpenSetting = "auto";

export const PANE_OPEN_LABELS: Record<PaneOpenSetting, string> = {
  auto: "Open automatically",
  chip: "Open from the tab chip",
};

/// A stored value as the setting, or null for "no setting". config.json
/// is a file a human can edit, so a word this build does not know must
/// read as absent -- inherit -- rather than reach a comparison.
export function normalizePaneOpen(value: unknown): PaneOpenSetting | null {
  return value === "auto" || value === "chip" ? value : null;
}

/// The setting in force for a workspace: its own when it has one, else the
/// app-wide one, else gavin's default.
export function resolvePaneOpen(workspaceValue: unknown, appValue: unknown): PaneOpenSetting {
  return normalizePaneOpen(workspaceValue) ?? normalizePaneOpen(appValue) ?? DEFAULT_PANE_OPEN;
}

/// The picker's rows. The first is "no setting", and says what that comes
/// to, so a Default row never hides which behaviour it is.
export function paneOpenOptions(inherited: PaneOpenSetting): { value: string; label: string }[] {
  return [
    { value: "", label: `Default (${PANE_OPEN_LABELS[inherited]})` },
    { value: "auto", label: PANE_OPEN_LABELS.auto },
    { value: "chip", label: PANE_OPEN_LABELS.chip },
  ];
}

export function paneOpenFromSelect(value: string): PaneOpenSetting | null {
  return normalizePaneOpen(value);
}

// --- What the daemon says ---------------------------------------------

/// What a session's browser is showing: the tab its agent acts on
/// (`protocol::BrowserInfo`).
export interface BrowserInfo {
  url: string;
  title: string;
  /// Open tabs, popups included.
  tabs: number;
}

/// One screencast frame of that tab (`protocol::Response::BrowserFrame`).
/// `data` is the JPEG, base64, as Chromium sent it.
export interface BrowserFrame {
  sessionId: string;
  seq: number;
  data: string;
  width: number;
  height: number;
  url: string;
  title: string;
}

/// What the desk answers a Device's watch (`browser_view.rs`): the newest
/// phone-size frame it holds, and how long the watch lasts unless the
/// Device asks again. Its frames arrive as `browser-frame`.
export interface DeviceBrowserWatch {
  frame: BrowserFrame | null;
  leaseMs: number;
}

/// One running browser, as `ListBrowsers` reports it.
export interface LiveBrowser {
  sessionId: string;
  browser: BrowserInfo;
}

/// What the desk holds about one session's browser.
export interface BrowserView {
  /// Null while no browser runs. This is what lights the chip.
  info: BrowserInfo | null;
  /// The newest frame. Kept after the browser stops, so a pane left open
  /// still shows where the agent got to.
  frame: BrowserFrame | null;
}

// --- The module ----------------------------------------------------------

/// What a window does on the module's behalf.
export interface BrowserViewPorts {
  /// Start (or keep) streaming the session's frames to this window.
  /// Idempotent. Resolves with the newest frame the host already holds,
  /// which is all a pane mounting on a running stream would otherwise see
  /// until the page next changes.
  watch(sessionId: string): Promise<BrowserFrame | null>;
  /// This window no longer wants the session's frames.
  unwatch(sessionId: string): Promise<void>;
  /// Every running browser, on every daemon this window talks to.
  listBrowsers(): Promise<LiveBrowser[]>;
  /// The setting in force for the workspace that holds the session, or
  /// null when this window shows no workspace holding it -- another
  /// window's sessions are that window's to open.
  openSettingFor(sessionId: string): PaneOpenSetting | null;
  /// Why the daemon running the session cannot show its browser
  /// (`featureBlockedReason`), or null.
  blockedReason(sessionId: string): string | null;
  /// Split the pane beside the session's tab. `focus` brings it forward,
  /// which the chip does and the auto-open never does: a pane appearing
  /// must not take the keyboard from a human typing elsewhere. Resolves
  /// whether a pane is open now.
  openPane(sessionId: string, focus: boolean): Promise<boolean>;
  /// Run `fn` after `ms`. The window's setTimeout; a manual clock in tests.
  later(fn: () => void, ms: number): void;
}

/// How long a stream nobody wants is kept before it is let go. Long enough
/// that a pane re-mounting -- a tab switched away and back, the auto-open
/// handing over to the pane it opened -- keeps the stream it had: a new
/// watch on an idle page draws nothing until the page changes.
export const RELEASE_GRACE_MS = 1500;

export interface BrowserViews {
  views: Readable<Record<string, BrowserView>>;
  /// `BrowserChanged`: launched, navigated, switched tab (`info`), or
  /// stopped (`null`).
  changed(sessionId: string, info: BrowserInfo | null): void;
  /// One `BrowserFrame`.
  frame(frame: BrowserFrame): void;
  /// The session ended (`BrowserGone`, or its exit): everything about it
  /// goes, and nothing that arrives later brings it back.
  ended(sessionId: string): void;
  /// The read-back: `ListBrowsers`.
  seed(): Promise<void>;
  /// A link or the daemon came back: ask again for every stream still
  /// wanted. The host's watches belonged to the connection that dropped.
  reassert(): void;
  /// A pane on screen. Returns its release.
  attach(sessionId: string): () => void;
  /// The tab's chip was pressed.
  openFromChip(sessionId: string): Promise<void>;
}

export function createBrowserViews(ports: BrowserViewPorts): BrowserViews {
  const views = writable<Record<string, BrowserView>>({});
  let current: Record<string, BrowserView> = {};
  views.subscribe((v) => (current = v));

  /// Panes on screen, per session.
  const viewers = new Map<string, number>();
  /// Launched in this window's sight and not yet drawn: the first frame
  /// opens the pane. Holds the stream until then.
  const armed = new Set<string>();
  /// The auto-open happened, or was forgone (a browser already running
  /// when the window loaded, a pane opened from the chip first).
  const autoDone = new Set<string>();
  /// Sessions this module has asked to watch.
  const watching = new Set<string>();
  /// Sessions that ended. Ids are never reused, so this only grows by the
  /// sessions this window saw end.
  const ended = new Set<string>();
  /// Token counters, never identity (Svelte proxies what it stores):
  /// `watchGen` supersedes a watch's late answer, `releaseGen` a release
  /// timer that a new viewer overtook.
  const watchGen = new Map<string, number>();
  const releaseGen = new Map<string, number>();
  /// When each session last changed, against `changes`, so a read-back
  /// in flight does not overwrite what arrived after it was asked.
  let changes = 0;
  const lastChange = new Map<string, number>();
  let seedGen = 0;

  const bump = (counters: Map<string, number>, sessionId: string): number => {
    const next = (counters.get(sessionId) ?? 0) + 1;
    counters.set(sessionId, next);
    return next;
  };

  function update(sessionId: string, patch: Partial<BrowserView>): void {
    views.update((all) => {
      const prior: BrowserView = all[sessionId] ?? { info: null, frame: null };
      return { ...all, [sessionId]: { ...prior, ...patch } };
    });
  }

  const wants = (sessionId: string): boolean => (viewers.get(sessionId) ?? 0) > 0 || armed.has(sessionId);

  function startWatch(sessionId: string): void {
    if (ports.blockedReason(sessionId) !== null) return;
    const token = bump(watchGen, sessionId);
    watching.add(sessionId);
    ports.watch(sessionId).then(
      (held) => {
        if (watchGen.get(sessionId) !== token || ended.has(sessionId)) return;
        // Only into an empty pane: a frame the stream already delivered
        // is newer than whatever the host held when it was asked.
        if (held && !current[sessionId]?.frame) acceptFrame(held);
      },
      () => {
        if (watchGen.get(sessionId) === token) watching.delete(sessionId);
      }
    );
  }

  function stopWatch(sessionId: string): void {
    bump(watchGen, sessionId);
    watching.delete(sessionId);
    void ports.unwatch(sessionId).catch(() => {});
  }

  /// Brings the stream in line with whether anything wants it: started at
  /// once, let go only after the grace.
  function sync(sessionId: string): void {
    const token = bump(releaseGen, sessionId);
    if (wants(sessionId)) {
      if (!watching.has(sessionId)) startWatch(sessionId);
      return;
    }
    if (!watching.has(sessionId)) return;
    ports.later(() => {
      if (releaseGen.get(sessionId) !== token || wants(sessionId) || !watching.has(sessionId)) return;
      stopWatch(sessionId);
    }, RELEASE_GRACE_MS);
  }

  function acceptFrame(frame: BrowserFrame): void {
    const sessionId = frame.sessionId;
    update(sessionId, { frame });
    if (!armed.delete(sessionId)) return;
    autoDone.add(sessionId);
    // Asked again here rather than trusted from the launch: the human may
    // have moved the setting in between.
    if (ports.openSettingFor(sessionId) === "auto") void ports.openPane(sessionId, false);
    // The pane it opened takes the stream over when it mounts, inside the
    // grace; one opened on a page nobody is looking at lets it go.
    sync(sessionId);
  }

  return {
    views: { subscribe: views.subscribe },

    changed(sessionId, info) {
      if (ended.has(sessionId)) return;
      lastChange.set(sessionId, ++changes);
      const launched = info !== null && !current[sessionId]?.info;
      update(sessionId, { info });
      if (info === null) {
        // A browser that stopped before its first frame has nothing left
        // to open on; the next launch arms afresh.
        if (armed.delete(sessionId)) sync(sessionId);
        return;
      }
      if (
        launched &&
        !autoDone.has(sessionId) &&
        ports.blockedReason(sessionId) === null &&
        ports.openSettingFor(sessionId) === "auto"
      ) {
        armed.add(sessionId);
      }
      // A relaunch -- or a daemon that restarted under a pane -- has no
      // stream for a watch made before it. The host's watch is
      // idempotent, so asking again costs nothing when it still has one.
      if (wants(sessionId) && (launched || !watching.has(sessionId))) startWatch(sessionId);
    },

    frame(frame) {
      if (ended.has(frame.sessionId)) return;
      acceptFrame(frame);
    },

    ended(sessionId) {
      if (ended.has(sessionId)) return;
      ended.add(sessionId);
      armed.delete(sessionId);
      viewers.delete(sessionId);
      bump(releaseGen, sessionId);
      if (watching.has(sessionId)) stopWatch(sessionId);
      views.update((all) => {
        const rest = { ...all };
        delete rest[sessionId];
        return rest;
      });
    },

    async seed() {
      const token = ++seedGen;
      const asked = changes;
      let live: LiveBrowser[];
      try {
        live = await ports.listBrowsers();
      } catch {
        return;
      }
      if (token !== seedGen) return;
      const listed = new Map(live.map((b) => [b.sessionId, b.browser]));
      const fresh = (sessionId: string) => (lastChange.get(sessionId) ?? 0) <= asked && !ended.has(sessionId);
      views.update((all) => {
        const next = { ...all };
        for (const [sessionId, view] of Object.entries(all)) {
          if (view.info && !listed.has(sessionId) && fresh(sessionId)) next[sessionId] = { ...view, info: null };
        }
        for (const [sessionId, info] of listed) {
          if (fresh(sessionId)) next[sessionId] = { frame: all[sessionId]?.frame ?? null, info };
        }
        return next;
      });
      // Running before this window was looking: its first frame is long
      // gone, so there is no launch to open a pane on.
      for (const sessionId of listed.keys()) {
        if (!fresh(sessionId)) continue;
        autoDone.add(sessionId);
        if (armed.delete(sessionId)) sync(sessionId);
      }
    },

    reassert() {
      for (const sessionId of new Set([...viewers.keys(), ...armed])) {
        if (wants(sessionId) && !ended.has(sessionId)) startWatch(sessionId);
      }
    },

    attach(sessionId) {
      if (ended.has(sessionId)) return () => {};
      viewers.set(sessionId, (viewers.get(sessionId) ?? 0) + 1);
      sync(sessionId);
      let released = false;
      return () => {
        if (released || ended.has(sessionId)) return;
        released = true;
        const left = (viewers.get(sessionId) ?? 1) - 1;
        if (left > 0) viewers.set(sessionId, left);
        else viewers.delete(sessionId);
        sync(sessionId);
      };
    },

    async openFromChip(sessionId) {
      if (ended.has(sessionId)) return;
      autoDone.add(sessionId);
      // The pane is opening anyway; the first frame must not open another.
      armed.delete(sessionId);
      await ports.openPane(sessionId, true);
      sync(sessionId);
    },
  };
}

// --- What the surfaces draw ------------------------------------------

/// What a pane shows, in the order a human would fix it.
export type PaneShows =
  | { kind: "blocked"; reason: string }
  | { kind: "frame"; frame: BrowserFrame; url: string; stopped: boolean }
  | { kind: "waiting" }
  | { kind: "idle" };

export function paneShows(view: BrowserView | undefined, blocked: string | null): PaneShows {
  if (blocked !== null) return { kind: "blocked", reason: blocked };
  if (view?.frame) return { kind: "frame", frame: view.frame, url: view.frame.url, stopped: view.info === null };
  if (view?.info) return { kind: "waiting" };
  return { kind: "idle" };
}

/// What a pane says where it has no frame to draw, or over its last one.
/// The desk's pane and the phone's view say the same.
export const PANE_NOTES = {
  waiting: "Waiting for the browser's first frame…",
  idle: "This agent's browser is not running. It starts with the agent's first browser tool call.",
  stopped: "The browser stopped. This is the last thing it showed.",
} as const;

/// The tab's browser chip, or null when there is none to draw: no browser
/// running, or a daemon that cannot show one.
export function chipFor(view: BrowserView | undefined, blocked: string | null): { tip: string } | null {
  if (blocked !== null || !view?.info) return null;
  const { title, url, tabs } = view.info;
  const where = title.trim() || url;
  return { tip: `Show this agent's browser · ${where}${tabs > 1 ? ` · ${tabs} tabs` : ""}` };
}
