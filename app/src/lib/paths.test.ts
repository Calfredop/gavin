import { describe, it, expect } from "vitest";
import { folderName, sessionLabel } from "./paths";

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

describe("sessionLabel", () => {
  it("prefers a custom session name over anything else", () => {
    expect(sessionLabel({ "s-1": "my override" }, { "s-1": "/Users/alice/proj" }, "s-1")).toBe("my override");
  });

  it("falls back to the cwd's folder name when there's no custom name", () => {
    expect(sessionLabel({}, { "s-1": "/Users/alice/proj" }, "s-1")).toBe("proj");
  });

  it("falls back to a short id fragment when neither a name nor a cwd is known", () => {
    expect(sessionLabel({}, {}, "abcdefgh-1234-5678")).toBe("abcdefgh");
  });

  it("ignores a blank cwd entry and falls back to the id fragment", () => {
    expect(sessionLabel({}, { "s-1": "" }, "s-1")).toBe("s-1");
  });
});
