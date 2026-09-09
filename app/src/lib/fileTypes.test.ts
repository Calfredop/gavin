import { describe, it, expect } from "vitest";
import { fileExtension, isMarkdown, isViewableExtension } from "$lib/fileTypes";

describe("fileExtension", () => {
  it("returns the lowercased extension", () => {
    expect(fileExtension("/tmp/README.MD")).toBe("md");
  });

  it("returns an empty string for a file with no extension", () => {
    expect(fileExtension("/tmp/Makefile")).toBe("");
  });

  it("ignores dots in parent directories", () => {
    expect(fileExtension("/tmp/my.dir/plainfile")).toBe("");
  });
});

describe("isMarkdown", () => {
  it("is true for .md and .markdown", () => {
    expect(isMarkdown("/tmp/a.md")).toBe(true);
    expect(isMarkdown("/tmp/a.markdown")).toBe(true);
  });

  it("is false for other extensions", () => {
    expect(isMarkdown("/tmp/a.ts")).toBe(false);
  });
});


describe("isViewableExtension", () => {
  // The Rust side owns the list (fileviewer.rs VIEWABLE_EXTENSIONS); a
  // representative slice is enough to pin the RULE, which is all this
  // function is.
  const viewable = ["md", "ts", "txt", "json"];

  it("says yes for text and code gavin can render itself", () => {
    expect(isViewableExtension("/ws/docs/spec.md", viewable)).toBe(true);
    expect(isViewableExtension("/ws/src/lib/a.TS", viewable)).toBe(true);
  });

  it("says no for a binary, which belongs to the OS's default app", () => {
    expect(isViewableExtension("/Users/x/shot.png", viewable)).toBe(false);
    expect(isViewableExtension("/Users/x/deck.pdf", viewable)).toBe(false);
  });

  it("says no for a file with no extension at all", () => {
    expect(isViewableExtension("/ws/Makefile", viewable)).toBe(false);
    expect(isViewableExtension("/ws/my.dir/plainfile", viewable)).toBe(false);
  });
});
