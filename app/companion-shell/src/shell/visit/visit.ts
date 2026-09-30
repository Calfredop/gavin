// A visit: one Workstation's bundle open over the hub, and the channel
// that joins it to that Workstation.
//
// The native view is where the bundle runs; this is what it is joined to.
// Each visit gets a session number, which tags every event its view sends,
// and a channel bound to that Workstation's end alone. Only one visit is
// open at a time, and a view that belongs to an older one -- still opening
// when the hub moved on, or answering after it closed -- is closed or
// ignored, never joined to the current Workstation.
//
// Before the view opens, the bundle it will run has to be there
// (`prepare`): the Demo Workstation's is embedded, and a paired
// Workstation's is fetched, verified and installed by hash
// (`bundle/bundle.ts`), which takes a moment the hub shows. A visit that
// is superseded while preparing stops, and opens nothing.
import { writable, type Readable } from "svelte/store";
import type { PluginListenerHandle } from "@capacitor/core";
import type { Landing } from "$companion/channel/messages";
import type { ChannelEndpoint } from "$companion/channel/port";
import { createShellChannel, type Drop, type ShellChannel } from "$shell/channel/shellChannel";
import type { HubWorkstation } from "$shell/hub/workstations";
import type { BundleMessageEvent, BundleViewPlugin } from "$shell/native/bundleView";

export type VisitState =
  | { status: "hub" }
  /// `detail` is what is being done meanwhile: fetching the bundle, or
  /// null while the view itself opens.
  | { status: "opening"; workstation: HubWorkstation; detail: string | null }
  | { status: "open"; workstation: HubWorkstation }
  /// The view could not be opened. The hub shows why and stays usable.
  | { status: "failed"; workstation: HubWorkstation; reason: string };

/// A Workstation's end of the channel, for the length of one visit.
export interface VisitEndpoint {
  endpoint: ChannelEndpoint;
  /// Starts whatever keeps the Workstation moving while its bundle is
  /// open, and returns how to stop it.
  start?(): () => void;
}

export type VisitDrop =
  /// Refused natively: not the bundle's origin, or not its main frame.
  | { where: "native"; origin: string; mainFrame: boolean }
  /// Refused by the shell's channel.
  | { where: "shell"; reason: Drop["reason"]; origin: string }
  /// From a view that is not the open visit's.
  | { where: "stale"; session: number };

export interface VisitDeps {
  view: Pick<BundleViewPlugin, "open" | "post" | "close" | "openExternal" | "addListener">;
  endpointFor(workstation: HubWorkstation): VisitEndpoint;
  /// Readies the bundle the view will run and names it: an embedded
  /// bundle's name, or an installed bundle's hash. `say` is for the
  /// hub's "Opening…" line. Absent, the Demo Workstation's is the only
  /// bundle there is.
  prepare?(workstation: HubWorkstation, say: (detail: string) => void, signal: AbortSignal): Promise<string>;
  onDrop?(drop: VisitDrop): void;
}

export interface Visits {
  readonly state: Readable<VisitState>;
  /// Opens a Workstation's bundle, closing any visit already open.
  /// `landing` is where the bundle should land once open: an inbox
  /// item's session or card, handed over in the channel's `capabilities`.
  open(workstation: HubWorkstation, landing?: Landing | null): Promise<void>;
  /// Back to the hub.
  close(): Promise<void>;
  /// Closes any visit and stops listening to the native view.
  dispose(): Promise<void>;
}

interface Visit {
  session: number;
  workstation: HubWorkstation;
  landing: Landing | null;
  /// Stops a bundle fetch still under way when the visit ends.
  preparing: AbortController;
  channel: ShellChannel | null;
  /// What the bundle said before its view answered with its origin: a
  /// bundle loads fast, and its first question can overtake that answer.
  early: BundleMessageEvent[];
  stop: (() => void) | null;
  /// Whether the native view has answered `open`. Until it has there is
  /// no view to close: the open's own continuation closes it instead,
  /// once it finds the hub has moved on.
  opened: boolean;
}

