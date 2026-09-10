import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  modesFor,
  defaultMode,
  canEdit,
  classifyExternalRead,
  resolveExternalChange,
  dirtyPaths,
  setPathDirty,
} from "$lib/files/fileEditing";

describe("modesFor", () => {
  it("offers all three modes for markdown", () => {
    expect(modesFor("/tmp/a.md")).toEqual(["formatted", "plain", "edit"]);
  });

  it("offers plain and edit for every other text file", () => {
    expect(modesFor("/tmp/a.rs")).toEqual(["plain", "edit"]);
    expect(modesFor("/tmp/a.log")).toEqual(["plain", "edit"]);
  });
});

describe("defaultMode", () => {
  it("opens file tabs read-first", () => {
    expect(defaultMode("/tmp/a.md", "tab")).toBe("formatted");
    expect(defaultMode("/tmp/a.rs", "tab")).toBe("plain");
  });

  it("opens hub tabs (PRD, agent file) in edit", () => {
    expect(defaultMode("/root/.gavin-root/PRD.md", "hub")).toBe("edit");
    expect(defaultMode("/root/CLAUDE.md", "hub")).toBe("edit");
  });
});

describe("canEdit", () => {
  it("allows editing a normally-loaded file, including one that doesn't exist yet", () => {
    expect(canEdit({ truncated: false, error: null })).toBe(true);
  });

  it("refuses a truncated file -- saving a prefix would destroy the tail", () => {
    expect(canEdit({ truncated: true, error: null })).toBe(false);
  });

  it("refuses a file that failed to load", () => {
    expect(canEdit({ truncated: false, error: "file is not valid UTF-8 text" })).toBe(false);
  });
});

describe("resolveExternalChange", () => {
  it("ignores an echo of our own save", () => {
    expect(
      resolveExternalChange({ incoming: "same", buffer: "same", onDisk: "same", dirty: false }),
    ).toBe("ignore");
  });

  it("ignores identical content even while dirty", () => {
    expect(
      resolveExternalChange({ incoming: "same", buffer: "same", onDisk: "same", dirty: true }),
    ).toBe("ignore");
  });

  it("ignores our own save echoing back after the buffer has moved on", () => {
    // The bug this function exists to prevent, and the one comparing
    // against the buffer alone could not: autosave writes "line one",
    // the watcher takes 500ms to report it, and by then the human has
    // typed the next line. The incoming content is OUR write, not
    // somebody else's edit, so it must never raise a banner.
    expect(
      resolveExternalChange({
        incoming: "line one",
        buffer: "line one\nline two",
        onDisk: "line one",
        dirty: true,
      }),
    ).toBe("ignore");
  });

  it("ignores a repeat event carrying disk content it has already seen", () => {
    // A single save produces a burst of filesystem events; only the
    // first one may be news.
    expect(
      resolveExternalChange({
        incoming: "theirs",
        buffer: "ours",
        onDisk: "theirs",
        dirty: true,
      }),
    ).toBe("ignore");
  });

  it("reloads silently when the buffer is clean", () => {
    expect(
      resolveExternalChange({ incoming: "theirs", buffer: "ours", onDisk: "ours", dirty: false }),
    ).toBe("reload");
  });

  it("raises a conflict when the buffer is dirty", () => {
    expect(
      resolveExternalChange({ incoming: "theirs", buffer: "ours", onDisk: "ours", dirty: true }),
    ).toBe("conflict");
  });

  it("still conflicts when someone else writes over content we saved", () => {
    // Same shape as the echo case -- dirty buffer, incoming differs from
    // it -- but the disk has moved past our last write, so this one IS
    // news and the human has to choose.
    expect(
      resolveExternalChange({
        incoming: "theirs",
        buffer: "line one\nline two",
        onDisk: "line one",
        dirty: true,
      }),
    ).toBe("conflict");
  });
});

describe("dirtyPaths", () => {
  beforeEach(() => dirtyPaths.set(new Set()));

  it("tracks and clears per path", () => {
    setPathDirty("/tmp/a.md", true);
    setPathDirty("/tmp/b.md", true);
    expect(get(dirtyPaths).has("/tmp/a.md")).toBe(true);

    setPathDirty("/tmp/a.md", false);
    expect(get(dirtyPaths).has("/tmp/a.md")).toBe(false);
    expect(get(dirtyPaths).has("/tmp/b.md")).toBe(true);
  });

  it("does not allocate a new set when nothing changes", () => {
    setPathDirty("/tmp/a.md", true);
    const first = get(dirtyPaths);
    setPathDirty("/tmp/a.md", true);
    expect(get(dirtyPaths)).toBe(first);
  });
});

describe("classifyExternalRead", () => {
  it("is present whenever the file is on disk", () => {
    expect(classifyExternalRead({ existsNow: true, existedBefore: false })).toBe("present");
    expect(classifyExternalRead({ existsNow: true, existedBefore: true })).toBe("present");
  });

  it("calls a file that was there and is gone deleted", () => {
    expect(classifyExternalRead({ existsNow: false, existedBefore: true })).toBe("deleted");
  });

  it("calls a file that was never there absent, not deleted", () => {
    // The PRD and agent-file hub tabs open on a path that only the first
    // save creates -- an event on that directory must not read as "your
    // file was deleted".
    expect(classifyExternalRead({ existsNow: false, existedBefore: false })).toBe("absent");
  });
});
