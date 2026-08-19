import { describe, it, expect } from "vitest";
import { fileExtension, isMarkdown } from "./fileTypes";

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

