import { describe, it, expect, vi, beforeEach } from "vitest";
import { get, writable } from "svelte/store";
import type { DaemonCompat } from "$lib/core/daemonCompat";
import type { QueuedInput } from "$lib/agents/queuedInput";

vi.mock("$lib/core/backend", () => ({
  queueInput: vi.fn(),
  setQueuedInputs: vi.fn(),
  sendQueuedInput: vi.fn(),
}));

// The three things queuedInputActions reads from layoutState. The store
// is the real writable rather than a stub so the "applied optimistically"
// assertions below are about the map the strip actually renders from.
vi.mock("$lib/core/layoutState", () => {
  const queuedInputsById = writable<Record<string, QueuedInput[]>>({});
  return {
    daemonCompat: writable(null as DaemonCompat | null),
    queuedInputsById,
    handleQueuedInputsChanged: (sessionId: string, queued: QueuedInput[]) =>
      queuedInputsById.update((s) => {
        if (queued.length === 0) {
          const next = { ...s };
          delete next[sessionId];
          return next;
        }
        return { ...s, [sessionId]: queued };
      }),
  };
});

import * as backend from "$lib/core/backend";
import { daemonCompat, queuedInputsById } from "$lib/core/layoutState";
import {
  cancelFollowUp,
  moveFollowUp,
  queueFollowUp,
  queueTargetFor,
  queueFor,
  sendFollowUpNow,
} from "$lib/agents/queuedInputActions";

function entry(id: string, text = `message ${id}`): QueuedInput {
  return { id, sessionId: "s-1", text, createdAtUs: 1_000 };
}

function seed(...ids: string[]): void {
  queuedInputsById.set({ "s-1": ids.map((id) => entry(id)) });
}

beforeEach(() => {
  vi.clearAllMocks();
  queuedInputsById.set({});
  daemonCompat.set(null);
  vi.mocked(backend.setQueuedInputs).mockResolvedValue([]);
  vi.mocked(backend.sendQueuedInput).mockResolvedValue([]);
  vi.mocked(backend.queueInput).mockResolvedValue([]);
});

describe("queueTargetFor", () => {
  it("is ungated before the app has connected", () => {
    // null compat means "no verdict yet", and pre-emptively greying the
    // compose box on startup would be the wrong default.
    expect(queueTargetFor("working", false).blockedReason).toBeNull();
  });

  it("carries the version reason once the daemon is known to be older", () => {
    daemonCompat.set({ daemonVersion: 25, appVersion: 29, degraded: true });
    expect(queueTargetFor("working", false).blockedReason).toContain("v29");
  });
});

describe("queueFor", () => {
  it("reads an absent session as an empty queue, not as undefined", () => {
    expect(queueFor("nobody")).toEqual([]);
  });
});

describe("queueFollowUp", () => {
  it("sends the trimmed text and applies the queue that comes back", async () => {
    vi.mocked(backend.queueInput).mockResolvedValue([entry("q1", "run the tests")]);

    expect(await queueFollowUp("s-1", queueTargetFor("working", false), "  run the tests\n")).toBeNull();

    expect(backend.queueInput).toHaveBeenCalledWith("s-1", "run the tests");
    // Applied here as well as by the push: the push goes to the ATTACHED
    // writer, and the strip has to be right for the human looking at it
    // in the window before that arrives.
    expect(get(queuedInputsById)["s-1"].map((q) => q.id)).toEqual(["q1"]);
  });

  it("refuses before the request rather than after it", async () => {
    daemonCompat.set({ daemonVersion: 25, appVersion: 29, degraded: true });

    const err = await queueFollowUp("s-1", queueTargetFor("working", false), "run the tests");

    expect(err).toContain("v29");
    // The failure this guards: a box that takes the text, reports
    // nothing, and never delivers it.
    expect(backend.queueInput).not.toHaveBeenCalled();
  });

  it("reports a daemon refusal instead of swallowing it", async () => {
    vi.mocked(backend.queueInput).mockRejectedValue(new Error("unknown session: s-1"));

    expect(await queueFollowUp("s-1", queueTargetFor("working", false), "hi")).toContain(
      "unknown session"
    );
  });
});

