import { describe, expect, it } from "vitest";
import { toUnifiedRows } from "$lib/git/diffRows";
import { lineDiff } from "$companion/demo/lineDiff";

function numbered(count: number, change?: [number, string]): string {
  const lines = Array.from({ length: count }, (_, i) => `line ${i + 1}`);
  if (change) lines[change[0] - 1] = change[1];
  return `${lines.join("\n")}\n`;
}

describe("the demo's line diff", () => {
  it("has no hunks for content that did not change", () => {
    expect(lineDiff("a.ts", "x\ny\n", "x\ny\n").hunks).toEqual([]);
  });

  it("shows one changed line with three lines of context on each side, as git does", () => {
    const diff = lineDiff("a.ts", numbered(10), numbered(10, [5, "five"]));
    expect(diff.hunks).toHaveLength(1);
    const [hunk] = diff.hunks;
    expect(hunk.header).toBe("@@ -2,7 +2,7 @@");
    expect(hunk.lines.map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`)).toEqual([
      " line 2",
      " line 3",
      " line 4",
      "-line 5",
      "+five",
      " line 6",
      " line 7",
      " line 8",
    ]);
  });

  it("numbers each side's lines", () => {
    const [hunk] = lineDiff("a.ts", "a\nb\n", "a\nB\nc\n").hunks;
    expect(hunk.lines).toEqual([
      { kind: "context", text: "a", oldNo: 1, newNo: 1 },
      { kind: "del", text: "b", oldNo: 2 },
      { kind: "add", text: "B", newNo: 2 },
      { kind: "add", text: "c", newNo: 3 },
    ]);
  });

  it("keeps far-apart changes in hunks of their own, and near ones in one", () => {
    expect(lineDiff("a.ts", numbered(30), numbered(30, [3, "x"]).replace("line 25\n", "y\n")).hunks).toHaveLength(2);
    expect(lineDiff("a.ts", numbered(30), numbered(30, [3, "x"]).replace("line 8\n", "y\n")).hunks).toHaveLength(1);
  });

  it("writes a new file as an addition against nothing", () => {
    const [hunk] = lineDiff("new.ts", null, "one\ntwo\n").hunks;
    expect(hunk.header).toBe("@@ -0,0 +1,2 @@");
    expect(hunk.lines.every((l) => l.kind === "add")).toBe(true);
  });

  it("writes a deleted file as a removal of everything", () => {
    const [hunk] = lineDiff("gone.ts", "one\n", null).hunks;
    expect(hunk.header).toBe("@@ -1 +0,0 @@");
  });

  it("counts a lost final newline as a change, and marks the line that has none", () => {
    const [hunk] = lineDiff("a.ts", "a\nb\n", "a\nb").hunks;
    expect(hunk.lines).toEqual([
      { kind: "context", text: "a", oldNo: 1, newNo: 1 },
      { kind: "del", text: "b", oldNo: 2 },
      { kind: "add", text: "b", newNo: 2, noNewline: true },
    ]);
  });

  it("answers a diff too big to tabulate the way the host answers a huge one", () => {
    const big = "x\n".repeat(3000);
    const diff = lineDiff("big.log", big, `${big}y\n`);
    expect(diff).toMatchObject({ tooLarge: true, hunks: [] });
  });

  it("is what the desktop's own diff rows are drawn from", () => {
    const rows = toUnifiedRows(lineDiff("a.ts", numbered(10), numbered(10, [5, "five"])).hunks);
    expect(rows[0]).toMatchObject({ kind: "hunk", header: "@@ -2,7 +2,7 @@" });
    expect(rows.filter((r) => r.kind === "line")).toHaveLength(8);
  });
});
