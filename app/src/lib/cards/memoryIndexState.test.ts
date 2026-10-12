import { beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { FEATURE_MIN_VERSION, type DaemonCompat } from "$lib/core/daemonCompat";
import type { MemoryIndexStatus, MemoryReading } from "$lib/cards/memoryIndex";

vi.mock("$lib/core/backend", () => ({
  getMemoryIndex: vi.fn(),
  ensureMemoryIndex: vi.fn(),
}));

vi.mock("$lib/core/layoutState", async () => {
  const { writable } = await import("svelte/store");
  return {
    daemonCompat: writable(null),
    layoutState: writable({ status: "loading", workspaces: [] }),
  };
});

import * as backend from "$lib/core/backend";
import { daemonCompat, layoutState } from "$lib/core/layoutState";
import {
  backfillRoot,
  memoryReadings,
  readMemoryIndex,
  startMemoryBackfill,
  syncAfterAdopt,
  type BackfillDeps,
} from "$lib/cards/memoryIndexState";

const NEEDED = FEATURE_MIN_VERSION.memoryIndex;

function compatAt(daemonVersion: number): DaemonCompat {
  return { daemonVersion, appVersion: NEEDED, degraded: false };
}

function status(over: Partial<MemoryIndexStatus> = {}): MemoryIndexStatus {
  return { model: "absent", modelError: null, learned: 0, indexed: 0, inSync: true, ...over };
}

const STALE: MemoryReading = {
  kind: "status",
  status: status({ model: "ready", learned: 3, indexed: 1, inSync: false }),
};

function deps(over: Partial<BackfillDeps> = {}): BackfillDeps & { ensure: ReturnType<typeof vi.fn> } {
  return {
    compat: compatAt(NEEDED),
    skipped: () => false,
    read: vi.fn().mockResolvedValue(STALE),
    ensure: vi.fn().mockResolvedValue({ kind: "status", status: status({ model: "ready", learned: 3, indexed: 3 }) }),
    ...over,
  } as BackfillDeps & { ensure: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readMemoryIndex", () => {
  it("asks nothing before a daemon is connected", async () => {
    const ask = vi.fn();
    expect(await readMemoryIndex(null, ask)).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });

  // FEATURE_MIN_VERSION.memoryIndex's consumer: an older daemon is a
  // settled reading that names the version, never a wire error drawn as
  // a missing model.
  it("settles on the version it needs against an older daemon, without asking", async () => {
    const ask = vi.fn();
    const r = await readMemoryIndex(compatAt(NEEDED - 1), ask);
    expect(r?.kind).toBe("blocked");
    expect(r?.kind === "blocked" && r.reason).toContain(`v${NEEDED}`);
    expect(ask).not.toHaveBeenCalled();
  });

  it("carries a failed ask as an error reading", async () => {
    const r = await readMemoryIndex(compatAt(NEEDED), () => Promise.reject(new Error("gone")));
    expect(r).toEqual({ kind: "error", message: "gone" });
  });
});

describe("backfillRoot", () => {
  it("brings a stale index up when the workspace opens", async () => {
    const d = deps();
    expect(await backfillRoot("/ws", d)).toBe("ensured");
    expect(d.ensure).toHaveBeenCalledWith("/ws");
  });

  it("leaves a ready index, an empty workspace and a declined one alone", async () => {
    for (const d of [
      deps({ read: vi.fn().mockResolvedValue({ kind: "status", status: status({ model: "ready", learned: 2, indexed: 2 }) }) }),
      deps({ read: vi.fn().mockResolvedValue({ kind: "status", status: status() }) }),
      deps({ skipped: () => true }),
    ]) {
      expect(await backfillRoot("/ws", d)).toBe("none");
      expect(d.ensure).not.toHaveBeenCalled();
    }
  });

  it("asks nothing of a daemon that cannot answer", async () => {
    for (const compat of [null, compatAt(NEEDED - 1)]) {
      const d = deps({ compat });
      expect(await backfillRoot("/ws", d)).toBe("none");
      expect(d.read).not.toHaveBeenCalled();
    }
  });

  // A failed backfill is a reading the Memory step shows, not a
  // workspace that refuses to open.
  it("never throws, whatever the daemon does", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(backfillRoot("/ws", deps({ read: vi.fn().mockRejectedValue(new Error("x")) }))).resolves.toBe("none");
    await expect(backfillRoot("/ws", deps({ ensure: vi.fn().mockRejectedValue(new Error("offline")) }))).resolves.toBe(
      "ensured"
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("offline"));
    warn.mockRestore();
  });
});

describe("startMemoryBackfill", () => {
  it("backfills each local workspace once per connection, and skips ssh ones", async () => {
    vi.mocked(backend.getMemoryIndex).mockResolvedValue(STALE.kind === "status" ? STALE.status : status());
    vi.mocked(backend.ensureMemoryIndex).mockResolvedValue(status({ model: "ready", learned: 3, indexed: 3 }));
    daemonCompat.set(compatAt(NEEDED));
    const stop = startMemoryBackfill();
    layoutState.set({
      status: "ready",
      workspaces: [
        { id: "a", rootPath: "/a" },
        { id: "b", rootPath: "/b", ssh: { host: "box" } },
        { id: "c", rootPath: "" },
      ],
    } as never);
    await vi.waitFor(() => expect(backend.ensureMemoryIndex).toHaveBeenCalledWith("/a", true));
    // Another emission of the same list asks nothing new.
    layoutState.update((s) => ({ ...s }));
    await new Promise((r) => setTimeout(r, 0));
    expect(backend.getMemoryIndex).toHaveBeenCalledTimes(1);
    expect(backend.getMemoryIndex).not.toHaveBeenCalledWith("/b");
    expect(get(memoryReadings)["/a"]).toEqual({
      kind: "status",
      status: status({ model: "ready", learned: 3, indexed: 3 }),
    });
    stop();
  });
});

describe("syncAfterAdopt", () => {
  const ready = status({ model: "ready", learned: 1, indexed: 1 });

  it("indexes the new fact and says nothing when it worked", async () => {
    const ensure = vi.fn().mockResolvedValue(ready);
    expect(await syncAfterAdopt("/ws", { compat: compatAt(NEEDED), ensure, status: vi.fn() })).toBeNull();
    // Never a download: Adopt is not where the model is offered.
    expect(ensure).toHaveBeenCalledWith("/ws", false);
  });

  it("is silent with no index to update yet: an older daemon, or no model", async () => {
    const ensure = vi.fn().mockRejectedValue(new Error("not downloaded"));
    expect(await syncAfterAdopt("/ws", { compat: compatAt(NEEDED - 1), ensure, status: vi.fn() })).toBeNull();
    expect(ensure).not.toHaveBeenCalled();
    const absent = vi.fn().mockResolvedValue(status());
    expect(await syncAfterAdopt("/ws", { compat: compatAt(NEEDED), ensure, status: absent })).toBeNull();
  });

  it("surfaces a real failure as a note that the adopt still happened", async () => {
    const ensure = vi.fn().mockRejectedValue(new Error("disk full"));
    const note = await syncAfterAdopt("/ws", {
      compat: compatAt(NEEDED),
      ensure,
      status: vi.fn().mockResolvedValue(ready),
    });
    expect(note).toContain("Adopted.");
    expect(note).toContain("disk full");
  });
});
