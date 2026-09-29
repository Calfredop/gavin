import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get, writable } from "svelte/store";
import type { DaemonCompat } from "$lib/core/daemonCompat";
import { FEATURE_MIN_VERSION } from "$lib/core/daemonCompat";

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));

vi.mock("$lib/core/backend", () => ({
  getHeadroomDefault: vi.fn(),
  setHeadroomWorkspaces: vi.fn(),
}));

vi.mock("$lib/core/layoutState", async () => {
  const { writable } = await import("svelte/store");
  return {
    layoutState: writable({ status: "connecting", workspaces: [] }),
    headroomDefault: writable(null),
    headroomDefaultKnown: writable(false),
    daemonCompat: writable(null),
  };
});

import * as backend from "$lib/core/backend";
import {
  daemonCompat,
  headroomDefault,
  headroomDefaultKnown,
  layoutState,
} from "$lib/core/layoutState";
import {
  compressionPush,
  compressionSwitchBlocked,
  initCompression,
  startCompressionSwitch,
  type CompressionPushInput,
} from "./compressionDriver";

const NEEDED = FEATURE_MIN_VERSION.compressedLaunch;

function compatAt(daemonVersion: number): DaemonCompat {
  return { daemonVersion, appVersion: NEEDED, degraded: daemonVersion < NEEDED };
}

const ON = { rootPath: "/work/on", headroom: true };
const OFF = { rootPath: "/work/off", headroom: false };
const INHERITS = { rootPath: "/work/inherits" };

function input(over: Partial<CompressionPushInput> = {}): CompressionPushInput {
  return {
    ready: true,
    workspaces: [ON, OFF, INHERITS],
    appDefault: null,
    defaultKnown: true,
    compat: compatAt(NEEDED),
    told: null,
    ...over,
  };
}

describe("compressionPush", () => {
  it("tells the daemon what every workspace comes to", () => {
    expect(compressionPush(input())?.list).toEqual([
      { workspacePath: "/work/inherits", enabled: false },
      { workspacePath: "/work/off", enabled: false },
      { workspacePath: "/work/on", enabled: true },
    ]);
  });

  // The list REPLACES the daemon's copy. One resolved before the
  // workspaces loaded says nothing is on, and the daemon would stop the
  // Headroom every running agent is talking through.
  it("says nothing until the workspaces have loaded", () => {
    expect(compressionPush(input({ ready: false, workspaces: [] }))).toBeNull();
    expect(compressionPush(input({ ready: false }))).toBeNull();
  });

  it("says nothing until the app-wide default has been read", () => {
    // Null is "nobody chose" only once somebody has looked.
    expect(compressionPush(input({ defaultKnown: false }))).toBeNull();
    expect(compressionPush(input({ defaultKnown: false, appDefault: true }))).toBeNull();
  });

  it("says nothing with no daemon to tell", () => {
    expect(compressionPush(input({ compat: null }))).toBeNull();
  });

  it("says nothing to a daemon too old to hold a copy", () => {
    expect(compressionPush(input({ compat: compatAt(NEEDED - 1) }))).toBeNull();
    expect(compressionPush(input({ compat: compatAt(NEEDED) }))).not.toBeNull();
    expect(compressionPush(input({ compat: compatAt(NEEDED + 1) }))).not.toBeNull();
  });

  it("says nothing the daemon has already been told", () => {
    const first = compressionPush(input());
    expect(first).not.toBeNull();

    expect(compressionPush(input({ told: first?.key ?? null }))).toBeNull();
    expect(
      compressionPush(input({ told: first?.key ?? null, workspaces: [...input().workspaces].reverse() })),
    ).toBeNull();
    expect(compressionPush(input({ told: first?.key ?? null, appDefault: true }))?.list).toContainEqual({
      workspacePath: "/work/inherits",
      enabled: true,
    });
  });

  // The last workspace was closed: a real answer, and the one that lets
  // the daemon stop Headroom.
  it("tells the daemon an empty list once the workspaces have loaded empty", () => {
    expect(compressionPush(input({ workspaces: [] }))).toEqual({ list: [], key: "[]" });
    expect(compressionPush(input({ workspaces: [], told: "[]" }))).toBeNull();
  });
});

