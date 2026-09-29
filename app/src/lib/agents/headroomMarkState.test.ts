import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  __resetForTesting,
  noteHeadroomReach,
  noteReopenedConversation,
  noteSessionCompression,
  seedSessionCompression,
  sessionCompressionById,
  isAwaitingFirstSubmit,
  noteInputSubmitted,
} from "$lib/agents/headroomMarkState";

beforeEach(() => __resetForTesting());

describe("what the host says about a session it created", () => {
  it("is kept, and is the newest word there is", () => {
    noteSessionCompression("s1", { compressed: true, uncompressedReason: null });
    noteSessionCompression("s1", { compressed: false, uncompressedReason: "headroom-failed" });
    expect(get(sessionCompressionById).s1).toEqual({
      compressed: false,
      uncompressedReason: "headroom-failed",
      reach: null,
    });
  });
});

describe("the baselines a reload reads", () => {
  it("fill in what a reload missed", () => {
    seedSessionCompression([
      { id: "s1", compressed: true, uncompressedReason: null, headroomReach: "unreached" },
      { id: "s2", compressed: false, uncompressedReason: "not-ready", headroomReach: null },
    ]);
    expect(get(sessionCompressionById)).toEqual({
      s1: { compressed: true, uncompressedReason: null, reach: "unreached" },
      s2: { compressed: false, uncompressedReason: "not-ready", reach: null },
    });
  });

  // A push that landed is newer than the snapshot, the rule every
  // baseline follows.
  it("never overwrite what a push already said", () => {
    noteSessionCompression("s1", { compressed: false, uncompressedReason: "headroom-failed" });
    seedSessionCompression([{ id: "s1", compressed: true, uncompressedReason: null }]);
    expect(get(sessionCompressionById).s1.uncompressedReason).toBe("headroom-failed");
  });

  // A host older than v50 sends none of the three.
  it("read an older host's baseline as nothing to mark", () => {
    seedSessionCompression([{ id: "s1" }]);
    expect(get(sessionCompressionById).s1).toEqual({ compressed: false, uncompressedReason: null, reach: null });
  });
});

describe("what a turn found", () => {
  it("lands on a session the host told us about", () => {
    noteSessionCompression("s1", { compressed: true, uncompressedReason: null });
    noteHeadroomReach("s1", "unreached");
    expect(get(sessionCompressionById).s1.reach).toBe("unreached");
  });

  it("changes nothing when it could not be told", () => {
    noteSessionCompression("s1", { compressed: true, uncompressedReason: null });
    noteHeadroomReach("s1", "unreached");
    noteHeadroomReach("s1", "unknown");
    expect(get(sessionCompressionById).s1.reach).toBe("unreached");
  });

  it("invents no session", () => {
    noteHeadroomReach("s9", "unreached");
    expect(get(sessionCompressionById).s9).toBeUndefined();
  });
});

describe("a reopened conversation", () => {
  it("stays reopened through any number of quiets, until a line is submitted", () => {
    noteReopenedConversation("s1");
    expect(isAwaitingFirstSubmit("s1")).toBe(true);
    expect(isAwaitingFirstSubmit("s1")).toBe(true);
    expect(isAwaitingFirstSubmit("s2")).toBe(false);
    noteInputSubmitted("s1");
    expect(isAwaitingFirstSubmit("s1")).toBe(false);
  });

});
