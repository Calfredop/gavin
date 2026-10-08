// An agent's browser, live on the phone (`playwright-companion-view.md`).
//
// The rules are the desk's own (`$lib/panes/browserView.ts`): which
// browsers are running, what a view on screen holds, when a stream is let
// go. This file is the phone's ports onto them, and three things the phone
// decides differently:
//
// - **The stream is the desk's to open.** A Device sends the daemon
//   nothing of its own (ADR 0003), and the desk's own watch streams the
//   desk's size to a desk window. So the phone asks the desk for a stream
//   at the phone's size and rate (`watch_browser_for_device`), whose
//   frames reach it as `browser-frame`. Nothing tells the desk a phone has
//   gone quiet, so the watch is a lease: renewed here while the view is on
//   screen, at a third of what the desk says it lasts.
// - **Only while watching.** `browser-frame` carries every Device's
//   frames, so this page listens for it only while it watches something,
//   and keeps only the frames of what it watches.
// - **Never on its own.** The open setting is always the chip, whatever
//   the desk's `playwrightPaneOpen` says: a pane taking over a phone's
//   screen mid-glance would be worse than a missed frame. The view opens
//   when the human taps for it, beside the session's terminal.
import { get, writable, type Readable } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as backend from "$lib/core/backend";
import { featureBlockedReason, type DaemonCompat } from "$lib/core/daemonCompat";
import { daemonCompat, layoutState } from "$lib/core/layoutState";
import { workspaceIdForSession, type Workspace } from "$lib/core/workspace";
import {
  createBrowserViews,
  type BrowserFrame,
  type BrowserInfo,
  type BrowserView,
  type BrowserViews,
  type PaneOpenSetting,
} from "$lib/panes/browserView";
import { isSshWorkspace } from "$lib/workspace/sshWorkspace";
import { uuidFrom } from "$companion/remote/randomUUID";

/// The event the desk offers a Device's frames as (`browser_view.rs`).
export const BROWSER_FRAME_EVENT = "browser-frame";

/// How the phone's view opens: from its button, never on a frame.
const PHONE_OPENS: PaneOpenSetting = "chip";

/// How soon a watch the desk could not take is asked again while the
/// view stays on screen. A connection coming back asks at once as well
/// (`reassertBrowserViews`).
export const WATCH_RETRY_MS = 5000;

/// Why the phone cannot show a session's browser, or null. An ssh
/// session's browser runs on its host, whose one streaming connection
/// carries the desk's frames; the desk cannot open a phone's beside them.
export function phoneBrowserBlocked(
  workspaces: Workspace[],
  compat: DaemonCompat | null,
  sessionId: string
): string | null {
  const id = workspaceIdForSession({ workspaces }, sessionId);
  const ws = workspaces.find((w) => w.id === id);
  if (isSshWorkspace(ws)) {
    return `This agent's browser runs on ${ws.ssh.host}, and a phone is shown only the browsers of this Workstation's own agents.`;
  }
  return featureBlockedReason(compat, "playwrightBrowser");
}

interface PhoneViews {
  views: BrowserViews;
  /// This connection is over: nothing it started may act again.
  stop(): void;
}

const viewsStore = writable<Record<string, BrowserView>>({});
const shownStore = writable<string | null>(null);
const problemsStore = writable<Record<string, string>>({});

/// What the phone knows about each session's browser.
export const browserViews: Readable<Record<string, BrowserView>> = { subscribe: viewsStore.subscribe };
/// The session whose browser is on screen beside its terminal, or null.
export const browserShown: Readable<string | null> = { subscribe: shownStore.subscribe };
/// Why the desk would not stream a session's browser, while its view is
/// up. Cleared by the next watch it takes.
export const browserProblems: Readable<Record<string, string>> = { subscribe: problemsStore.subscribe };

function setProblem(sessionId: string, problem: string | null): void {
  problemsStore.update((all) => {
    if ((all[sessionId] ?? null) === problem) return all;
    const next = { ...all };
    if (problem === null) delete next[sessionId];
    else next[sessionId] = problem;
    return next;
  });
}

