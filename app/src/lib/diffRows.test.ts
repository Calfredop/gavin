import { describe, it, expect } from "vitest";
import { toUnifiedRows, toSplitRows } from "./diffRows";
import type { Hunk, Line } from "./git";

const l = (kind: Line["kind"], text: string, oldNo?: number, newNo?: number): Line => ({ kind, text, oldNo, newNo });

const hunk: Hunk = {
  header: "@@ -1,5 +1,6 @@",
  oldStart: 1, oldLines: 5, newStart: 1, newLines: 6,
  lines: [
    l("context", "alpha", 1, 1),
    l("del", "beta", 2),
    l("add", "BETA", undefined, 2),
    l("context", "gamma", 3, 3),
    l("del", "delta", 4),
    l("add", "new1", undefined, 4),
    l("add", "new2", undefined, 5),
    l("context", "epsilon", 5, 6),
  ],
};

describe("toUnifiedRows", () => {
  it("emits a hunk row then one row per line with layout-independent ids", () => {
    const rows = toUnifiedRows([hunk]);
    expect(rows[0]).toEqual({ kind: "hunk", hunkIndex: 0, header: "@@ -1,5 +1,6 @@", lineCount: 8 });
    expect(rows).toHaveLength(9);
    expect(rows[2]).toMatchObject({ kind: "line", hunkIndex: 0, lineIndex: 1, id: "0:1", line: l("del", "beta", 2) });
  });

  it("numbers hunks independently", () => {
    const rows = toUnifiedRows([hunk, { ...hunk, header: "@@ -20,1 +21,1 @@" }]);
    expect(rows.filter((r) => r.kind === "hunk").map((r) => r.hunkIndex)).toEqual([0, 1]);
    expect(rows.at(-1)).toMatchObject({ id: "1:7" });
  });
});

describe("toSplitRows", () => {
  it("pairs the k-th deletion with the k-th addition and pads leftovers", () => {
    const rows = toSplitRows([hunk]);
    expect(rows[0]).toMatchObject({ kind: "hunk", hunkIndex: 0 });
    const pairs = rows.slice(1).map((r) => (r.kind === "pair" ? [r.left?.text ?? null, r.right?.text ?? null] : r));
    expect(pairs).toEqual([
      ["alpha", "alpha"],
      ["beta", "BETA"],
      ["gamma", "gamma"],
      ["delta", "new1"],
      [null, "new2"],
      ["epsilon", "epsilon"],
    ]);
  });

  it("keeps the same ids as the unified layout so selection survives a toggle", () => {
    const rows = toSplitRows([hunk]);
    const deltaRow = rows.find((r) => r.kind === "pair" && r.left?.text === "delta");
    expect(deltaRow).toMatchObject({ left: { id: "0:4", lineIndex: 4, no: 4 }, right: { id: "0:5", lineIndex: 5, no: 4 } });
  });

  it("flushes a deletion run that is followed by context, not additions", () => {
    const h: Hunk = { ...hunk, lines: [l("del", "a", 1), l("context", "b", 2, 1), l("add", "c", undefined, 2)] };
    const pairs = toSplitRows([h]).slice(1).map((r) => (r.kind === "pair" ? [r.left?.text ?? null, r.right?.text ?? null] : r));
    expect(pairs).toEqual([["a", null], ["b", "b"], [null, "c"]]);
  });
});
