import { describe, it, expect } from "vitest";
import { languageIdForPath } from "$lib/files/codeMirror";

describe("languageIdForPath", () => {
  it("maps known extensions to a language id", () => {
    expect(languageIdForPath("/tmp/a.md")).toBe("markdown");
    expect(languageIdForPath("/tmp/a.markdown")).toBe("markdown");
    expect(languageIdForPath("/tmp/a.ts")).toBe("javascript");
    expect(languageIdForPath("/tmp/a.tsx")).toBe("javascript");
    expect(languageIdForPath("/tmp/a.rs")).toBe("rust");
    expect(languageIdForPath("/tmp/a.py")).toBe("python");
    expect(languageIdForPath("/tmp/a.json")).toBe("json");
    expect(languageIdForPath("/tmp/a.html")).toBe("html");
    expect(languageIdForPath("/tmp/a.svelte")).toBe("html");
    expect(languageIdForPath("/tmp/a.css")).toBe("css");
    expect(languageIdForPath("/tmp/a.scss")).toBe("css");
    expect(languageIdForPath("/tmp/a.yaml")).toBe("yaml");
    expect(languageIdForPath("/tmp/a.yml")).toBe("yaml");
  });

  it("returns null for extensions with no pack, so they open as plain text", () => {
    expect(languageIdForPath("/tmp/a.log")).toBeNull();
    expect(languageIdForPath("/tmp/a.toml")).toBeNull();
    expect(languageIdForPath("/tmp/Makefile")).toBeNull();
  });

  it("is case-insensitive on the extension", () => {
    expect(languageIdForPath("/tmp/README.MD")).toBe("markdown");
  });
});
