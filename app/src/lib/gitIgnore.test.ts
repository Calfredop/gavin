import { describe, it, expect, vi } from "vitest";
import {
  fileExtension,
  ignoreExtensionPattern,
  ignoreFilePattern,
  ignoreFolderPattern,
  ignoreMenuItems,
} from "./gitIgnore";

describe("ignore patterns", () => {
  it("anchors a file to the ignore file's own directory", () => {
    expect(ignoreFilePattern("src/generated/output.js")).toBe("/src/generated/output.js");
    expect(ignoreFilePattern("README.md")).toBe("/README.md");
  });

  it("anchors a folder and marks it directory-only", () => {
    expect(ignoreFolderPattern("node_modules")).toBe("/node_modules/");
    expect(ignoreFolderPattern("a/b")).toBe("/a/b/");
  });

  it("reads the extension off a name, ignoring the leading dot of a dotfile", () => {
    expect(fileExtension("src/foo.test.ts")).toBe("ts");
    expect(fileExtension("logo.png")).toBe("png");
    expect(fileExtension(".env")).toBe(null);
    expect(fileExtension("Makefile")).toBe(null);
    expect(fileExtension("archive.tar.gz")).toBe("gz");
    expect(fileExtension("trailing.")).toBe(null);
  });

  it("builds an unanchored *.ext pattern only when there is an extension", () => {
    expect(ignoreExtensionPattern("build/app.log")).toBe("*.log");
    expect(ignoreExtensionPattern(".env")).toBe(null);
  });
});

describe("ignoreMenuItems", () => {
  it("offers a file its exact path, its extension, and a local-only path", () => {
    const onPick = vi.fn();
    const items = ignoreMenuItems("src/app.log", false, onPick);
    expect(items.map((i) => i.label)).toEqual([
      "Ignore this file",
      "Ignore all *.log files",
      "Ignore this file (this checkout only)",
    ]);
    items[0].onPick();
    items[1].onPick();
    items[2].onPick();
    expect(onPick.mock.calls).toEqual([
      ["gitignore", "/src/app.log"],
      ["gitignore", "*.log"],
      ["exclude", "/src/app.log"],
    ]);
  });

  it("omits the extension entry when the file has none", () => {
    const items = ignoreMenuItems(".env", false, vi.fn());
    expect(items.map((i) => i.label)).toEqual(["Ignore this file", "Ignore this file (this checkout only)"]);
  });

  it("offers a folder its own two entries, never an extension entry", () => {
    const onPick = vi.fn();
    const items = ignoreMenuItems("node_modules", true, onPick);
    expect(items.map((i) => i.label)).toEqual([
      "Ignore this folder",
      "Ignore this folder (this checkout only)",
    ]);
    items[0].onPick();
    items[1].onPick();
    expect(onPick.mock.calls).toEqual([
      ["gitignore", "/node_modules/"],
      ["exclude", "/node_modules/"],
    ]);
  });
});