export function createVisits(deps: VisitDeps): Visits {
  const { view, endpointFor, onDrop } = deps;
  const state = writable<VisitState>({ status: "hub" });
  // Counted, never compared by identity: a session number is what the
  // native side echoes back, and what outlives a superseded visit.
  let sessions = 0;
  let current: Visit | null = null;
  let listening: Promise<PluginListenerHandle[]> | null = null;

  /// Whether `visit` is still the open one. By session number, the thing
  /// that is actually unique to a visit.
  function isCurrent(visit: Visit): boolean {
    return current?.session === visit.session;
  }

  function end(visit: Visit): void {
    if (isCurrent(visit)) current = null;
    visit.preparing.abort();
    visit.channel?.close();
    visit.stop?.();
    visit.stop = null;
  }

  function onMessage(e: BundleMessageEvent): void {
    const visit = current;
    if (!visit || e.session !== visit.session) {
      onDrop?.({ where: "stale", session: e.session });
      return;
    }
    if (visit.channel) visit.channel.receive(e.data, e.origin);
    else visit.early.push(e);
  }

  function listen(): Promise<PluginListenerHandle[]> {
    listening ??= Promise.all([
      view.addListener("message", onMessage),
      view.addListener("dropped", (e) => {
        if (current && e.session === current.session) {
          onDrop?.({ where: "native", origin: e.origin, mainFrame: e.mainFrame });
        }
      }),
      view.addListener("closed", (e) => {
        const visit = current;
        if (!visit || e.session !== visit.session) return;
        end(visit);
        state.set({ status: "hub" });
      }),
    ]);
    return listening;
  }

  async function close(): Promise<void> {
    const visit = current;
    if (!visit) {
      state.update((s) => (s.status === "failed" ? { status: "hub" } : s));
      return;
    }
    end(visit);
    state.set({ status: "hub" });
    if (visit.opened) await view.close({ session: visit.session }).catch(() => {});
  }

  const prepare: NonNullable<VisitDeps["prepare"]> =
    deps.prepare ??
    (async (workstation) => {
      if (workstation.demo) return "demo";
      throw new Error(`no way to reach ${workstation.name} yet`);
    });

  async function open(workstation: HubWorkstation, landing: Landing | null = null): Promise<void> {
    await close();
    await listen();
    sessions += 1;
    const visit: Visit = {
      session: sessions,
      workstation,
      landing,
      preparing: new AbortController(),
      channel: null,
      early: [],
      stop: null,
      opened: false,
    };
    current = visit;
    state.set({ status: "opening", workstation, detail: null });

    const failed = (e: unknown): void => {
      if (!isCurrent(visit)) return;
      end(visit);
      state.set({ status: "failed", workstation, reason: e instanceof Error ? e.message : String(e) });
    };

    let bundle: string;
    try {
      bundle = await prepare(
        workstation,
        (detail) => {
          if (isCurrent(visit)) state.set({ status: "opening", workstation, detail });
        },
        visit.preparing.signal
      );
    } catch (e) {
      failed(e);
      return;
    }
    if (!isCurrent(visit)) return;
    state.set({ status: "opening", workstation, detail: null });

    let origin: string;
    try {
      ({ origin } = await view.open({ session: visit.session, workstation: workstation.id, bundle }));
      visit.opened = true;
    } catch (e) {
      failed(e);
      return;
    }
    if (!isCurrent(visit)) {
      // The hub moved on while this view was opening.
      await view.close({ session: visit.session }).catch(() => {});
      return;
    }

    const { endpoint, start } = endpointFor(workstation);
    visit.channel = createShellChannel({
      origin,
      workstation: { id: workstation.id, name: workstation.name, demo: workstation.demo },
      landing: visit.landing,
      endpoint,
      acts: {
        openExternal: (url) => view.openExternal({ url }),
        returnToHub: () => (isCurrent(visit) ? close() : undefined),
      },
      deliver: (data) => {
        void view.post({ session: visit.session, data }).catch(() => {});
      },
      onDrop: (drop) => onDrop?.({ where: "shell", reason: drop.reason, origin: drop.origin }),
    });
    visit.stop = start?.() ?? null;
    state.set({ status: "open", workstation });
    for (const e of visit.early.splice(0)) visit.channel.receive(e.data, e.origin);
  }

  return {
    state: { subscribe: state.subscribe },
    open,
    close,
    async dispose() {
      await close();
      const handles = listening ? await listening : [];
      listening = null;
      await Promise.all(handles.map((h) => h.remove()));
    },
  };
}
