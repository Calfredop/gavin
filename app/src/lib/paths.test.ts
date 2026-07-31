import { describe, it, expect } from "vitest";
import { folderName } from "./paths";

describe("folderName", () => {
  it("returns the last path segment", () => {
    expect(folderName("/Users/alice/my-project")).toBe("my-project");
  });

  it("handles a trailing slash", () => {
    expect(folderName("/Users/alice/my-project/")).toBe("my-project");
  });

  it("returns the path itself when given just the root", () => {
    expect(folderName("/")).toBe("/");
  });

  it("handles a single-segment path", () => {
    expect(folderName("/tmp")).toBe("tmp");
  });
});
