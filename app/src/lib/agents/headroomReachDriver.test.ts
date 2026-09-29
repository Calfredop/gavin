import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import type { SessionStatus } from "$lib/core/notifications";

// The driver's entry point is a listener it hands to layoutState. The mock
// captures it, so the tests drive the feature the way the daemon does:
// "this session is idle now, and it was working a moment ago".
const captured = vi.hoisted(() => ({
  listener: null as
    | ((sessionId: string, status: SessionStatus, previousStatus: SessionStatus | undefined) => void)
    | null,
  removed: 0,
}));

vi.mock("$lib/core/backend", () => ({
  headroomReach: vi.fn(),
}));

vi.mock("$lib/core/layoutState", async () => {
  const { writable: w } = await import("svelte/store");
  return {
    daemonCompat: w(null),
    addSessionStatusListener: vi.fn((listener) => {
      captured.listener = listener;
      return () => {
        captured.listener = null;
        captured.removed += 1;
      };
    }),
  };
});

vi.mock("$lib/board/kanbanState", async () => {
  const { writable: w } = await import("svelte/store");
  return { kanbanState: w({} as Record<string, unknown>) };
});

vi.mock("$lib/orchestration/orchestrationState", async () => {
  const { writable: w } = await import("svelte/store");
  return { orchestrations: w({} as Record<string, unknown>) };
});

import * as backend from "$lib/core/backend";
import { daemonCompat } from "$lib/core/layoutState";
import { kanbanState } from "$lib/board/kanbanState";
import { orchestrations } from "$lib/orchestration/orchestrationState";
import { headroomException } from "$lib/agents/headroomMark";
import {
  __resetForTesting as resetMarks,
  noteReopenedConversation,
  noteSessionCompression,
  sessionCompressionById,
} from "$lib/agents/headroomMarkState";
import { __resetForTesting, reachCheckBlocked, startHeadroomReach } from "$lib/agents/headroomReachDriver";

const reach = vi.mocked(backend.headroomReach);

/// A card run bound to `id`.
function cardRun(id: string): void {
  kanbanState.set({
    "ws-1": { columns: [], labels: [], cardSessions: [{ path: "/ws/plans/a.md", sessionId: id, cwd: "/ws", command: null }] },
  } as never);
}

/// A rail step running `id`.
function stepRun(id: string): void {
  orchestrations.set({
    "ws-1": { rails: [], stepRuns: [{ stepId: "t1", state: "running", sessionId: id }], railRuns: [], conflictNotes: [] },
  } as never);
}

function compressed(id: string): void {
  noteSessionCompression(id, { compressed: true, uncompressedReason: null });
}

/// The transition the daemon calls the end of a turn.
function turnEnds(id: string): void {
  captured.listener?.(id, "idle", "working");
}

/// Lets the ask's promise settle.
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function markOf(id: string) {
  return headroomException(get(sessionCompressionById)[id], true);
}

let stop: (() => void) | null = null;

beforeEach(() => {
  __resetForTesting();
  resetMarks();
  reach.mockReset();
  kanbanState.set({});
  orchestrations.set({});
  daemonCompat.set({ daemonVersion: 50, appVersion: 50, degraded: false } as never);
  captured.removed = 0;
  stop = startHeadroomReach();
});

afterEach(() => {
  stop?.();
  stop = null;
});

describe("a compressed run whose turn ends", () => {
  // The acceptance case: Headroom has seen nothing tagged with the
  // session's id, and the process it was pointed at would have.
  it("is marked not reaching Headroom when Headroom has seen none of its requests", async () => {
    cardRun("s1");
    compressed("s1");
    reach.mockResolvedValue("unreached");

    turnEnds("s1");
    await settled();

    expect(reach).toHaveBeenCalledWith("s1");
    expect(get(sessionCompressionById).s1.reach).toBe("unreached");
    expect(markOf("s1")).toBe("not-reaching");
  });

  it("carries no mark when Headroom has seen its requests, and is not asked again", async () => {
    stepRun("s1");
    compressed("s1");
    reach.mockResolvedValue("reached");

    turnEnds("s1");
    await settled();
    expect(markOf("s1")).toBeNull();

    turnEnds("s1");
    await settled();
    expect(reach).toHaveBeenCalledTimes(1);
  });

  // Asked at the next turn too, and a later finding clears the mark: the
  // mark is about what is true, not what was once found.
  it("loses the mark once a later turn finds it reaching Headroom", async () => {
    cardRun("s1");
    compressed("s1");
    reach.mockResolvedValueOnce("unreached").mockResolvedValueOnce("reached");

    turnEnds("s1");
    await settled();
    expect(markOf("s1")).toBe("not-reaching");

    turnEnds("s1");
    await settled();
    expect(markOf("s1")).toBeNull();
  });

  // Headroom not answering, restarted since, or holding as many sessions
  // as it will: nothing can be told, so nothing is marked.
  it("is not marked when the daemon cannot tell, and a failed ask marks nothing either", async () => {
    cardRun("s1");
    compressed("s1");
    reach.mockResolvedValueOnce("unknown").mockRejectedValueOnce(new Error("daemon gone"));

    turnEnds("s1");
    await settled();
    turnEnds("s1");
    await settled();

    expect(reach).toHaveBeenCalledTimes(2);
    expect(markOf("s1")).toBeNull();
  });
});

describe("what is never asked about", () => {
  it("a terminal the human opened", async () => {
    compressed("s1");
    turnEnds("s1");
    await settled();
    expect(reach).not.toHaveBeenCalled();
  });

  it("a session that was not compressed", async () => {
    cardRun("s1");
    noteSessionCompression("s1", { compressed: false, uncompressedReason: "not-ready" });
    turnEnds("s1");
    await settled();
    expect(reach).not.toHaveBeenCalled();
  });

  it("a session going quiet that was not working", async () => {
    cardRun("s1");
    compressed("s1");
    captured.listener?.("s1", "idle", "waiting_for_input");
    captured.listener?.("s1", "working", "idle");
    await settled();
    expect(reach).not.toHaveBeenCalled();
  });

  // Resume reopens the conversation without a prompt: what goes quiet
  // first is its history being painted. The turn after that is a turn.
  it("the first quiet of a reopened conversation, and only the first", async () => {
    cardRun("s1");
    compressed("s1");
    noteReopenedConversation("s1");
    reach.mockResolvedValue("unreached");

    turnEnds("s1");
    await settled();
    expect(reach).not.toHaveBeenCalled();

    turnEnds("s1");
    await settled();
    expect(reach).toHaveBeenCalledTimes(1);
  });

  it("anything, against a daemon older than v50", async () => {
    daemonCompat.set({ daemonVersion: 49, appVersion: 50, degraded: true } as never);
    expect(reachCheckBlocked()).toMatch(/v50/);
    cardRun("s1");
    compressed("s1");
    turnEnds("s1");
    await settled();
    expect(reach).not.toHaveBeenCalled();
  });
});

describe("the teardown", () => {
  it("stops listening, and drops an answer still in flight", async () => {
    cardRun("s1");
    compressed("s1");
    let answer!: (word: string) => void;
    reach.mockReturnValue(new Promise((resolve) => (answer = resolve)));

    turnEnds("s1");
    stop?.();
    stop = null;
    answer("unreached");
    await settled();

    expect(captured.removed).toBe(1);
    expect(get(sessionCompressionById).s1.reach).toBeNull();
  });
});
