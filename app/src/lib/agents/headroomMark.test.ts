import { describe, it, expect } from "vitest";
import {
  headroomException,
  parseReach,
  reachCheckDue,
  sessionCompressionFrom,
  withReach,
  type ReachCheckInput,
  type SessionCompression,
} from "$lib/agents/headroomMark";

const COMPRESSED: SessionCompression = { compressed: true, uncompressedReason: null, reach: null };

function uncompressed(reason: string | null): SessionCompression {
  return { compressed: false, uncompressedReason: reason, reach: null };
}

describe("headroomException", () => {
  it("marks the three exceptions and names which one", () => {
    expect(headroomException(uncompressed("not-ready"), true)).toBe("not-ready");
    expect(headroomException(uncompressed("headroom-failed"), true)).toBe("relaunched");
    expect(headroomException({ ...COMPRESSED, reach: "unreached" }, true)).toBe("not-reaching");
  });

  // A badge on every compressed tab would be noise: in a compressed
  // workspace that is every agent tab.
  it("marks nothing on a compressed session, asked about or not", () => {
    expect(headroomException(COMPRESSED, true)).toBeNull();
    expect(headroomException({ ...COMPRESSED, reach: "reached" }, true)).toBeNull();
  });

  // Uncompressed by design, and Settings says so beside the agent's row.
  // Marking every Cursor tab would be the same noise.
  it("marks nothing for an agent that is never compressed, or a shell", () => {
    expect(headroomException(uncompressed("unsupported-agent"), true)).toBeNull();
    expect(headroomException(uncompressed("no-recipe"), true)).toBeNull();
    expect(headroomException(uncompressed(null), true)).toBeNull();
  });

  it("marks nothing for a reason this build does not know", () => {
    expect(headroomException(uncompressed("daemon-too-old"), true)).toBeNull();
  });

  // The exception is about a workspace that ASKED for compression, as it
  // asks now: a switch turned off since the launch has asked for exactly
  // what the session is.
  it("marks nothing in a workspace without compression on", () => {
    expect(headroomException(uncompressed("not-ready"), false)).toBeNull();
    expect(headroomException(uncompressed("headroom-failed"), false)).toBeNull();
    expect(headroomException({ ...COMPRESSED, reach: "unreached" }, false)).toBeNull();
  });

  it("marks nothing for a session nothing is known about", () => {
    expect(headroomException(undefined, true)).toBeNull();
  });
});

describe("parseReach", () => {
  it("reads the daemon's two findings, and anything else as unknown", () => {
    expect(parseReach("reached")).toBe("reached");
    expect(parseReach("unreached")).toBe("unreached");
    expect(parseReach("unknown")).toBe("unknown");
    expect(parseReach("half-reached")).toBe("unknown");
    expect(parseReach(null)).toBe("unknown");
    expect(parseReach(undefined)).toBe("unknown");
  });
});

describe("sessionCompressionFrom", () => {
  it("reads what the host hands over", () => {
    expect(sessionCompressionFrom({ compressed: false, uncompressedReason: "headroom-failed" })).toEqual(
      uncompressed("headroom-failed")
    );
    expect(sessionCompressionFrom({ compressed: true, uncompressedReason: null, headroomReach: "unreached" })).toEqual({
      ...COMPRESSED,
      reach: "unreached",
    });
  });

  // A host older than the fields sends none of them: not compressed,
  // nothing to explain, nothing known.
  it("reads a baseline from an older host as nothing to mark", () => {
    expect(sessionCompressionFrom({})).toEqual(uncompressed(null));
    expect(sessionCompressionFrom({ compressed: "yes", uncompressedReason: 4, headroomReach: "unknown" })).toEqual(
      uncompressed(null)
    );
  });
});

describe("withReach", () => {
  it("folds a finding in", () => {
    expect(withReach(COMPRESSED, "unreached")).toEqual({ ...COMPRESSED, reach: "unreached" });
    expect(withReach({ ...COMPRESSED, reach: "unreached" }, "reached")).toEqual({ ...COMPRESSED, reach: "reached" });
  });

  // Headroom not answering, or restarted since, says nothing about a
  // session already found either way.
  it("keeps what was known when the answer is unknown", () => {
    const found = { ...COMPRESSED, reach: "unreached" as const };
    expect(withReach(found, "unknown")).toBe(found);
  });

  it("invents nothing for a session it knows nothing about", () => {
    expect(withReach(undefined, "unreached")).toBeUndefined();
  });
});

function turn(over: Partial<ReachCheckInput> = {}): ReachCheckInput {
  return {
    previousStatus: "working",
    status: "idle",
    compression: COMPRESSED,
    run: true,
    reopenedPaint: false,
    blocked: null,
    ...over,
  };
}

describe("reachCheckDue", () => {
  it("asks when a compressed run's turn ends", () => {
    expect(reachCheckDue(turn())).toBe(true);
  });

  // Asked again at the next turn -- a session can start reaching Headroom
  // -- until it is found to.
  it("keeps asking a session found not reaching, and stops once it reaches", () => {
    expect(reachCheckDue(turn({ compression: { ...COMPRESSED, reach: "unreached" } }))).toBe(true);
    expect(reachCheckDue(turn({ compression: { ...COMPRESSED, reach: "reached" } }))).toBe(false);
  });

  it("asks only when a turn ENDED", () => {
    expect(reachCheckDue(turn({ status: "working", previousStatus: "idle" }))).toBe(false);
    expect(reachCheckDue(turn({ previousStatus: "waiting_for_input" }))).toBe(false);
    expect(reachCheckDue(turn({ previousStatus: "idle" }))).toBe(false);
    expect(reachCheckDue(turn({ status: "failed" }))).toBe(false);
    expect(reachCheckDue(turn({ previousStatus: undefined }))).toBe(false);
  });

  // A terminal the human opened goes quiet after its welcome screen and
  // whenever they pause mid-sentence; "nothing reached Headroom" is true
  // then and means nothing.
  it("never asks about a terminal the human opened", () => {
    expect(reachCheckDue(turn({ run: false }))).toBe(false);
  });

  // A reopened conversation's first quiet is its history being painted.
  it("passes over the first quiet of a reopened conversation", () => {
    expect(reachCheckDue(turn({ reopenedPaint: true }))).toBe(false);
  });

  // Its reason is its mark, and Headroom has nothing of it to have seen.
  it("never asks about a session that was not compressed", () => {
    expect(reachCheckDue(turn({ compression: uncompressed("not-ready") }))).toBe(false);
    expect(reachCheckDue(turn({ compression: undefined }))).toBe(false);
  });

  it("never asks a daemon that cannot answer", () => {
    expect(reachCheckDue(turn({ blocked: "Needs daemon v50; the running daemon is v49." }))).toBe(false);
  });
});
