import { describe, it, expect, vi, beforeEach } from "vitest";
import { writable } from "svelte/store";

// The write half of the develop lock: the record that goes down when a
// run starts, and the sweep that takes it back up when the run ends. The
// sweep is the half with the worse failure -- a card locked by an agent
// that finished hours ago is worse than no lock at all, and nothing else
// in the app would notice.

vi.mock("$lib/layoutState", () => {
  const layoutState = writable({
    workspaces: [
      { id: "ws-1", developingCards: undefined as unknown },
      { id: "ws-2", developingCards: undefined as unknown },
    ],
    sessionStatusById: {} as Record<string, string>,
    interruptedSessionIds: new Set<string>(),
    failureReasonById: {} as Record<string, string>,
  });
  return {
    layoutState,
    // The real one persists to config.json and writes the store back;
    // here it only has to do the second half, or the sweep would re-read
    // the records it just cleared and never terminate.
    setDevelopingCards: vi.fn(async (workspaceId: string, records: unknown[]) => {
      layoutState.update((s) => ({
        ...s,
        workspaces: s.workspaces.map((w) =>
          w.id === workspaceId
            ? { ...w, developingCards: records.length > 0 ? records : undefined }
            : w
        ),
      }));
    }),
  };
});

vi.mock("$lib/workspace", () => ({ sessionLiveness: vi.fn(() => "live") }));

const { layoutState, setDevelopingCards } = await import("$lib/layoutState");
const { sessionLiveness } = await import("$lib/workspace");
const {
  developingBlocker,
  developingCardsIn,
  developingRunOn,
  recordDevelopingCard,
  startDevelopingCardsWatch,
  __resetForTesting,
} = await import("$lib/cards/developingCardsState");

const PATH = "/ws/.gavin-root/plans/thin.md";

function seed(workspaceId: string, records: { path: string; sessionId: string }[]): void {
  layoutState.update((s) => ({
    ...s,
    workspaces: s.workspaces.map((w) =>
      w.id === workspaceId ? { ...w, developingCards: records } : w
    ),
  }));
}

function status(map: Record<string, string>): void {
  layoutState.update((s) => ({ ...s, sessionStatusById: map as never }));
}

beforeEach(() => {
  __resetForTesting();
  vi.clearAllMocks();
  vi.mocked(sessionLiveness).mockReturnValue("live" as never);
  layoutState.update((s) => ({
    ...s,
    workspaces: s.workspaces.map((w) => ({ ...w, developingCards: undefined })),
    sessionStatusById: {},
  }));
});

describe("recording a run", () => {
  it("adds it, and replaces an earlier run on the same card rather than doubling it", async () => {
    await recordDevelopingCard("ws-1", { path: PATH, sessionId: "s-1" });
    await recordDevelopingCard("ws-1", { path: "/ws/.gavin-root/plans/b.md", sessionId: "s-2" });
    await recordDevelopingCard("ws-1", { path: PATH, sessionId: "s-3" });

    expect(developingCardsIn("ws-1")).toEqual([
      { path: "/ws/.gavin-root/plans/b.md", sessionId: "s-2" },
      { path: PATH, sessionId: "s-3" },
    ]);
  });

  it("is one workspace's business", async () => {
    await recordDevelopingCard("ws-1", { path: PATH, sessionId: "s-1" });

    expect(developingRunOn("ws-1", PATH)).toEqual({ path: PATH, sessionId: "s-1" });
    expect(developingRunOn("ws-2", PATH)).toBeNull();
    expect(developingBlocker("ws-2", PATH)).toBeNull();
    expect(developingBlocker("ws-1", PATH)).toContain("developing this card");
  });
});

describe("the sweep", () => {
  it("frees a card whose develop session has left the layout", async () => {
    seed("ws-1", [{ path: PATH, sessionId: "s-dev" }]);
    vi.mocked(sessionLiveness).mockReturnValue("gone" as never);

    startDevelopingCardsWatch();
    // The subscription fires on subscribe, so the first pass runs over
    // whatever the records already were -- which is also how a run that
    // outlived the last window gets adopted or written off at startup.
    await vi.waitFor(() => expect(setDevelopingCards).toHaveBeenCalledWith("ws-1", []));
    expect(developingRunOn("ws-1", PATH)).toBeNull();
  });

  it("frees a card whose agent went idle: for a one-shot request that is the finish line", async () => {
    seed("ws-1", [{ path: PATH, sessionId: "s-dev" }]);
    status({ "s-dev": "idle" });

    startDevelopingCardsWatch();

    await vi.waitFor(() => expect(developingRunOn("ws-1", PATH)).toBeNull());
  });

  // The two states a develop run spends its life in. Freeing the card in
  // either is the bug: `undefined` is the daemon having said nothing yet
  // (it only pushes on a change), and `waiting_for_input` is the
  // interview the whole action exists for.
  it("leaves a live run alone whether it is working, silent, or asking the human", async () => {
    for (const s of ["working", "waiting_for_input", undefined]) {
      seed("ws-1", [{ path: PATH, sessionId: "s-dev" }]);
      status(s ? { "s-dev": s } : {});

      const stop = startDevelopingCardsWatch();
      await Promise.resolve();
      expect(developingRunOn("ws-1", PATH), String(s)).not.toBeNull();
      stop();
    }
  });

  it("frees only the runs that are over, and leaves the rest of the list intact", async () => {
    seed("ws-1", [
      { path: PATH, sessionId: "s-done" },
      { path: "/ws/.gavin-root/plans/b.md", sessionId: "s-live" },
    ]);
    status({ "s-done": "idle", "s-live": "working" });

    startDevelopingCardsWatch();

    await vi.waitFor(() =>
      expect(developingCardsIn("ws-1")).toEqual([
        { path: "/ws/.gavin-root/plans/b.md", sessionId: "s-live" },
      ])
    );
  });

  it("stops looking once it is stopped", async () => {
    const stop = startDevelopingCardsWatch();
    // The positive control first, so the assertion below is about the
    // teardown rather than about a watch that never worked.
    seed("ws-1", [{ path: PATH, sessionId: "s-first" }]);
    status({ "s-first": "idle" });
    await vi.waitFor(() => expect(developingRunOn("ws-1", PATH)).toBeNull());
    // Drained before the teardown: a pass already in flight replays once
    // more after a re-entrant write, and it is allowed to finish -- the
    // watch is what stops, not the pass.
    await new Promise((resolve) => setTimeout(resolve, 0));

    stop();
    vi.mocked(setDevelopingCards).mockClear();
    seed("ws-1", [{ path: PATH, sessionId: "s-dev" }]);
    status({ "s-dev": "idle" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setDevelopingCards).not.toHaveBeenCalled();
    expect(developingRunOn("ws-1", PATH)).not.toBeNull();
  });
});
