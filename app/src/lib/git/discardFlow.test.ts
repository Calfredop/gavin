import { describe, it, expect } from "vitest";
import { describeFileDiscard, describeHunkDiscard } from "$lib/git/discardFlow";

describe("describeFileDiscard", () => {
  it("names tracked discards", () => {
    const p = describeFileDiscard([{ path: "a.ts", status: "M" }, { path: "b.ts", status: "D" }]);
    expect(p.title).toBe("Discard changes in 2 files?");
    expect(p.tracked).toEqual(["a.ts", "b.ts"]);
    expect(p.untracked).toEqual([]);
    expect(p.body).toContain("a.ts");
    expect(p.body).toContain("This cannot be undone.");
  });
  it("calls out untracked deletions separately (git clean removes them from disk)", () => {
    expect(describeFileDiscard([{ path: "u.txt", status: "?" }]).title).toBe("Delete 1 untracked file?");
    const mixed = describeFileDiscard([{ path: "a.ts", status: "M" }, { path: "u.txt", status: "?" }]);
    expect(mixed.title).toBe("Discard changes in 1 file and delete 1 untracked file?");
    expect(mixed.untracked).toEqual(["u.txt"]);
  });
  it("truncates long path lists", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.ts`, status: "M" as const }));
    expect(describeFileDiscard(many).body).toContain("… and 4 more");
  });
});

describe("describeHunkDiscard", () => {
  it("distinguishes whole hunk from selected lines", () => {
    expect(describeHunkDiscard("src/a.ts", null).title).toBe("Discard this hunk in src/a.ts?");
    expect(describeHunkDiscard("src/a.ts", 7).title).toBe("Discard 7 selected lines?");
    expect(describeHunkDiscard("src/a.ts", 1).title).toBe("Discard 1 selected line?");
  });
});
