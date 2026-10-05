import { describe, expect, it } from "vitest";
import { emptyTree, withChildren, withError, type FileNode } from "$lib/files/fileTree";
import {
  crumbs,
  folderAbove,
  folderView,
  omittedNote,
  startingPlace,
  stillListed,
  tapOn,
  unviewableNote,
} from "$companion/surfaces/phoneFiles";

const ROOT = "/Users/demo/code/atlas-api";

function node(path: string, isDir = false): FileNode {
  return { path, name: path.split("/").pop() ?? path, isDir, size: 120, symlink: false };
}

describe("where the Files surface opens", () => {
  it("is the root, the first time", () => {
    expect(startingPlace(ROOT, undefined)).toEqual({ dir: ROOT, file: null });
  });

  it("is where it was, when that is still inside the root", () => {
    const place = { dir: `${ROOT}/src`, file: `${ROOT}/src/server.ts` };
    expect(startingPlace(ROOT, place)).toEqual(place);
  });

  it("is the root again when where it was is outside this root", () => {
    expect(startingPlace(ROOT, { dir: "/Users/demo/code/field-notes", file: null })).toEqual({ dir: ROOT, file: null });
    expect(startingPlace(ROOT, { dir: `${ROOT}-old/src`, file: null })).toEqual({ dir: ROOT, file: null });
  });

  it("drops a remembered file that is not in its folder", () => {
    expect(startingPlace(ROOT, { dir: `${ROOT}/src`, file: `${ROOT}/docs/a.md` })).toEqual({ dir: `${ROOT}/src`, file: null });
  });
});

describe("the path strip", () => {
  it("runs from the root, named for its folder, down to the folder on screen", () => {
    expect(crumbs(ROOT, `${ROOT}/src/auth`)).toEqual([
      { path: ROOT, name: "atlas-api" },
      { path: `${ROOT}/src`, name: "src" },
      { path: `${ROOT}/src/auth`, name: "auth" },
    ]);
    expect(crumbs(ROOT, ROOT)).toEqual([{ path: ROOT, name: "atlas-api" }]);
  });

  it("goes up one folder, and no further than the root", () => {
    expect(folderAbove(ROOT, `${ROOT}/src/auth`)).toBe(`${ROOT}/src`);
    expect(folderAbove(ROOT, `${ROOT}/src`)).toBe(ROOT);
    expect(folderAbove(ROOT, ROOT)).toBeNull();
  });
});

describe("one folder", () => {
  it("is unread, failed or listed -- never empty for want of looking", () => {
    const tree = emptyTree(ROOT);
    expect(folderView(tree, ROOT)).toEqual({ kind: "unread" });
    expect(folderView(withError(tree, ROOT, "permission denied"), ROOT)).toEqual({
      kind: "failed",
      message: "permission denied",
    });
    const listed = withChildren(tree, ROOT, [{ name: "src", isDir: true, size: 0, symlink: false }], 0);
    expect(folderView(listed, ROOT)).toEqual({
      kind: "listed",
      nodes: [{ path: `${ROOT}/src`, name: "src", isDir: true, size: 0, symlink: false }],
      omitted: 0,
    });
    expect(folderView(withChildren(tree, ROOT, [], 0), ROOT)).toEqual({ kind: "listed", nodes: [], omitted: 0 });
  });

  it("says when the host listed only part of it, without sending the human to Finder", () => {
    expect(omittedNote(0)).toBeNull();
    expect(omittedNote(1)).toBe("1 more entry not listed: this folder is too big to show whole.");
    expect(omittedNote(2500)).toBe("2,500 more entries not listed: this folder is too big to show whole.");
  });
});

describe("a tap on a row", () => {
  const VIEWABLE = ["ts", "md"];

  it("walks into a folder, and opens a file the editor can show", () => {
    expect(tapOn(node(`${ROOT}/src`, true), VIEWABLE)).toBe("enter");
    expect(tapOn(node(`${ROOT}/README.md`), VIEWABLE)).toBe("open");
  });

  it("says the phone cannot show what the desk hands to another application", () => {
    const picture = node(`${ROOT}/docs/architecture.png`);
    expect(tapOn(picture, VIEWABLE)).toBe("unviewable");
    expect(unviewableNote(picture)).toBe(
      "architecture.png can't be shown here. Gavin opens files like it in their own application, at the desk."
    );
  });
});

describe("a remembered file", () => {
  const place = { dir: ROOT, file: `${ROOT}/README.md` };

  it("stands while its folder is unread, and once the listing has it", () => {
    expect(stillListed(emptyTree(ROOT), place)).toBe(true);
    const listed = withChildren(emptyTree(ROOT), ROOT, [{ name: "README.md", isDir: false, size: 1, symlink: false }]);
    expect(stillListed(listed, place)).toBe(true);
  });

  it("is gone when the listing has not got it", () => {
    const listed = withChildren(emptyTree(ROOT), ROOT, [{ name: "other.md", isDir: false, size: 1, symlink: false }]);
    expect(stillListed(listed, place)).toBe(false);
    expect(stillListed(listed, { dir: ROOT, file: null })).toBe(true);
  });
});
