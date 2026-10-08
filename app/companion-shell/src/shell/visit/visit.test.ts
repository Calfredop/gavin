import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";
import { createChannelClient, type ChannelClient } from "$companion/channel/client";
import type { ChannelPort } from "$companion/channel/port";
import { createDemoWorkstation } from "$companion/demo/workstation";
import type { WorkspacesData } from "$lib/core/workspace";
import type {
  BundleClosedEvent,
  BundleDroppedEvent,
  BundleMessageEvent,
  BundleViewPlugin,
} from "$shell/native/bundleView";
import { DEMO_WORKSTATION, type HubWorkstation } from "$shell/hub/workstations";
import { createVisits, type VisitDeps, type VisitDrop } from "$shell/visit/visit";

const ORIGIN = "gavin-bundle://demo";

type Listener<E> = (e: E) => void;

/// The native bundle view, played in memory: it opens and closes views,
/// and lets a test speak as the bundle inside one.
function fakeView() {
  const on = {
    message: [] as Listener<BundleMessageEvent>[],
    dropped: [] as Listener<BundleDroppedEvent>[],
    closed: [] as Listener<BundleClosedEvent>[],
  };
  const posted: { session: number; data: string }[] = [];
  const closed: number[] = [];
  const external: string[] = [];
  /// Held open until a test lets it answer, where it wants to.
  let gate: Promise<void> | null = null;
  let failWith: string | null = null;
  const view = {
    open: vi.fn(async (_o: { session: number; workstation: string; bundle: string }) => {
      if (gate) await gate;
      if (failWith) throw new Error(failWith);
      return { origin: ORIGIN };
    }),
    post: vi.fn(async (o: { session: number; data: string }) => {
      posted.push(o);
      toBundle.get(o.session)?.(o.data);
    }),
    close: vi.fn(async (o: { session: number }) => {
      closed.push(o.session);
    }),
    openExternal: vi.fn(async (o: { url: string }) => {
      external.push(o.url);
    }),
    addListener: vi.fn(async (event: keyof typeof on, listener: Listener<never>) => {
      (on[event] as Listener<never>[]).push(listener);
      return {
        remove: async () => {
          on[event] = (on[event] as Listener<never>[]).filter((l) => l !== listener) as never;
        },
      };
    }),
  };
  const toBundle = new Map<number, (raw: string) => void>();
  return {
    view: view as unknown as VisitDeps["view"],
    posted,
    closed,
    external,
    listeners: () => on.message.length + on.dropped.length + on.closed.length,
    hold() {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
    failNextOpen(reason: string) {
      failWith = reason;
    },
    /// The bundle's own channel client, inside the view for `session`.
    bundle(session: number, origin = ORIGIN): ChannelClient {
      const port: ChannelPort = {
        post: (data) => queueMicrotask(() => on.message.forEach((l) => l({ session, origin, data }))),
        receive: (handler) => {
          toBundle.set(session, handler);
          return () => toBundle.delete(session);
        },
      };
      return createChannelClient(port);
    },
    say(session: number, data: string, origin = ORIGIN) {
      on.message.forEach((l) => l({ session, origin, data }));
    },
    drop(session: number, origin: string, mainFrame: boolean) {
      on.dropped.forEach((l) => l({ session, origin, mainFrame }));
    },
    systemBack(session: number) {
      on.closed.forEach((l) => l({ session }));
    },
  };
}

/// A schedule a test turns by hand.
function manualClock() {
  const timers = new Set<() => void>();
  return {
    every(fn: () => void): () => void {
      timers.add(fn);
      return () => timers.delete(fn);
    },
    tick() {
      for (const fn of [...timers]) fn();
    },
    running: () => timers.size,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise<void>((r) => queueMicrotask(r));
}

function setup(options: { endpointFor?: VisitDeps["endpointFor"]; prepare?: VisitDeps["prepare"] } = {}) {
  const native = fakeView();
  const clock = manualClock();
  const drops: VisitDrop[] = [];
  const demos: ReturnType<typeof createDemoWorkstation>[] = [];
  const visits = createVisits({
    view: native.view,
    prepare: options.prepare,
    endpointFor:
      options.endpointFor ??
      (() => {
        const demo = createDemoWorkstation({ host: {} });
        demos.push(demo);
        return { endpoint: demo, start: () => clock.every(() => demo.advance()) };
      }),
    onDrop: (d) => drops.push(d),
  });
  return { native, clock, drops, demos, visits };
}

function sessionOf(native: ReturnType<typeof fakeView>, call = 0): number {
  return (native.view.open as unknown as ReturnType<typeof vi.fn>).mock.calls[call][0].session;
}

describe("visiting a Workstation", () => {
  it("opens the Demo Workstation's bundle in the native view and connects it to the demo", async () => {
    const { native, visits, demos } = setup();
    await visits.open(DEMO_WORKSTATION);
    expect(native.view.open).toHaveBeenCalledWith({ session: sessionOf(native), workstation: "demo", bundle: "demo" });
    expect(get(visits.state)).toEqual({ status: "open", workstation: DEMO_WORKSTATION });

    const bundle = native.bundle(sessionOf(native));
    expect((await bundle.capabilities()).workstation).toEqual({ id: "demo", name: "Demo Workstation", demo: true });
    const data = await bundle.invoke<WorkspacesData>("get_workspaces_state");
    expect(data.workspaces.length).toBeGreaterThan(0);
    expect(demos[0].commands()).toEqual(["get_workspaces_state"]);
  });

  it("keeps what the bundle says before its view has answered, and answers it", async () => {
    const { native, visits } = setup();
    const release = native.hold();
    const opening = visits.open(DEMO_WORKSTATION);
    await settle();
    expect(get(visits.state).status).toBe("opening");
    const bundle = native.bundle(sessionOf(native));
    const asked = bundle.capabilities();
    await settle();
    release();
    await opening;
    expect((await asked).workstation.id).toBe("demo");
  });

  it("ignores a message from a view that is no longer the open one", async () => {
    const { native, visits, demos, drops } = setup();
    await visits.open(DEMO_WORKSTATION);
    const stale = sessionOf(native) + 1000;
    native.say(stale, JSON.stringify({ v: 1, type: "invoke", id: 1, cmd: "get_workspaces_state", args: {} }));
    await settle();
    expect(demos[0].commands()).toEqual([]);
    expect(native.posted).toEqual([]);
    expect(drops).toEqual([{ where: "stale", session: stale }]);
  });

  it("drops a message from another origin, even inside the open view", async () => {
    const { native, visits, demos, drops } = setup();
    await visits.open(DEMO_WORKSTATION);
    native.say(
      sessionOf(native),
      JSON.stringify({ v: 1, type: "invoke", id: 1, cmd: "get_workspaces_state", args: {} }),
      "gavin-bundle://other"
    );
    await settle();
    expect(demos[0].commands()).toEqual([]);
    expect(native.posted).toEqual([]);
    expect(drops).toEqual([{ where: "shell", reason: "origin", origin: "gavin-bundle://other" }]);
  });

  it("reports what the native side refused", async () => {
    const { native, visits, drops } = setup();
    await visits.open(DEMO_WORKSTATION);
    native.drop(sessionOf(native), "null", false);
    expect(drops).toEqual([{ where: "native", origin: "null", mainFrame: false }]);
  });

  it("goes back to the hub when the bundle asks, closing its view", async () => {
    const { native, visits, clock } = setup();
    await visits.open(DEMO_WORKSTATION);
    const session = sessionOf(native);
    const bundle = native.bundle(session);
    await bundle.returnToHub();
    await settle();
    expect(native.closed).toEqual([session]);
    expect(get(visits.state)).toEqual({ status: "hub" });
    expect(clock.running()).toBe(0);
  });

  it("ends the visit when the system closes the view, without closing it again", async () => {
    const { native, visits, demos } = setup();
    await visits.open(DEMO_WORKSTATION);
    const session = sessionOf(native);
    native.systemBack(session);
    expect(get(visits.state)).toEqual({ status: "hub" });
    native.say(session, JSON.stringify({ v: 1, type: "invoke", id: 1, cmd: "get_workspaces_state", args: {} }));
    await settle();
    expect(demos[0].commands()).toEqual([]);
    expect(native.closed).toEqual([]);
  });

  it("keeps one visit at a time: opening another closes the first", async () => {
    const other: HubWorkstation = { ...DEMO_WORKSTATION, id: "second", name: "Second" };
    const { native, visits, demos } = setup();
    await visits.open(DEMO_WORKSTATION);
    const first = sessionOf(native);
    await visits.open(other);
    const second = sessionOf(native, 1);
    expect(second).not.toBe(first);
    expect(native.closed).toEqual([first]);
    native.say(first, JSON.stringify({ v: 1, type: "invoke", id: 1, cmd: "get_workspaces_state", args: {} }));
    await settle();
    expect(demos[0].commands()).toEqual([]);
    expect(get(visits.state)).toEqual({ status: "open", workstation: other });
  });

  it("closes a view that finished opening after the hub moved on", async () => {
    const { native, visits } = setup();
    const release = native.hold();
    const opening = visits.open(DEMO_WORKSTATION);
    await settle();
    await visits.close();
    release();
    await opening;
    expect(native.closed).toEqual([sessionOf(native)]);
    expect(get(visits.state)).toEqual({ status: "hub" });
  });

  it("says why a view did not open, and leaves the hub usable", async () => {
    const { native, visits } = setup();
    native.failNextOpen("no bundle for this Workstation");
    await visits.open(DEMO_WORKSTATION);
    expect(get(visits.state)).toEqual({
      status: "failed",
      workstation: DEMO_WORKSTATION,
      reason: "no bundle for this Workstation",
    });
  });

  describe("a paired Workstation's bundle", () => {
    const PAIRED: HubWorkstation = { id: "ws-1234", name: "Studio", demo: false, summary: "", state: "ready", label: "Ready", openable: true };

    it("is readied before the view opens, saying what it is doing, and the view serves it by hash", async () => {
      const seen: string[] = [];
      const { native, visits } = setup({
        prepare: async (ws, say) => {
          expect(ws).toBe(PAIRED);
          say("Fetching its UI… 50%");
          await settle();
          seen.push(get(visits.state).status === "opening" ? String((get(visits.state) as { detail: string | null }).detail) : "?");
          say("Installing it…");
          return "ab".repeat(32);
        },
      });
      await visits.open(PAIRED);
      expect(seen).toEqual(["Fetching its UI… 50%"]);
      expect(native.view.open).toHaveBeenCalledWith({ session: sessionOf(native), workstation: "ws-1234", bundle: "ab".repeat(32) });
      expect(get(visits.state)).toEqual({ status: "open", workstation: PAIRED });
    });

    it("does not open when the bundle cannot be readied, and says why", async () => {
      const { native, visits } = setup({
        prepare: async () => {
          throw new Error("The Workstation's UI was signed by a key this Companion does not trust.");
        },
      });
      await visits.open(PAIRED);
      expect(native.view.open).not.toHaveBeenCalled();
      expect(get(visits.state)).toEqual({
        status: "failed",
        workstation: PAIRED,
        reason: "The Workstation's UI was signed by a key this Companion does not trust.",
      });
    });

    it("stops readying when the hub moves on, and opens nothing", async () => {
      let stopped = false;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const { native, visits } = setup({
        prepare: async (_ws, _say, signal) => {
          signal.addEventListener("abort", () => (stopped = true));
          await gate;
          return "ab".repeat(32);
        },
      });
      const opening = visits.open(PAIRED);
      await settle();
      expect(get(visits.state)).toEqual({ status: "opening", workstation: PAIRED, detail: null });
      await visits.close();
      expect(stopped).toBe(true);
      release();
      await opening;
      expect(native.view.open).not.toHaveBeenCalled();
      expect(get(visits.state)).toEqual({ status: "hub" });
    });

    it("hands the bundle where to land, once", async () => {
      const { native, visits } = setup({ prepare: async () => "demo" });
      const landing = { workspace: "w1", target: { kind: "card" as const, path: "/w1/.gavin-root/plans/a.md" } };
      await visits.open(DEMO_WORKSTATION, landing);
      const bundle = native.bundle(sessionOf(native));
      expect((await bundle.capabilities()).landing).toEqual(landing);
      const again = native.bundle(sessionOf(native));
      expect((await again.capabilities()).landing).toBeUndefined();
    });
  });

  it("keeps the demo moving while its bundle is open, and stops it after", async () => {
    const { native, visits, clock, demos } = setup();
    await visits.open(DEMO_WORKSTATION);
    const bundle = native.bundle(sessionOf(native));
    const seen: unknown[] = [];
    await bundle.listen("session-status-changed", (p) => seen.push(p));
    for (let i = 0; i < 8; i += 1) clock.tick();
    await settle();
    expect(seen.length).toBeGreaterThan(0);
    await visits.close();
    expect(clock.running()).toBe(0);
    expect(demos.length).toBe(1);
  });

  it("opens a link through the native view's system browser", async () => {
    const { native, visits } = setup();
    await visits.open(DEMO_WORKSTATION);
    const bundle = native.bundle(sessionOf(native));
    await expect(bundle.openExternal("https://gavin.dev")).resolves.toBe(true);
    expect(native.external).toEqual(["https://gavin.dev"]);
  });

  it("stops listening to the native view when disposed", async () => {
    const { native, visits } = setup();
    await visits.open(DEMO_WORKSTATION);
    expect(native.listeners()).toBe(3);
    await visits.dispose();
    expect(native.listeners()).toBe(0);
    expect(get(visits.state)).toEqual({ status: "hub" });
  });
});
