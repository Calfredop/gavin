import { describe, it, expect } from "vitest";
import { buildPatch } from "./patch";
import fixtures from "./fixtures/patch-fixtures.json";
import type { FileDiff } from "./git";

interface Fixture {
  name: string;
  diff: FileDiff;
  hunkIndex: number;
  selected: string[] | null;
  expectedPatch: string;
}

describe("buildPatch against the shared fixtures (also applied by the Rust tests)", () => {
  for (const f of fixtures.fixtures as Fixture[]) {
    it(f.name, () => {
      const selected = f.selected === null ? null : new Set(f.selected);
      expect(buildPatch(f.diff, f.hunkIndex, selected)).toBe(f.expectedPatch);
    });
  }
});

describe("buildPatch edge cases", () => {
  const base = (fixtures.fixtures as Fixture[])[0].diff;

  it("returns null when the selection has no change lines", () => {
    expect(buildPatch(base, 0, new Set(["0:0"]))).toBeNull(); // a context line only
    expect(buildPatch(base, 0, new Set())).toBeNull();
    expect(buildPatch(base, 5, null)).toBeNull();
  });

  it("uses oldPath in the --- header for renames and /dev/null for untracked adds", () => {
    const renamed: FileDiff = { ...base, path: "g.txt", oldPath: "f.txt" };
    expect(buildPatch(renamed, 0, null)!.startsWith("--- a/f.txt\n+++ b/g.txt\n")).toBe(true);
    const added: FileDiff = {
      path: "u.txt", binary: false, tooLarge: false,
      hunks: [{ header: "@@ -0,0 +1 @@", oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: [{ kind: "add", text: "hello", newNo: 1 }] }],
    };
    expect(buildPatch(added, 0, null)).toBe("--- /dev/null\n+++ b/u.txt\n@@ -0,0 +1,1 @@\n+hello\n");
  });

  it("recounts the header when only some deletions are selected", () => {
    // Select only "-beta": BETA/new1/new2 dropped, "-delta" becomes context.
    expect(buildPatch(base, 0, new Set(["0:1"]))).toBe(
      "--- a/f.txt\n+++ b/f.txt\n@@ -1,5 +1,4 @@\n alpha\n-beta\n gamma\n delta\n epsilon\n"
    );
  });
});