describe("compressionSwitchBlocked", () => {
  it("names both versions against an older daemon, and nothing otherwise", () => {
    const reason = compressionSwitchBlocked(compatAt(NEEDED - 1));
    expect(reason).toContain(`v${NEEDED}`);
    expect(reason).toContain(`v${NEEDED - 1}`);
    expect(compressionSwitchBlocked(compatAt(NEEDED))).toBeNull();
    expect(compressionSwitchBlocked(null)).toBeNull();
  });
});

/// Lets the driver's awaits run.
async function settled(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function loaded(workspaces: object[]): void {
  (layoutState as ReturnType<typeof writable>).set({ status: "ready", workspaces });
}

function told(): unknown[] {
  return vi.mocked(backend.setHeadroomWorkspaces).mock.calls.map(([list]) => list);
}

describe("the driver", () => {
  // A driver left running by a test that failed before its own `stop()`
  // would answer the next test's emissions as well.
  const running: (() => void)[] = [];
  const start = () => {
    const stop = startCompressionSwitch();
    running.push(stop);
    return stop;
  };
  afterEach(() => {
    for (const stop of running.splice(0)) stop();
  });

  beforeEach(() => {
    vi.mocked(backend.setHeadroomWorkspaces).mockReset().mockResolvedValue({} as never);
    vi.mocked(backend.getHeadroomDefault).mockReset().mockResolvedValue(null);
    listeners.clear();
    (layoutState as ReturnType<typeof writable>).set({ status: "connecting", workspaces: [] });
    headroomDefault.set(null);
    headroomDefaultKnown.set(false);
    daemonCompat.set(null);
  });

  it("waits for the workspaces, the default and the daemon, then tells once", async () => {
    const stop = start();
    await settled();
    expect(told()).toEqual([]);

    daemonCompat.set(compatAt(NEEDED));
    loaded([ON, INHERITS]);
    await settled();
    expect(told(), "the default has not been read").toEqual([]);

    headroomDefaultKnown.set(true);
    await settled();

    expect(told()).toEqual([
      [
        { workspacePath: "/work/inherits", enabled: false },
        { workspacePath: "/work/on", enabled: true },
      ],
    ]);
    stop();
  });

  it("tells again when a workspace's switch moves, and not for anything else", async () => {
    daemonCompat.set(compatAt(NEEDED));
    headroomDefaultKnown.set(true);
    loaded([ON, INHERITS]);
    const stop = start();
    await settled();
    expect(told()).toHaveLength(1);

    // A tab opened, a page renamed, a status changed.
    loaded([{ ...ON, name: "renamed" }, { ...INHERITS, pages: [{ id: "p1" }] }]);
    await settled();
    expect(told()).toHaveLength(1);

    loaded([{ ...ON, headroom: false }, INHERITS]);
    await settled();

    expect(told()).toHaveLength(2);
    expect(told()[1]).toEqual([
      { workspacePath: "/work/inherits", enabled: false },
      { workspacePath: "/work/on", enabled: false },
    ]);
    stop();
  });

  it("re-resolves every inheriting workspace when the app-wide default moves", async () => {
    daemonCompat.set(compatAt(NEEDED));
    headroomDefaultKnown.set(true);
    loaded([OFF, INHERITS]);
    const stop = start();
    await settled();

    headroomDefault.set(true);
    await settled();

    expect(told().at(-1)).toEqual([
      { workspacePath: "/work/inherits", enabled: true },
      { workspacePath: "/work/off", enabled: false },
    ]);
    stop();
  });

  it("sends nothing to a daemon too old to hold a copy", async () => {
    daemonCompat.set(compatAt(NEEDED - 1));
    headroomDefaultKnown.set(true);
    loaded([ON]);
    const stop = start();
    await settled();

    loaded([{ ...ON, headroom: false }]);
    await settled();

    expect(backend.setHeadroomWorkspaces).not.toHaveBeenCalled();
    stop();
  });

  // The daemon that answers after a restart may be a newer build with no
  // copy of its own.
  it("tells a new connection from the start", async () => {
    daemonCompat.set(compatAt(NEEDED - 1));
    headroomDefaultKnown.set(true);
    loaded([ON]);
    const stop = start();
    await settled();
    expect(told()).toEqual([]);

    daemonCompat.set(compatAt(NEEDED));
    await settled();
    expect(told()).toHaveLength(1);

    daemonCompat.set(compatAt(NEEDED));
    await settled();

    expect(told()).toHaveLength(2);
    expect(told()[1]).toEqual(told()[0]);
    stop();
  });

  it("tries again after a push the daemon did not take", async () => {
    vi.mocked(backend.setHeadroomWorkspaces).mockRejectedValue(new Error("daemon went away"));
    daemonCompat.set(compatAt(NEEDED));
    headroomDefaultKnown.set(true);
    loaded([ON]);
    const stop = start();
    await settled();
    const refused = told().length;
    expect(refused).toBeGreaterThan(0);

    // Any emission: the list is unchanged, and still untold.
    vi.mocked(backend.setHeadroomWorkspaces).mockResolvedValue({} as never);
    loaded([{ ...ON, name: "renamed" }]);
    await settled();

    expect(told()).toHaveLength(refused + 1);
    expect(told().at(-1)).toEqual(told()[0]);

    loaded([{ ...ON, name: "renamed again" }]);
    await settled();
    expect(told(), "told now, so not again").toHaveLength(refused + 1);
    stop();
  });

  it("sends a change that arrived mid-push once that push has landed", async () => {
    let land: () => void = () => {};
    vi.mocked(backend.setHeadroomWorkspaces).mockImplementationOnce(
      () => new Promise((resolve) => (land = () => resolve({} as never))),
    );
    daemonCompat.set(compatAt(NEEDED));
    headroomDefaultKnown.set(true);
    loaded([ON]);
    const stop = start();
    await settled();
    expect(told()).toHaveLength(1);

    loaded([{ ...ON, headroom: false }]);
    await settled();
    expect(told(), "one push at a time").toHaveLength(1);

    land();
    await settled();

    expect(told()).toHaveLength(2);
    expect(told()[1]).toEqual([{ workspacePath: "/work/on", enabled: false }]);
    stop();
  });

  it("stops telling once it is stopped", async () => {
    daemonCompat.set(compatAt(NEEDED));
    headroomDefaultKnown.set(true);
    loaded([ON]);
    const stop = start();
    await settled();
    stop();

    loaded([{ ...ON, headroom: false }]);
    await settled();

    expect(told()).toHaveLength(1);
  });
});

describe("initCompression", () => {
  beforeEach(() => {
    vi.mocked(backend.getHeadroomDefault).mockReset();
    listeners.clear();
    headroomDefault.set(null);
    headroomDefaultKnown.set(false);
  });

  it("reads the default and marks it known", async () => {
    vi.mocked(backend.getHeadroomDefault).mockResolvedValue(true);

    await initCompression();

    expect(get(headroomDefault)).toBe(true);
    expect(get(headroomDefaultKnown)).toBe(true);
  });

  it("knows a default nobody chose from one nobody has read", async () => {
    vi.mocked(backend.getHeadroomDefault).mockResolvedValue(null);

    await initCompression();

    expect(get(headroomDefault)).toBeNull();
    expect(get(headroomDefaultKnown)).toBe(true);
  });

  it("leaves the default unknown when it could not be read", async () => {
    vi.mocked(backend.getHeadroomDefault).mockRejectedValue(new Error("no host"));

    await initCompression();

    expect(get(headroomDefaultKnown)).toBe(false);
  });

  it("reads a garbled value as nobody having chosen", async () => {
    vi.mocked(backend.getHeadroomDefault).mockResolvedValue("on" as never);

    await initCompression();

    expect(get(headroomDefault)).toBeNull();
    expect(get(headroomDefaultKnown)).toBe(true);
  });

  it("takes another window's change, and drops a read that answers after it", async () => {
    let answer: (value: boolean | null) => void = () => {};
    vi.mocked(backend.getHeadroomDefault).mockImplementation(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const started = initCompression();
    await settled();

    listeners.get("headroom-default-changed")?.({ payload: true });
    // Served before that change was written.
    answer(false);
    await started;

    expect(get(headroomDefault)).toBe(true);
    expect(get(headroomDefaultKnown)).toBe(true);
  });
});
