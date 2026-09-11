import { describe, it, expect } from "vitest";
import { svelteSources, tsSources } from "$lib/sources";

const SVELTE = svelteSources();
const TS = tsSources();

function source(name: string): string {
  const text = SVELTE[name] ?? TS[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

describe("facet filter surfaces", () => {
  it("opens checkbox dropdowns over the shared menu, not a native select", () => {
    const filters = source("FacetFilters.svelte");
    expect(filters).toContain("FacetDropdown");
    expect(filters).not.toContain("<select");
    expect(source("FacetDropdown.svelte")).toContain("openMenuUnder");
    expect(source("FacetDropdown.svelte")).toContain("facetMenuEntries");
    expect(source("boardFilters.ts")).toContain("keepOpen: true");
  });

  it("offers Any-empty labels and no Not pair", () => {
    const filters = source("FacetFilters.svelte");
    expect(filters).toContain("Filter by label");
    expect(filters).toContain("ANY_LABEL_LABEL");
    expect(source("boardFilters.ts")).toContain("Any label");
    expect(source("boardFilters.ts")).not.toContain("Not ${");
    expect(source("boardFilters.ts")).not.toContain("not:");
    expect(filters).not.toContain("Not ");
  });

  it("reaches Kanban, Review and Plans, including Plans' own status facet", () => {
    expect(source("KanbanBoard.svelte")).toContain("<FacetFilters");
    expect(source("ReviewCardList.svelte")).toContain("<FacetFilters");
    expect(source("PlanExplorerHubView.svelte")).toContain("<FacetFilters");
    expect(source("PlanExplorerHubView.svelte")).toContain("<FacetDropdown");
    expect(source("PlanExplorerHubView.svelte")).toContain("Filter by status");
    expect(source("PlanExplorerHubView.svelte")).not.toMatch(/<select[^>]*Filter by status/);
  });
});
