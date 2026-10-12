import { describe, it, expect } from "vitest";
import {
  MEMORY_SKIPPED_KEY,
  adoptIndexNotice,
  backfillWanted,
  loadMemorySkipped,
  memoryIndexReady,
  memoryPollFast,
  memoryStepDone,
  memoryStepSettled,
  memoryStepView,
  saveMemorySkipped,
  type MemoryIndexStatus,
  type MemoryReading,
} from "$lib/cards/memoryIndex";

function status(over: Partial<MemoryIndexStatus> = {}): MemoryIndexStatus {
  return { model: "absent", modelError: null, learned: 0, indexed: 0, inSync: true, ...over };
}
function reading(over: Partial<MemoryIndexStatus> = {}): MemoryReading {
  return { kind: "status", status: status(over) };
}

describe("memoryIndexReady", () => {
  it("needs the model AND an index that matches Learned", () => {
    expect(memoryIndexReady(status({ model: "ready", learned: 2, indexed: 2 }))).toBe(true);
    expect(memoryIndexReady(status({ model: "ready" }))).toBe(true);
    expect(memoryIndexReady(status({ model: "ready", learned: 2, indexed: 1, inSync: false }))).toBe(false);
    expect(memoryIndexReady(status({ model: "absent" }))).toBe(false);
    expect(memoryIndexReady(status({ model: "downloading" }))).toBe(false);
  });
});

describe("memoryStepDone / memoryStepSettled", () => {
  it("is done on a ready index, a not now, or a workspace the index cannot serve", () => {
    expect(memoryStepDone(reading({ model: "ready" }), false)).toBe(true);
    expect(memoryStepDone(reading(), true)).toBe(true);
    expect(memoryStepDone({ kind: "unavailable", reason: "ssh" }, false)).toBe(true);
  });

  it("is not done on an unknown reading, a failed ask or an old daemon", () => {
    expect(memoryStepDone(undefined, false)).toBe(false);
    expect(memoryStepDone({ kind: "error", message: "x" }, false)).toBe(false);
    expect(memoryStepDone({ kind: "blocked", reason: "x" }, false)).toBe(false);
  });

  it("is settled by any reading, or by not now with none", () => {
    expect(memoryStepSettled(undefined, false)).toBe(false);
    expect(memoryStepSettled(undefined, true)).toBe(true);
    expect(memoryStepSettled({ kind: "error", message: "x" }, false)).toBe(true);
  });
});

describe("backfillWanted", () => {
  it("brings up a workspace with memories the index does not match", () => {
    expect(backfillWanted(reading({ learned: 3 }), false)).toBe(true);
    expect(backfillWanted(reading({ model: "ready", learned: 3, indexed: 1, inSync: false }), false)).toBe(true);
    expect(backfillWanted(reading({ model: "failed", learned: 3 }), false)).toBe(true);
  });

  // The first download on a workspace with nothing adopted is the
  // Memory step's to offer, not a side effect of opening it.
  it("downloads nothing for a workspace with nothing adopted", () => {
    expect(backfillWanted(reading({ learned: 0 }), false)).toBe(false);
  });

  it("leaves alone what is ready, downloading, declined or unknown", () => {
    expect(backfillWanted(reading({ model: "ready", learned: 3, indexed: 3 }), false)).toBe(false);
    expect(backfillWanted(reading({ model: "downloading", learned: 3 }), false)).toBe(false);
    expect(backfillWanted(reading({ learned: 3 }), true)).toBe(false);
    expect(backfillWanted(undefined, false)).toBe(false);
    expect(backfillWanted({ kind: "error", message: "x" }, false)).toBe(false);
    expect(backfillWanted({ kind: "blocked", reason: "x" }, false)).toBe(false);
  });
});

describe("memoryPollFast", () => {
  it("polls only while the model downloads", () => {
    expect(memoryPollFast(reading({ model: "downloading" }))).toBe(true);
    expect(memoryPollFast(reading({ model: "ready" }))).toBe(false);
    expect(memoryPollFast(undefined)).toBe(false);
  });
});

describe("memoryStepView", () => {
  it("offers the download where there is no model, naming what is adopted", () => {
    const v = memoryStepView(reading({ learned: 1 }));
    expect(v.label).toBe("Not set up");
    expect(v.action).toBe("Download and build the index");
    expect(v.line).toContain("1 adopted memory.");
  });

  it("offers a rebuild for a stale index and nothing for a ready one", () => {
    const stale = memoryStepView(reading({ model: "ready", learned: 3, indexed: 2, inSync: false }));
    expect(stale.action).toBe("Build the index");
    expect(stale.line).toContain("2 of 3 adopted memories");
    const ready = memoryStepView(reading({ model: "ready", learned: 3, indexed: 3 }));
    expect(ready).toMatchObject({ label: "Ready", tone: "on", action: null });
    expect(ready.line).toContain("gavin_search_memories");
  });

  it("is busy while downloading and says why a download failed", () => {
    expect(memoryStepView(reading({ model: "downloading" }))).toMatchObject({ busy: true, action: null });
    const failed = memoryStepView(reading({ model: "failed", modelError: "offline" }));
    expect(failed.line).toContain("offline");
    expect(failed.action).toBe("Try again");
  });

  it("never offers a download it cannot run", () => {
    expect(memoryStepView(undefined).action).toBeNull();
    expect(memoryStepView({ kind: "blocked", reason: "Needs daemon v60" })).toMatchObject({
      action: null,
      line: "Needs daemon v60",
    });
    expect(memoryStepView({ kind: "unavailable", reason: "ssh" }).action).toBeNull();
  });
});

describe("adoptIndexNotice", () => {
  it("says the adopt happened and the next search heals", () => {
    const line = adoptIndexNotice("disk full");
    expect(line.startsWith("Adopted.")).toBe(true);
    expect(line).toContain("disk full");
    expect(line).toContain("next search");
  });
});

describe("the not now mark", () => {
  function memoryStorage() {
    const items = new Map<string, string>();
    return {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
      items,
    };
  }

  it("is per root and can be taken back", () => {
    const s = memoryStorage();
    saveMemorySkipped("/a", true, s);
    saveMemorySkipped("/b", true, s);
    expect(loadMemorySkipped("/a", s)).toBe(true);
    expect(loadMemorySkipped("/c", s)).toBe(false);
    saveMemorySkipped("/a", false, s);
    expect(loadMemorySkipped("/a", s)).toBe(false);
    expect(loadMemorySkipped("/b", s)).toBe(true);
  });

  it("reads corrupt or missing storage as not declined, and never throws", () => {
    const s = memoryStorage();
    s.items.set(MEMORY_SKIPPED_KEY, "{not json");
    expect(loadMemorySkipped("/a", s)).toBe(false);
    expect(loadMemorySkipped("/a", undefined)).toBe(false);
    const refusing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadMemorySkipped("/a", refusing)).toBe(false);
    expect(() => saveMemorySkipped("/a", true, refusing)).not.toThrow();
  });
});
