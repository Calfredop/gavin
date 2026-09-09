import { describe, it, expect } from "vitest";
import {
  folderName,
  sessionLabel,
  boardTabLabel,
  cardTabLabel,
  isAbsolutePath,
  toPosixPath,
} from "$lib/paths";

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

  it("reads a backslash as a separator too", () => {
    // Everything gavin holds is forward-slashed by the time it reaches
    // here (protocol::wire_path), so this is the belt on top of the
    // braces: a path a human typed into a field must still name its own
    // folder.
    expect(folderName("C:\\Users\\ada\\my-project")).toBe("my-project");
    expect(folderName("C:/Users/ada/my-project")).toBe("my-project");
    expect(folderName("C:\\Users\\ada\\my-project\\")).toBe("my-project");
  });
});

describe("toPosixPath", () => {
  it("turns a Windows path into the one spelling gavin uses", () => {
    expect(toPosixPath("C:\\Users\\ada\\repo")).toBe("C:/Users/ada/repo");
  });

  it("leaves a path that is already forward-slashed alone", () => {
    expect(toPosixPath("/Users/ada/repo")).toBe("/Users/ada/repo");
    expect(toPosixPath("C:/Users/ada/repo")).toBe("C:/Users/ada/repo");
  });
});

describe("isAbsolutePath", () => {
  it("accepts both alphabets, whichever OS is running", () => {
    // The app reads paths written on another machine -- a card's cwd, a
    // tool's directory, a config a colleague committed -- so the verdict
    // cannot depend on the platform it happens to run on.
    expect(isAbsolutePath("/Users/ada/repo")).toBe(true);
    expect(isAbsolutePath("C:\\Users\\ada")).toBe(true);
    expect(isAbsolutePath("c:/Users/ada")).toBe(true);
    expect(isAbsolutePath("\\\\server\\share")).toBe(true);
  });

  it("refuses what is not absolute, including the near misses", () => {
    expect(isAbsolutePath("repo/sub")).toBe(false);
    expect(isAbsolutePath("./repo")).toBe(false);
    expect(isAbsolutePath("")).toBe(false);
    // Drive-relative: resolves against that drive's own current
    // directory, which is not a place gavin can start a session.
    expect(isAbsolutePath("C:repo")).toBe(false);
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

describe("boardTabLabel", () => {
  it("names the context the tree gave it", () => {
    expect(boardTabLabel("backend", "/ws/crates/backend")).toBe("backend · board");
  });

  it("falls back to the folder's own basename when the tree has no name for it", () => {
    expect(boardTabLabel(null, "/ws/crates/backend")).toBe("backend · board");
    expect(boardTabLabel(undefined, "/ws/crates/backend")).toBe("backend · board");
    expect(boardTabLabel("", "/ws/crates/backend")).toBe("backend · board");
  });
});

describe("cardTabLabel", () => {
  it("names the card and which of its two views the pane holds", () => {
    expect(cardTabLabel("Fix the login flow", "plan")).toBe("Fix the login flow · plan");
    expect(cardTabLabel("Fix the login flow", "changes")).toBe("Fix the login flow · changes");
  });
});