function createPhoneViews(): PhoneViews {
  /// Whose lease this connection holds: one id for every watch it makes,
  /// so another Device's view of the same session keeps its own.
  const watcher = uuidFrom(globalThis.crypto);
  const watched = new Set<string>();
  const renewals = new Map<string, ReturnType<typeof setTimeout>>();
  let stopped = false;
  /// The `browser-frame` listener while anything is watched. Counted,
  /// never compared: a listen that lands after the last watch was let go
  /// must undo itself.
  let hearing: Promise<UnlistenFn> | null = null;
  let hearingGen = 0;

  function hearFrames(): void {
    if (hearing) return;
    const gen = ++hearingGen;
    hearing = listen<BrowserFrame>(BROWSER_FRAME_EVENT, (event) => {
      if (!stopped && watched.has(event.payload.sessionId)) views.frame(event.payload);
    });
    hearing.catch(() => {
      if (gen === hearingGen) hearing = null;
    });
  }

  function stopHearing(): void {
    const asked = hearing;
    hearing = null;
    hearingGen += 1;
    void asked?.then((unlisten) => unlisten()).catch(() => {});
  }

  function renewIn(sessionId: string, ms: number): void {
    clearTimeout(renewals.get(sessionId));
    renewals.set(
      sessionId,
      setTimeout(() => void ask(sessionId), ms)
    );
  }

  /// Takes or renews the lease. Never rejects: a watch the desk could not
  /// take is said beside the view and asked again for as long as the view
  /// wants it, which is the module's to decide (it lets go through
  /// `unwatch`).
  async function ask(sessionId: string): Promise<BrowserFrame | null> {
    if (stopped || !watched.has(sessionId)) return null;
    // Before the ask, every time: the desk may offer the first frame
    // before it answers, and a listen it refused while it was away has
    // to be made again with the watch.
    hearFrames();
    try {
      const answer = await backend.watchBrowserForDevice(sessionId, watcher);
      if (stopped || !watched.has(sessionId)) return null;
      setProblem(sessionId, null);
      renewIn(sessionId, Math.max(1000, answer.leaseMs / 3));
      return answer.frame;
    } catch (e) {
      if (stopped || !watched.has(sessionId)) return null;
      setProblem(sessionId, String(e));
      renewIn(sessionId, WATCH_RETRY_MS);
      return null;
    }
  }

  const views: BrowserViews = createBrowserViews({
    watch(sessionId) {
      if (stopped) return Promise.resolve(null);
      watched.add(sessionId);
      return ask(sessionId);
    },
    async unwatch(sessionId) {
      if (stopped || !watched.delete(sessionId)) return;
      clearTimeout(renewals.get(sessionId));
      renewals.delete(sessionId);
      setProblem(sessionId, null);
      if (watched.size === 0) stopHearing();
      await backend.unwatchBrowserForDevice(sessionId, watcher);
    },
    listBrowsers: () => (stopped ? Promise.resolve([]) : backend.listBrowsers()),
    openSettingFor: () => PHONE_OPENS,
    blockedReason: (sessionId) =>
      phoneBrowserBlocked(get(layoutState).workspaces, get(daemonCompat), sessionId),
    async openPane(sessionId) {
      if (stopped) return false;
      shownStore.set(sessionId);
      return true;
    },
    later(fn, ms) {
      setTimeout(() => {
        if (!stopped) fn();
      }, ms);
    },
  });

  return {
    views,
    stop() {
      if (stopped) return;
      // Let go of every lease at once rather than when each runs out, while
      // the channel can still carry it.
      for (const sessionId of watched) void backend.unwatchBrowserForDevice(sessionId, watcher).catch(() => {});
      stopped = true;
      for (const timer of renewals.values()) clearTimeout(timer);
      renewals.clear();
      watched.clear();
      stopHearing();
    },
  };
}

let current: PhoneViews = createPhoneViews();
let following = current.views.views.subscribe((v) => viewsStore.set(v));

/// A fresh start, for the next connection: everything the last one knew
/// or held is let go.
export function resetBrowserViews(): void {
  current.stop();
  following();
  current = createPhoneViews();
  following = current.views.views.subscribe((v) => viewsStore.set(v));
  shownStore.set(null);
  problemsStore.set({});
}

/// Hears what the desk says about its agents' browsers, and reads back
/// the ones already running. Called once a connection, from
/// `connectWorkstation`; its teardown is the reset.
export async function startBrowserViews(): Promise<UnlistenFn> {
  resetBrowserViews();
  const stops: UnlistenFn[] = [];
  try {
    stops.push(
      await listen<[string, BrowserInfo | null]>("browser-changed", (event) =>
        current.views.changed(event.payload[0], event.payload[1])
      )
    );
    stops.push(await listen<string>("browser-gone", (event) => browserSessionEnded(event.payload)));
  } catch (e) {
    for (const stop of stops) stop();
    throw e;
  }
  void current.views.seed();
  return () => {
    for (const stop of stops) stop();
    resetBrowserViews();
  };
}

/// The connection came back: whatever the view still wants is asked for
/// again -- the desk may have let a lease run out meanwhile -- and the
/// running browsers read again, since their pushes reached nobody.
export function reassertBrowserViews(): void {
  current.views.reassert();
  void current.views.seed();
}

/// The session ended, or its browser did for good.
export function browserSessionEnded(sessionId: string): void {
  current.views.ended(sessionId);
  setProblem(sessionId, null);
  if (get(shownStore) === sessionId) shownStore.set(null);
}

/// The human's tap: the session's browser beside its terminal.
export async function showBrowser(sessionId: string): Promise<void> {
  await current.views.openFromChip(sessionId);
}

/// Back to the terminal alone. The stream goes once the view has been off
/// the screen for the module's grace.
export function hideBrowser(sessionId: string): void {
  if (get(shownStore) === sessionId) shownStore.set(null);
}

/// The view is on screen. Returns its release.
export function attachBrowser(sessionId: string): () => void {
  return current.views.attach(sessionId);
}
