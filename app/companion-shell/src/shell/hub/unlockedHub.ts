// The Unlock and the live hub, wired to what the phone has: the native
// Unlock (`DeviceKeys`), its lifecycle events, the Companion core and the
// webview's WebSocket.
//
// The rules are the pure modules' (`unlock/unlock.ts` for when to ask and
// when to drop, `hub/liveHub.ts` for the connections); this runs them.
// The native side ends its Unlock on background and lock by itself; the
// events it sends are how this layer hears of it, and drops every
// connection.
import { writable, type Readable } from "svelte/store";
import type { PluginListenerHandle } from "@capacitor/core";
import { askAttention } from "$shell/connection/attention";
import { connect, type Connection, type ConnectionKeys } from "$shell/connection/connection";
import type { CoreModule } from "$shell/core/core";
import { errorCode } from "$shell/keys/deviceKeys";
import type { LiveState } from "$shell/hub/live";
import { createLiveHub, type LiveHubDeps } from "$shell/hub/liveHub";
import type { PairedWorkstation } from "$shell/hub/paired";
import type { LifecyclePhase, UnlockPlugin } from "$shell/native/deviceKeys";
import type { OpenRelaySocket } from "$shell/pairing/relaySocket";
import {
  connectionsAllowed,
  INITIAL_UNLOCK,
  stepUnlock,
  UNLOCK_REASON,
  type UnlockEvent,
  type UnlockState,
} from "$shell/unlock/unlock";
import type { ConnectionSource } from "$shell/visit/workstationEndpoint";

export type UnlockKeys = ConnectionKeys & Pick<UnlockPlugin, "unlock" | "lock" | "unlockState" | "addListener">;

export interface UnlockedHubDeps {
  keys: UnlockKeys;
  core: () => Promise<CoreModule>;
  open: OpenRelaySocket;
  random(length: number): Uint8Array;
  log?(line: string): void;
  /// The live hub's clock and timers, for tests.
  hub?: Partial<Pick<LiveHubDeps, "now" | "after" | "pollMs" | "reconnect" | "tryNowGapMs">>;
}

export interface UnlockedHub {
  readonly unlock: Readable<UnlockState>;
  readonly live: Readable<Record<string, LiveState>>;
  setPaired(records: PairedWorkstation[]): void;
  /// The human pressed Unlock.
  requestUnlock(): void;
  /// The human tapped a Workstation that is not ready: try it now.
  tryNow(id: string): void;
  /// Where a visit to a Workstation gets its connection: the one this
  /// hub holds to it, as it comes and goes (companion-23).
  connectionSource(id: string): ConnectionSource;
  /// Starts listening to the app's lifecycle, and asks at once if the app
  /// is in front with something to unlock.
  start(): Promise<void>;
  dispose(): Promise<void>;
}

