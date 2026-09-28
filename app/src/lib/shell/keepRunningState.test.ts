import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get, writable } from "svelte/store";

const eventMock = vi.hoisted(() => {
  const handlers = new Map<string, Array<(event: { payload: unknown }) => void>>();
  return {
    handlers,
    listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== handler));
    }),
    fire(name: string, payload: unknown): void {
      for (const handler of handlers.get(name) ?? []) handler({ payload });
    },
  };
});

vi.mock("@tauri-apps/api/event", () => ({ listen: eventMock.listen }));

const backendMock = vi.hoisted(() => ({
  listDevices: vi.fn(),
  setSleepHold: vi.fn(async (_hold: boolean) => {}),
}));

vi.mock("$lib/core/backend", () => backendMock);

// Only the two stores the hold reads, as plain writables: the real
// modules pull in the whole app.
const stores = vi.hoisted(() => ({
  layout: null as unknown as ReturnType<typeof writable<{ sessionStatusById: Record<string, string> }>>,
  agents: null as unknown as ReturnType<typeof writable<Record<string, unknown>>>,
}));

vi.mock("$lib/core/layoutState", async () => {
  const { writable } = await import("svelte/store");
  stores.layout = writable({ sessionStatusById: {} });
  return { layoutState: stores.layout };
});

vi.mock("$lib/agents/memoryState", async () => {
  const { writable } = await import("svelte/store");
  stores.agents = writable({});
  return { agentSessions: stores.agents };
});

import { initRemoteAccess, remoteAccessEnabled, startSleepHold } from "$lib/shell/keepRunningState";
import { SLEEP_HOLD_LINGER_MS } from "$lib/shell/keepRunning";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function devices(remoteAccessEnabled: boolean) {
  return { devices: [], remoteAccessEnabled, relayUrl: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  eventMock.handlers.clear();
  remoteAccessEnabled.set(null);
  stores.layout.set({ sessionStatusById: {} });
  stores.agents.set({});
});

describe("the remote-access switch", () => {
  it("is read from the daemon at start", async () => {
    backendMock.listDevices.mockResolvedValue(devices(true));
    await initRemoteAccess();
    expect(get(remoteAccessEnabled)).toBe(true);
  });

  it("follows the host's push when Settings moves it in any window", async () => {
    backendMock.listDevices.mockResolvedValue(devices(false));
    await initRemoteAccess();
    eventMock.fire("remote-access-changed", true);
    expect(get(remoteAccessEnabled)).toBe(true);
    eventMock.fire("remote-access-changed", false);
    expect(get(remoteAccessEnabled)).toBe(false);
  });

  // The read may have been served before the change was written.
  it("drops a read that answers after a change was heard", async () => {
    const read = deferred<ReturnType<typeof devices>>();
    backendMock.listDevices.mockReturnValue(read.promise);
    const started = initRemoteAccess();
    await Promise.resolve();
    eventMock.fire("remote-access-changed", true);
    read.resolve(devices(false));
    await started;
    expect(get(remoteAccessEnabled)).toBe(true);
  });

  it("stays unknown when the daemon cannot answer", async () => {
    backendMock.listDevices.mockRejectedValue(new Error("daemon too old"));
    await initRemoteAccess();
    expect(get(remoteAccessEnabled)).toBeNull();
  });
});

describe("the idle-sleep hold", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function sent(): boolean[] {
    return backendMock.setSleepHold.mock.calls.map(([hold]) => hold);
  }

  function running(status: string): void {
    stores.agents.set({ a: {} });
    stores.layout.set({ sessionStatusById: { a: status } });
  }

  it("is taken while remote access is on and an agent is running", () => {
    const stop = startSleepHold();
    remoteAccessEnabled.set(true);
    running("working");
    stop();
    expect(sent()).toEqual([false, true]);
  });

  it("counts an agent stopped on a question as running", () => {
    const stop = startSleepHold();
    remoteAccessEnabled.set(true);
    running("waiting_for_input");
    stop();
    expect(sent()).toEqual([false, true]);
  });

  it("is not taken with remote access off, however busy the agents", () => {
    const stop = startSleepHold();
    remoteAccessEnabled.set(false);
    running("working");
    stop();
    expect(sent()).toEqual([false]);
  });

  it("is not taken for a busy shell", () => {
    const stop = startSleepHold();
    remoteAccessEnabled.set(true);
    stores.layout.set({ sessionStatusById: { shell: "working" } });
    stop();
    expect(sent()).toEqual([false]);
  });

  it("outlives the last running agent by the linger, then goes", () => {
    const stop = startSleepHold();
    remoteAccessEnabled.set(true);
    running("working");
    running("idle");
    vi.advanceTimersByTime(SLEEP_HOLD_LINGER_MS - 1);
    expect(sent()).toEqual([false, true]);
    vi.advanceTimersByTime(1);
    expect(sent()).toEqual([false, true, false]);
    stop();
  });

  // A rail's next step starting inside the linger: the hold never drops.
  it("is kept when an agent starts again inside the linger", () => {
    const stop = startSleepHold();
    remoteAccessEnabled.set(true);
    running("working");
    running("idle");
    vi.advanceTimersByTime(SLEEP_HOLD_LINGER_MS / 2);
    running("working");
    vi.advanceTimersByTime(SLEEP_HOLD_LINGER_MS);
    expect(sent()).toEqual([false, true]);
    stop();
  });

  it("goes at once when remote access is turned off, linger or not", () => {
    const stop = startSleepHold();
    remoteAccessEnabled.set(true);
    running("working");
    running("idle");
    remoteAccessEnabled.set(false);
    expect(sent()).toEqual([false, true, false]);
    vi.advanceTimersByTime(SLEEP_HOLD_LINGER_MS);
    expect(sent()).toEqual([false, true, false]);
    stop();
  });

  // layoutState emits on every status change of every session; the host
  // hears only the answer moving.
  it("tells the host only when the answer changes", () => {
    const stop = startSleepHold();
    remoteAccessEnabled.set(true);
    stores.agents.set({ a: {}, b: {} });
    stores.layout.set({ sessionStatusById: { a: "working" } });
    stores.layout.set({ sessionStatusById: { a: "working", b: "working" } });
    stores.layout.set({ sessionStatusById: { a: "idle", b: "working" } });
    stop();
    expect(sent()).toEqual([false, true]);
  });

  // The duty moving to another window must not let the Mac sleep: the
  // new holder's hold and this one's stop arrive in no promised order.
  it("releases nothing when it stops, and its linger dies with it", () => {
    remoteAccessEnabled.set(true);
    running("working");
    const stop = startSleepHold();
    running("idle");
    stop();
    vi.advanceTimersByTime(SLEEP_HOLD_LINGER_MS);
    expect(sent()).toEqual([true]);
  });

  it("re-sends its answer when it starts again, as a new holder must", () => {
    remoteAccessEnabled.set(true);
    running("working");
    startSleepHold()();
    startSleepHold()();
    expect(sent()).toEqual([true, true]);
  });

  it("clears a hold the last holder left, as its first answer", () => {
    remoteAccessEnabled.set(true);
    const stop = startSleepHold();
    stop();
    expect(sent()).toEqual([false]);
  });
});
