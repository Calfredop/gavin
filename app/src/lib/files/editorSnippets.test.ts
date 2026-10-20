import { describe, it, expect } from "vitest";
import { snippetsForLanguage } from "$lib/files/editorSnippets";

describe("snippetsForLanguage", () => {
  it("returns curated snippets for js/ts, rust, and python", () => {
    expect(snippetsForLanguage("javascript").map((s) => s.label)).toEqual([
      "log",
      "fn",
      "afn",
      "forof",
      "im",
    ]);
    expect(snippetsForLanguage("rust").map((s) => s.label)).toEqual([
      "fn",
      "println",
      "match",
      "struct",
      "impl",
    ]);
    expect(snippetsForLanguage("python").map((s) => s.label)).toEqual([
      "def",
      "print",
      "for",
      "class",
      "ifmain",
    ]);
  });

  it("skips markdown and languages with no curated set", () => {
    expect(snippetsForLanguage("markdown")).toEqual([]);
    expect(snippetsForLanguage("json")).toEqual([]);
    expect(snippetsForLanguage(null)).toEqual([]);
  });

  it("every snippet has a template with at least one tab-stop", () => {
    for (const lang of ["javascript", "rust", "python"] as const) {
      for (const snippet of snippetsForLanguage(lang)) {
        expect(snippet.template, snippet.label).toMatch(/\$\{/);
        expect(snippet.detail.length).toBeGreaterThan(0);
      }
    }
  });
});
