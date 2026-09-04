import { describe, it, expect } from "vitest";
import {
  indexQueued,
  moveQueued,
  withoutQueued,
  composeRefusal,
  queueBlockedReason,
  INTERRUPTED_REASON,
  deliveryHold,
  stripVisible,
  queueCountLabel,
  previewLine,
  queuedAgeLabel,
  entryTip,
  shouldQueueForMainAgent,
  type QueuedInput,
  type QueueTarget,
} from "./queuedInput";

const NOW = 1_700_000_000_000;

function entry(id: string, over: Partial<QueuedInput> = {}): QueuedInput {
  return {
    id,
    sessionId: "s-1",
    text: `message ${id}`,
    createdAtUs: NOW * 1000,
    ...over,
  };
}

function target(over: Partial<QueueTarget> = {}): QueueTarget {
  return { status: "working", interrupted: false, blockedReason: null, ...over };
}

describe("indexQueued", () => {
  it("groups by session and keeps the daemon's order within each group", () => {
    const all = [
      entry("a", { sessionId: "s-1" }),
      entry("b", { sessionId: "s-2" }),
      entry("c", { sessionId: "s-1" }),
    ];
    expect(indexQueued(all)).toEqual({
      "s-1": [all[0], all[2]],
      "s-2": [all[1]],
    });
  });

  it("never reorders by timestamp — a reorder makes the two disagree", () => {
    // `c` was written first and dragged to the front; position, not
    // createdAtUs, is what the daemon replays.
    const dragged = [
      entry("c", { createdAtUs: (NOW - 60_000) * 1000 }),
      entry("a", { createdAtUs: NOW * 1000 }),
    ];
    expect(indexQueued(dragged)["s-1"].map((q) => q.id)).toEqual(["c", "a"]);
  });

  it("is an empty map for an empty reply", () => {
    expect(indexQueued([])).toEqual({});
  });
});

describe("moveQueued", () => {
  const queue = [entry("a"), entry("b"), entry("c")];

  it("moves an entry later and earlier", () => {
    expect(moveQueued(queue, "a", 1)).toEqual(["b", "a", "c"]);
    expect(moveQueued(queue, "c", -1)).toEqual(["a", "c", "b"]);
  });

  it("moves further than one place", () => {
    expect(moveQueued(queue, "a", 2)).toEqual(["b", "c", "a"]);
  });

  it("is null off either end, so no pointless write repaints the strip", () => {
    expect(moveQueued(queue, "a", -1)).toBeNull();
    expect(moveQueued(queue, "c", 1)).toBeNull();
  });

  it("is null for an entry the queue no longer holds", () => {
    // The delivery fired between the render and the click. Writing the
    // list the stale render implies would resurrect an order that has
    // stopped existing.
    expect(moveQueued(queue, "gone", -1)).toBeNull();
  });
});

describe("withoutQueued", () => {
  it("drops the named entry and keeps the rest in order", () => {
    expect(withoutQueued([entry("a"), entry("b"), entry("c")], "b")).toEqual(["a", "c"]);
  });

  it("empties a one-item queue", () => {
    expect(withoutQueued([entry("a")], "a")).toEqual([]);
  });

  it("is null when the entry is already gone", () => {
    expect(withoutQueued([entry("a")], "b")).toBeNull();
  });
});

describe("queueBlockedReason", () => {
  it("is null for a session that can take a follow-up", () => {
    expect(queueBlockedReason(target())).toBeNull();
  });

  it("says nothing about empty text — it is not asked about text at all", () => {
    // The button that OPENS the composer reads this: withholding the box
    // you would write in is not a way to say "write something in it".
    expect(queueBlockedReason(target())).toBeNull();
    expect(composeRefusal(target(), "")).not.toBeNull();
  });

  it("leads with the version gate, then the interrupted tab", () => {
    const both = target({ blockedReason: "Needs daemon v29.", interrupted: true });
    expect(queueBlockedReason(both)).toContain("v29");
    expect(queueBlockedReason(target({ interrupted: true }))).toBe(INTERRUPTED_REASON);
  });
});

describe("composeRefusal", () => {
  it("accepts a real message for a busy session", () => {
    expect(composeRefusal(target(), "run the tests too")).toBeNull();
  });

  it("refuses empty and whitespace-only text", () => {
    expect(composeRefusal(target(), "")).toContain("Write the follow-up");
    expect(composeRefusal(target(), "  \n ")).toContain("Write the follow-up");
  });

  it("leads with the version gate — the queue never reaches the wire", () => {
    const blocked = target({ blockedReason: "Needs daemon v29; the running daemon is v25." });
    expect(composeRefusal(blocked, "run the tests too")).toContain("v29");
    // Even with nothing typed: the fixable answer is the useful one.
    expect(composeRefusal(blocked, "")).toContain("v29");
  });

  it("refuses outright on an interrupted session rather than holding", () => {
    // `interrupted` is never cleared and a relaunch mints a new session
    // id, so a follow-up queued here waits for an idle that cannot come.
    const reason = composeRefusal(target({ interrupted: true }), "carry on");
    expect(reason).toContain("Relaunch the agent");
  });
});

