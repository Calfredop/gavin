// The desk's half of `browserView.ts`: the ports that module runs on, and
// the events that feed it.
//
// The module itself is pure so the Companion's phone view can run it on
// ports of its own (`playwright-companion-view.md`); everything that
// knows about Tauri, the layout and the daemon's version lives here.

import { derived, get } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as backend from "$lib/core/backend";
import { featureBlockedReason } from "$lib/core/daemonCompat";
import { hotState } from "$lib/core/hotState";
import { daemonCompat, layoutState, openBrowserInSplit, playwrightPaneOpenDefault } from "$lib/core/layoutState";
import { workspaceIdForSession, type Workspace } from "$lib/core/workspace";
import { sshLinks, type RemoteLinkEvent } from "$lib/workspace/sshLinkState";
import { isSshWorkspace, sshBrowserBlocked, type SshLinks } from "$lib/workspace/sshWorkspace";
import type { DaemonCompat } from "$lib/core/daemonCompat";
import {
  createBrowserViews,
  resolvePaneOpen,
  type BrowserFrame,
  type BrowserInfo,
  type BrowserViews,
} from "$lib/panes/browserView";

function workspaceOf(workspaces: Workspace[], sessionId: string): Workspace | null {
  const id = workspaceIdForSession({ workspaces }, sessionId);
  return id ? (workspaces.find((w) => w.id === id) ?? null) : null;
}

/// Why the daemon running a session cannot show its browser, or null. An
/// ssh session's browser runs on the host, so the host's daemon is the
/// one asked (`sshBrowserBlocked`); every other session's is this
/// machine's (`featureBlockedReason`).
function blockedReason(
  workspaces: Workspace[],
  compat: DaemonCompat | null,
  links: SshLinks,
  sessionId: string
): string | null {
  const ws = workspaceOf(workspaces, sessionId);
  if (isSshWorkspace(ws)) return sshBrowserBlocked(ws, links);
  return featureBlockedReason(compat, "playwrightBrowser");
}

/// The module, kept across an HMR re-run so a pane's stream and the
/// sessions already auto-opened survive an edit.
export const browserViews: BrowserViews = hotState(
  "browserViews",
  () =>
    createBrowserViews({
      watch: (sessionId) => backend.watchBrowser(sessionId),
      unwatch: (sessionId) => backend.unwatchBrowser(sessionId),
      listBrowsers: () => backend.listBrowsers(),
      openSettingFor(sessionId) {
        const ws = workspaceOf(get(layoutState).workspaces, sessionId);
        return ws ? resolvePaneOpen(ws.playwrightPaneOpen, get(playwrightPaneOpenDefault)) : null;
      },
      blockedReason: (sessionId) =>
        blockedReason(get(layoutState).workspaces, get(daemonCompat), get(sshLinks), sessionId),
      openPane: (sessionId, focus) => openBrowserInSplit(sessionId, focus),
      later(fn, ms) {
        setTimeout(fn, ms);
      },
    }),
  import.meta.hot?.data
);

/// `blockedReason` for a template: re-derived when the daemon, a host's
/// link or the workspaces change, so a pane that said "needs v65" clears
/// itself once the daemon is restarted on a new build.
export const browserBlocked = derived(
  [layoutState, daemonCompat, sshLinks],
  ([$layout, $compat, $links]) =>
    (sessionId: string): string | null =>
      blockedReason($layout.workspaces, $compat, $links, sessionId)
);

/// Registers the four pushes the module runs on and reads the running
/// browsers back each time the window (re)connects. Called once from
/// bootstrap.
export async function initBrowserViews(): Promise<UnlistenFn> {
  const views = browserViews;
  const unlisteners: UnlistenFn[] = [];
  unlisteners.push(
    await listen<[string, BrowserInfo | null]>("browser-changed", (event) =>
      views.changed(event.payload[0], event.payload[1])
    )
  );
  unlisteners.push(await listen<BrowserFrame>("browser-desk-frame", (event) => views.frame(event.payload)));
  unlisteners.push(await listen<string>("browser-gone", (event) => views.ended(event.payload)));
  // The session's own exit as well: a browser nobody was watching sends
  // no `browser-gone`, and the chip must not outlive its tab.
  unlisteners.push(await listen<[string, number]>("session-exited", (event) => views.ended(event.payload[0])));
  // A host came back: its watches belonged to the connection that
  // dropped, and a browser may have started or stopped meanwhile.
  unlisteners.push(
    await listen<RemoteLinkEvent>("remote-link-ready", () => {
      views.reassert();
      void views.seed();
    })
  );
  // The read-back, every time this window reaches its daemon: at startup
  // and after a reconnect, whose new connection holds no watch.
  let ready = false;
  unlisteners.push(
    layoutState.subscribe((state) => {
      const now = state.status === "ready";
      if (now && !ready) {
        views.reassert();
        void views.seed();
      }
      ready = now;
    })
  );
  return () => {
    for (const unlisten of unlisteners) unlisten();
  };
}
