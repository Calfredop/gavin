import { describe, it, expect } from "vitest";
import { computeGraph, LANE_COLORS } from "$lib/graphLanes";
import type { CommitInfo } from "$lib/git";

function c(sha: string, parents: string[]): CommitInfo {
  return { sha, parents, author: "a", email: "a@x", date: "2026-08-21T00:00:00Z", subject: sha, refs: [], isHead: false };
}

describe("computeGraph", () => {
  it("draws a linear history on lane 0 with no links", () => {
    const rows = computeGraph([c("c3", ["c2"]), c("c2", ["c1"]), c("c1", [])]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows.every((r) => r.incoming.length === 0 && r.outgoing.length === 0 && r.passes.length === 0)).toBe(true);
    expect(rows.map((r) => r.hasParent)).toEqual([true, true, false]);
    expect(rows.map((r) => r.fromAbove)).toEqual([false, true, true]);
    expect(rows.map((r) => r.lanes)).toEqual([1, 1, 1]);
  });

  it("forks a merge's second parent onto lane 1 and joins it back at the common ancestor", () => {
    const rows = computeGraph([c("M", ["a", "b"]), c("a", ["r"]), c("b", ["r"]), c("r", [])]);
    expect(rows[0]).toMatchObject({ lane: 0, outgoing: [1], passes: [] });
    expect(rows[1]).toMatchObject({ lane: 0, passes: [1] });
    expect(rows[2]).toMatchObject({ lane: 1, passes: [0] });
    expect(rows[3]).toMatchObject({ lane: 0, incoming: [1], passes: [] });
    expect(rows.map((r) => r.lanes)).toEqual([2, 2, 2, 2]);
  });

  it("gives an octopus merge one outgoing link per extra parent", () => {
    const rows = computeGraph([c("M", ["a", "b", "c"]), c("a", []), c("b", []), c("c", [])]);
    expect(rows[0].outgoing).toEqual([1, 2]);
    expect(rows[1]).toMatchObject({ lane: 0, passes: [1, 2] });
    expect(rows[3]).toMatchObject({ lane: 2, passes: [] });
  });

  it("opens a temporary lane for an unrelated root and trims it again", () => {
    const rows = computeGraph([c("c2", ["c1"]), c("r2", []), c("c1", [])]);
    expect(rows[1]).toMatchObject({ lane: 1, passes: [0], hasParent: false, lanes: 2 });
    expect(rows[2]).toMatchObject({ lane: 0, lanes: 1 });
  });

  it("colours by lane and reuses a lane already waiting for a parent", () => {
    // b's parent is r, which lane 0 (via a) is already waiting for: no new lane.
    const rows = computeGraph([c("M", ["a", "b"]), c("a", ["r"]), c("b", ["r"]), c("r", [])]);
    expect(rows[2].color).toBe(1 % LANE_COLORS);
    expect(Math.max(...rows.map((r) => r.lanes))).toBe(2);
  });
});