describe("moveFollowUp", () => {
  it("writes the whole surviving order", async () => {
    seed("a", "b", "c");

    expect(await moveFollowUp("s-1", "c", -1)).toBeNull();

    expect(backend.setQueuedInputs).toHaveBeenCalledWith("s-1", ["a", "c", "b"]);
  });

  it("does not write for a move off the end", async () => {
    seed("a", "b");

    expect(await moveFollowUp("s-1", "a", -1)).toBeNull();

    // SetQueuedInputs pushes to everyone attached, so a no-op write
    // repaints the strip under the human's cursor to say nothing changed.
    expect(backend.setQueuedInputs).not.toHaveBeenCalled();
  });

  it("does not write for an entry the daemon already delivered", async () => {
    seed("a", "b");

    expect(await moveFollowUp("s-1", "gone", 1)).toBeNull();

    expect(backend.setQueuedInputs).not.toHaveBeenCalled();
  });
});

describe("cancelFollowUp", () => {
  it("writes the list without that entry", async () => {
    seed("a", "b", "c");

    expect(await cancelFollowUp("s-1", "b")).toBeNull();

    expect(backend.setQueuedInputs).toHaveBeenCalledWith("s-1", ["a", "c"]);
  });

  it("empties the map when the last entry goes", async () => {
    seed("a");

    await cancelFollowUp("s-1", "a");

    expect(backend.setQueuedInputs).toHaveBeenCalledWith("s-1", []);
    expect("s-1" in get(queuedInputsById)).toBe(false);
  });

  it("does not write for an entry that is already gone", async () => {
    seed("a");

    expect(await cancelFollowUp("s-1", "b")).toBeNull();

    expect(backend.setQueuedInputs).not.toHaveBeenCalled();
  });

  it("reports a refused write", async () => {
    seed("a");
    vi.mocked(backend.setQueuedInputs).mockRejectedValue(new Error("no such session"));

    expect(await cancelFollowUp("s-1", "a")).toContain("no such session");
  });
});

describe("sendFollowUpNow", () => {
  it("overrides the delivery rules the automatic path obeys", async () => {
    seed("a");
    // `waiting_for_input` is a status the daemon never delivers into, and
    // the whole point of this button is that the human has decided
    // otherwise.
    expect(await sendFollowUpNow("s-1", queueTargetFor("waiting_for_input", false), "a")).toBeNull();

    expect(backend.sendQueuedInput).toHaveBeenCalledWith("s-1", "a");
  });

  it("still refuses an interrupted session", async () => {
    seed("a");
    // What is in that tab is a shell; the message would be run as a
    // command, and nobody is watching.
    const err = await sendFollowUpNow("s-1", queueTargetFor("idle", true), "a");

    expect(err).toContain("Relaunch the agent");
    expect(backend.sendQueuedInput).not.toHaveBeenCalled();
  });

  it("still refuses against a daemon that cannot carry the request", async () => {
    seed("a");
    daemonCompat.set({ daemonVersion: 25, appVersion: 29, degraded: true });

    expect(await sendFollowUpNow("s-1", queueTargetFor("idle", false), "a")).toContain("v29");
    expect(backend.sendQueuedInput).not.toHaveBeenCalled();
  });

  it("passes the daemon's own words through when the entry has just been delivered", async () => {
    seed("a");
    vi.mocked(backend.sendQueuedInput).mockRejectedValue(
      new Error("that follow-up is no longer queued — it may have just been delivered")
    );

    expect(await sendFollowUpNow("s-1", queueTargetFor("working", false), "a")).toContain(
      "no longer queued"
    );
  });
});
