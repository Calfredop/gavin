import { describe, it, expect, vi } from "vitest";

vi.mock("$lib/core/backend", () => ({ headroomSavings: vi.fn() }));

import { readHeadroomSavings } from "$lib/agents/headroomSavingsState";
import type { DaemonCompat } from "$lib/core/daemonCompat";
import type { RunSavings } from "$lib/agents/headroomSavings";

function compat(daemonVersion: number): DaemonCompat {
  return { daemonVersion, appVersion: 49, degraded: daemonVersion < 49 };
}

const RUN: RunSavings = {
  workspaceId: "ws-a",
  path: "/a/plans/t.md",
  sessionId: "s-1",
  startedAt: 10,
  endedAt: 20,
  tokensSaved: 1_000,
  requests: 4,
};

describe("readHeadroomSavings", () => {
  it("asks the daemon for every snapshot since the window began", async () => {
    const ask = vi.fn(async () => [RUN]);
    expect(await readHeadroomSavings(compat(49), 1_000, ask)).toEqual([RUN]);
    expect(ask).toHaveBeenCalledWith(1_000);
  });

  it("does not ask a daemon too old to have taken snapshots", async () => {
    // It would refuse the request on every tick of the hub's poll.
    const ask = vi.fn(async () => [RUN]);
    expect(await readHeadroomSavings(compat(48), 1_000, ask)).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });

  it("does not ask before there is a daemon, or a window to ask about", async () => {
    const ask = vi.fn(async () => [RUN]);
    expect(await readHeadroomSavings(null, 1_000, ask)).toBeUndefined();
    expect(await readHeadroomSavings(compat(49), null, ask)).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });

  it("keeps a failed read from reading as a fleet that saved nothing", async () => {
    const ask = vi.fn(async () => {
      throw new Error("daemon went away");
    });
    expect(await readHeadroomSavings(compat(49), 1_000, ask)).toBeUndefined();
  });
});
