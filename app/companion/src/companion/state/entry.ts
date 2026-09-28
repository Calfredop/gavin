// Which Workstation a freshly loaded bundle talks to.
import { loopback, shellPort, type ChannelPort } from "$companion/channel/port";
import {
  createDemoWorkstation,
  type DemoHost,
  type DemoWorkstation,
} from "$companion/demo/workstation";
import type { ViewStorage } from "$companion/state/viewState";

export interface OpenedChannel {
  port: ChannelPort;
  /// The Demo Workstation living in this page, or null when the channel
  /// is the shell's -- which may well reach a demo too, but that one is
  /// the shell's to host and to pace.
  demo: DemoWorkstation | null;
}

/// How often a demo hosted in the page takes a step. Slow enough that a
/// change can be read before the next one lands.
export const DEMO_PACE_MS = 5000;

/// What a page can do of the shell's two acts when it is its own host.
/// A link opens in a tab of its own, with no handle back to this page;
/// there is no hub to return to, so that act is simply not offered.
function pageAsHost(scope: object): DemoHost {
  const open = (scope as { open?: Window["open"] }).open;
  if (typeof open !== "function") return {};
  return {
    openExternal: (url) => {
      open.call(scope, url, "_blank", "noopener,noreferrer");
    },
  };
}

/// The shell's channel where there is one. Anywhere else -- a desktop
/// browser, which is how the bundle is developed -- the page hosts a
/// Demo Workstation of its own and says so in its header.
export function openChannel(scope: object = globalThis): OpenedChannel {
  const shell = shellPort(scope);
  if (shell) return { port: shell, demo: null };
  const demo = createDemoWorkstation({ host: pageAsHost(scope) });
  return { port: loopback(demo), demo };
}

/// Where the view is remembered: the page's own storage, or null on a
/// Device that gives the page none. Reading `localStorage` can itself
/// throw -- a webview with storage switched off refuses the property,
/// not just the write.
export function deviceStorage(scope: object = globalThis): ViewStorage | null {
  try {
    const storage = (scope as { localStorage?: ViewStorage }).localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}
