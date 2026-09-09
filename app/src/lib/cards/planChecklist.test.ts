import { describe, it, expect } from "vitest";
import { parseChecklist, stripFrontmatter } from "$lib/cards/planChecklist";

const FILE = `---
title: P
status: To Do
---
# Plan

- [ ] first thing
  - [x] nested done
- [ ] [promoted item](./promoted-item.md)
- [x] [done promoted](other.md)
not a - [ ] item
`;

describe("parseChecklist", () => {
  it("finds items with full-content line indices", () => {
    const items = parseChecklist(FILE);
    expect(items).toEqual([
      { lineIndex: 6, text: "first thing", rawText: "first thing", checked: false, promotedFile: null },
      { lineIndex: 7, text: "nested done", rawText: "nested done", checked: true, promotedFile: null },
      { lineIndex: 8, text: "promoted item", rawText: "[promoted item](./promoted-item.md)", checked: false, promotedFile: "promoted-item.md" },
      { lineIndex: 9, text: "done promoted", rawText: "[done promoted](other.md)", checked: true, promotedFile: "other.md" },
    ]);
  });

  it("ignores frontmatter-area lines and handles no-frontmatter files", () => {
    expect(parseChecklist("- [ ] a\n")).toEqual([
      { lineIndex: 0, text: "a", rawText: "a", checked: false, promotedFile: null },
    ]);
    // A checkbox-looking line inside frontmatter never counts:
    expect(parseChecklist("---\n- [ ] not body\n---\n")).toEqual([]);
  });

  it("yields nothing for an unterminated frontmatter block", () => {
    expect(parseChecklist("---\nstatus: x\n- [ ] a\n")).toEqual([]);
  });
});

describe("stripFrontmatter", () => {
  it("returns the body only", () => {
    expect(stripFrontmatter("---\na: b\n---\nBody\n")).toBe("Body\n");
  });
  it("returns whole content when no frontmatter", () => {
    expect(stripFrontmatter("Body only\n")).toBe("Body only\n");
  });
  it("returns empty for unterminated frontmatter", () => {
    expect(stripFrontmatter("---\na: b\n")).toBe("");
  });
});