export function createUnlockedHub(deps: UnlockedHubDeps): UnlockedHub {
  const unlock = writable<UnlockState>(INITIAL_UNLOCK);
  const live = writable<Record<string, LiveState>>({});
  let state: UnlockState = INITIAL_UNLOCK;
  const now = deps.hub?.now ?? (() => Date.now());
  let paired = false;
  let disposed = false;
  let listening: PluginListenerHandle | null = null;
  /// What was last logged for each Workstation, so a log says changes.
  const logged = new Map<string, string>();
  /// Who hears a Workstation's connection come and go, by id.
  const connectionListeners = new Map<string, Set<(connection: Connection | null) => void>>();

  const hub = createLiveHub({
    connect: async (target, signal) => {
      let core: CoreModule;
      try {
        core = await deps.core();
      } catch (e) {
        return { outcome: "failed", problem: `This Companion could not start its core: ${e instanceof Error ? e.message : String(e)}` };
      }
      return connect(target, { core, keys: deps.keys, open: deps.open, random: deps.random, signal });
    },
    ask: (connection) => askAttention(connection),
    now,
    after:
      deps.hub?.after ??
      ((ms, fn) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      }),
    pollMs: deps.hub?.pollMs,
    reconnect: deps.hub?.reconnect,
    tryNowGapMs: deps.hub?.tryNowGapMs,
    onChange: (snapshot) => {
      for (const [id, now] of Object.entries(snapshot)) {
        const was = logged.get(id);
        const line = now.state === "ready" ? `ready, ${now.items.length} waiting` : now.state;
        if (was !== line) deps.log?.(`[gavin-hub] ${id}: ${line}`);
        logged.set(id, line);
      }
      live.set(snapshot);
    },
    onConnection: (id, connection) => {
      for (const listener of [...(connectionListeners.get(id) ?? [])]) listener(connection);
    },
    onNotHeld: () => dispatch({ type: "not-held" }),
    onLapsed: () => dispatch({ type: "lapsed" }),
    log: deps.log,
  });

  function dispatch(event: UnlockEvent): void {
    if (disposed) return;
    const step = stepUnlock(state, event, { paired, now: now() });
    if (step.state !== state) deps.log?.(`[gavin-unlock] ${event.type}: ${describe(state)} -> ${describe(step.state)}`);
    state = step.state;
    unlock.set(state);
    for (const action of step.actions) {
      switch (action) {
        case "prompt":
          void prompt();
          break;
        case "connect":
          hub.setAllowed(true);
          break;
        case "refresh":
          hub.refresh();
          break;
        case "disconnect":
          hub.setAllowed(false);
          // The native side ends it on background and lock by itself;
          // this covers every other way it ends.
          void deps.keys.lock().catch(() => {});
          break;
      }
    }
    if (!connectionsAllowed(state)) hub.setAllowed(false);
  }

  async function prompt(): Promise<void> {
    try {
      await deps.keys.unlock({ reason: UNLOCK_REASON });
    } catch (e) {
      const code = errorCode(e);
      if (code === "cancelled") dispatch({ type: "prompt-declined" });
      else if (code === "background") {
        dispatch({ type: "prompt-declined" });
        dispatch({ type: "background" });
      } else if (code === "no-keys") {
        dispatch({ type: "prompt-failed", problem: "this phone no longer holds its Device keys. Pair again." });
      } else {
        dispatch({ type: "prompt-failed", problem: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    dispatch({ type: "prompt-succeeded" });
  }

  const PHASES: Record<LifecyclePhase, UnlockEvent> = {
    foreground: { type: "foreground" },
    background: { type: "background" },
    "screen-locked": { type: "screen-locked" },
  };

  return {
    unlock: { subscribe: unlock.subscribe },
    live: { subscribe: live.subscribe },

    setPaired(records) {
      paired = records.length > 0;
      hub.setPaired(records);
    },

    requestUnlock: () => dispatch({ type: "unlock-requested" }),

    tryNow: (id) => hub.tryNow(id),

    connectionSource: (id) => ({
      current: () => hub.connectionOf(id),
      subscribe(listener) {
        const set = connectionListeners.get(id) ?? new Set();
        set.add(listener);
        connectionListeners.set(id, set);
        return () => {
          set.delete(listener);
          if (set.size === 0) connectionListeners.delete(id);
        };
      },
    }),

    async start() {
      listening = await deps.keys.addListener("lifecycle", (e) => {
        const event = PHASES[e.phase];
        if (event) dispatch(event);
      });
      // A page that starts again (a reload) starts from locked: whatever
      // the native side still held is let go, and asked for afresh.
      await deps.keys.lock().catch(() => {});
      const { foreground } = await deps.keys.unlockState().catch(() => ({ foreground: false }));
      if (foreground) dispatch({ type: "foreground" });
    },

    async dispose() {
      disposed = true;
      hub.dispose();
      await listening?.remove();
    },
  };
}

function describe(state: UnlockState): string {
  return state.state === "locked" ? `locked (${state.why})` : state.state === "unlocking" && state.renewing ? "renewing" : state.state;
}