describe("deliveryHold", () => {
  it("says nothing when nothing is queued", () => {
    expect(deliveryHold(target(), 0)).toBeNull();
    expect(deliveryHold(target({ interrupted: true }), 0)).toBeNull();
  });

  it("names the ordinary wait for a working agent", () => {
    expect(deliveryHold(target({ status: "working" }), 2)).toContain("finish its turn");
  });

  it("explains that a question is not answered with a follow-up", () => {
    const hold = deliveryHold(target({ status: "waiting_for_input" }), 1);
    expect(hold).toContain("asking you something");
  });

  it("says a failed session drains nothing, and names the two ways out", () => {
    const hold = deliveryHold(target({ status: "failed" }), 1) ?? "";
    expect(hold).toContain("send it now");
    expect(hold).toContain("cancel");
  });

  it("distinguishes one delivery from a queue that drains a turn at a time", () => {
    expect(deliveryHold(target({ status: "idle" }), 1)).toBe("Delivering now.");
    expect(deliveryHold(target({ status: "idle" }), 3)).toContain("one turn at a time");
  });

  it("puts the stranded-queue reason above every status", () => {
    const stranded = target({ interrupted: true, status: "idle" });
    expect(deliveryHold(stranded, 2)).toContain("Relaunch the agent");
  });

  it("falls back to a plain wait for a status it has not heard", () => {
    expect(deliveryHold(target({ status: undefined }), 1)).toBe("Waiting for the agent.");
  });
});

describe("stripVisible", () => {
  it("is absent from an idle terminal with nothing queued", () => {
    expect(stripVisible(target({ status: "idle" }), 0, false)).toBe(false);
    expect(stripVisible(target({ status: undefined }), 0, false)).toBe(false);
  });

  it("appears while the agent is mid-turn or mid-question", () => {
    expect(stripVisible(target({ status: "working" }), 0, false)).toBe(true);
    expect(stripVisible(target({ status: "waiting_for_input" }), 0, false)).toBe(true);
  });

  it("appears whenever something is queued, whatever the session is doing", () => {
    expect(stripVisible(target({ status: "idle" }), 1, false)).toBe(true);
    expect(stripVisible(target({ status: "failed" }), 1, false)).toBe(true);
  });

  it("stays up for a queue stranded on an interrupted session", () => {
    // Cancelling is the only thing that clears it, so it has to be
    // reachable.
    expect(stripVisible(target({ interrupted: true }), 2, false)).toBe(true);
  });

  it("does not offer itself on an interrupted session with an empty queue", () => {
    expect(stripVisible(target({ interrupted: true, status: "working" }), 0, false)).toBe(false);
  });

  it("appears once the human opens the composer", () => {
    expect(stripVisible(target({ status: "idle" }), 0, true)).toBe(true);
  });
});

describe("queueCountLabel", () => {
  it("counts, and is silent at zero", () => {
    expect(queueCountLabel(0)).toBeNull();
    expect(queueCountLabel(1)).toBe("1 follow-up queued");
    expect(queueCountLabel(4)).toBe("4 follow-ups queued");
  });
});

describe("previewLine", () => {
  it("takes the first non-blank line and collapses its whitespace", () => {
    expect(previewLine("\n\n  run   the tests  \nthen commit")).toBe("run the tests");
  });

  it("cuts long text with an ellipsis and no trailing space", () => {
    expect(previewLine("a".repeat(200), 10)).toBe(`${"a".repeat(9)}…`);
    expect(previewLine(`${"b".repeat(9)} tail`, 10)).toBe(`${"b".repeat(9)}…`);
  });

  it("keeps text that already fits", () => {
    expect(previewLine("short", 10)).toBe("short");
  });

  it("is empty for a message that is only whitespace", () => {
    expect(previewLine("   \n  ")).toBe("");
  });
});

describe("queuedAgeLabel", () => {
  const us = (msAgo: number) => (NOW - msAgo) * 1000;

  it("is coarse, and never hedges a duration the daemon measured", () => {
    expect(queuedAgeLabel(us(5_000), NOW)).toBe("just now");
    expect(queuedAgeLabel(us(4 * 60_000), NOW)).toBe("4m");
    expect(queuedAgeLabel(us(3 * 3_600_000), NOW)).toBe("3h");
    expect(queuedAgeLabel(us(2 * 86_400_000), NOW)).toBe("2d");
  });

  it("rounds a backwards clock away rather than inventing a future", () => {
    expect(queuedAgeLabel(us(-60_000), NOW)).toBe("just now");
  });
});

describe("entryTip", () => {
  it("carries the whole message the preview had to cut, plus the age", () => {
    const long = entry("a", { text: "line one\nline two", createdAtUs: (NOW - 4 * 60_000) * 1000 });
    const tip = entryTip(long, NOW);
    expect(tip).toContain("line one\nline two");
    expect(tip).toContain("Queued 4m ago");
  });
});

describe("shouldQueueForMainAgent", () => {
  it("queues for an agent that is mid-turn or mid-question", () => {
    expect(shouldQueueForMainAgent("working")).toBe(true);
    expect(shouldQueueForMainAgent("waiting_for_input")).toBe(true);
  });

  it("keeps today's paste everywhere else, including a status it never heard", () => {
    expect(shouldQueueForMainAgent("idle")).toBe(false);
    expect(shouldQueueForMainAgent("failed")).toBe(false);
    expect(shouldQueueForMainAgent("unknown")).toBe(false);
    expect(shouldQueueForMainAgent(undefined)).toBe(false);
  });
});
