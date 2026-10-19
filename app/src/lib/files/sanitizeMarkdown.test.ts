import { describe, it, expect } from "vitest";
import { source } from "$lib/sources";

// Repository markdown (a card body, a README) is rendered through
// `{@html}` in three sinks. Style tags and attributes must never reach
// the document — DOMPurify's default allowlist keeps both. One helper
// owns the sanitize call and forbids them; every other call site is a
// regression.

const CALL = "DOMPurify.sanitize(";

const APP_AND_COMPANION = {
  ...import.meta.glob("../../**/*.{svelte,ts}", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob("../../../companion/src/**/*.{svelte,ts}", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
} as Record<string, string>;

function sanitizeCallSites(): string[] {
  return Object.entries(APP_AND_COMPANION)
    .filter(([path, text]) => !path.includes(".test.") && text.includes(CALL))
    .map(([path]) => path.slice(path.lastIndexOf("/") + 1));
}

describe("sanitizeMarkdown is the only DOMPurify.sanitize call", () => {
  it("lives in sanitizeMarkdown.ts and nowhere else under app/src or companion", () => {
    expect(sanitizeCallSites()).toEqual(["sanitizeMarkdown.ts"]);
  });

  it("forbids the style tag and the style attribute", () => {
    const text = source("sanitizeMarkdown.ts");
    expect(text).toContain('FORBID_TAGS: ["style"]');
    expect(text).toContain('FORBID_ATTR: ["style"]');
  });
});
