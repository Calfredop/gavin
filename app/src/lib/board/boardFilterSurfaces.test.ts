import { describe, it, expect } from "vitest";
import { svelteSources, tsSources } from "$lib/sources";

const SVELTE = svelteSources();
const TS = tsSources();

function source(name: string): string {
  const text = SVELTE[name] ?? TS[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

describe("label facet surfaces", () => {
  it("offers Any label and a Not pair in the shared filter row", () => {
    const filters = source("FacetFilters.svelte");
    expect(filters).toContain("Filter by label");
    expect(filters).toContain("labelFacets");
    expect(source("boardFilters.ts")).toContain("Any label");
    expect(source("boardFilters.ts")).toContain("Not ${l.name}");
  });
});
