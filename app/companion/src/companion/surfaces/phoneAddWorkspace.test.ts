import { describe, expect, it } from "vitest";
import type { Workspace } from "$lib/core/workspace";
import type { FileNode } from "$lib/files/fileTree";
import {
  browseRoot,
  browserListing,
  folderAction,
  hiddenNote,
  workspaceAt,
} from "$companion/surfaces/phoneAddWorkspace";

function ws(id: string, name: string, rootPath?: string, ssh?: Workspace["ssh"]): Workspace {
  return { id, name, rootPath, ssh, pages: [], activePageId: null };
}

function node(path: string, isDir: boolean): FileNode {
  return { path, name: path.split("/").at(-1) ?? path, isDir, size: 0, symlink: false };
}

const WORKSPACES = [
  ws("w1", "api", "/home/me/code/api"),
  ws("w2", "remote", "/home/me/code/tools", { host: "build-box" }),
  ws("w3", "Scratchpad"),
];

describe("the top of the disk the browser lists against", () => {
  it("is / on a Mac or Linux, and the drive on Windows", () => {
    expect(browseRoot("/Users/me")).toBe("/");
    expect(browseRoot("/home/me")).toBe("/");
    expect(browseRoot("C:/Users/me")).toBe("C:/");
  });
});

describe("the workspace already on a folder", () => {
  it("is the one whose folder it is, a trailing slash or not", () => {
    expect(workspaceAt(WORKSPACES, "/home/me/code/api")?.id).toBe("w1");
    expect(workspaceAt(WORKSPACES, "/home/me/code/api/")?.id).toBe("w1");
    expect(workspaceAt(WORKSPACES, "/home/me/code")).toBeNull();
  });

  it("is never one on another machine, whose folder only shares the spelling", () => {
    expect(workspaceAt(WORKSPACES, "/home/me/code/tools")).toBeNull();
  });
});

describe("a folder as the browser draws it", () => {
  it("leaves hidden entries out, counts them, and marks the folders that are workspaces", () => {
    const listing = browserListing(
      [
        node("/home/me/code/.cache", true),
        node("/home/me/code/api", true),
        node("/home/me/code/web", true),
        node("/home/me/code/.envrc", false),
        node("/home/me/code/notes.md", false),
      ],
      WORKSPACES
    );
    expect(listing.rows.map((row) => [row.name, row.isDir, row.workspace])).toEqual([
      ["api", true, "api"],
      ["web", true, null],
      ["notes.md", false, null],
    ]);
    expect(listing.hidden).toBe(2);
  });

  it("notes what it left out only when it left something out", () => {
    expect(hiddenNote(0)).toBeNull();
    expect(hiddenNote(1)).toBe("1 hidden item not shown.");
    expect(hiddenNote(3)).toBe("3 hidden items not shown.");
  });
});

describe("the button under the browser", () => {
  it("opens the workspace a folder already is", () => {
    expect(folderAction("/home/me/code/api", "/", WORKSPACES)).toEqual({
      kind: "open",
      workspaceId: "w1",
      label: "Open api",
    });
  });

  it("adds any other folder, named for it", () => {
    expect(folderAction("/home/me/code/web", "/", WORKSPACES)).toEqual({ kind: "add", name: "web", label: "Add web" });
  });

  it("offers nothing at the top of the disk", () => {
    expect(folderAction("/", "/", WORKSPACES)).toEqual({ kind: "none" });
    expect(folderAction("", "/", WORKSPACES)).toEqual({ kind: "none" });
  });
});
