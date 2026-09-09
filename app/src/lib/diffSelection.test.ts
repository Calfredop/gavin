import { describe, it, expect } from "vitest";
import { selectionHunk, rangeIds, clickLine } from "$lib/diffSelection";
import type { Hunk } from "$lib/git";

const hunks: Hunk[] = [
  {
    header: "@@ -1,5 +1,6 @@", oldStart: 1, oldLines: 5, newStart: 1, newLines: 6,
    lines: [
      { kind: "context", text: "alpha" }, { kind: "del", text: "beta" }, { kind: "add", text: "BETA" },
      { kind: "context", text: "gamma" }, { kind: "del", text: "delta" }, { kind: "add", text: "new1" },
      { kind: "add", text: "new2" }, { kind: "context", text: "epsilon" },
    ],
  },
  { header: "@@ -20,1 +21,1 @@", oldStart: 20, oldLines: 1, newStart: 21, newLines: 1, lines: [{ kind: "del", text: "x" }, { kind: "add", text: "y" }] },
];

describe("selectionHunk", () => {
  it("reports the hunk of the selection or null", () => {
    expect(selectionHunk(new Set(["1:0"]))).toBe(1);
    expect(selectionHunk(new Set())).toBeNull();
  });
});

describe("rangeIds", () => {
  it("covers change lines between the bounds in either order, skipping context", () => {
    expect([...rangeIds(hunks, 0, 1, 5)].sort()).toEqual(["0:1", "0:2", "0:4", "0:5"]);
    expect([...rangeIds(hunks, 0, 5, 1)].sort()).toEqual(["0:1", "0:2", "0:4", "0:5"]);
  });
});

describe("clickLine", () => {
  it("ignores context lines", () => {
    expect(clickLine(new Set(["0:1"]), hunks, 0, 0, false, 1)).toEqual({ ids: new Set(["0:1"]), anchor: 1 });
  });
  it("toggles a single line within the same hunk", () => {
    expect(clickLine(new Set(["0:1"]), hunks, 0, 2, false, 1)).toEqual({ ids: new Set(["0:1", "0:2"]), anchor: 2 });
    expect(clickLine(new Set(["0:1", "0:2"]), hunks, 0, 1, false, 2)).toEqual({ ids: new Set(["0:2"]), anchor: 1 });
  });
  it("replaces the selection when clicking in another hunk", () => {
    expect(clickLine(new Set(["0:1"]), hunks, 1, 1, false, 1)).toEqual({ ids: new Set(["1:1"]), anchor: 1 });
  });
  it("shift-click selects the range from the anchor", () => {
    expect(clickLine(new Set(["0:1"]), hunks, 0, 6, true, 1)).toEqual({ ids: new Set(["0:1", "0:2", "0:4", "0:5", "0:6"]), anchor: 1 });
  });
  it("shift-click without an anchor behaves like a plain click", () => {
    expect(clickLine(new Set(), hunks, 0, 5, true, null)).toEqual({ ids: new Set(["0:5"]), anchor: 5 });
  });
});
