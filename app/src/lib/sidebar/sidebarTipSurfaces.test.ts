import { describe, it, expect } from "vitest";
import { svelteSources } from "$lib/sources";

// The sidebar's names are ellipsized to fit a 200px row, so the tooltip
// is the only place the whole name can be read. Nothing computes these
// bubbles beyond handing over the name, so the wiring is checked where it
// lives -- in the component source, the way sidebarPinSurfaces.test.ts
// checks the pin.

const SOURCES = svelteSources();

const sidebar = (): string => {
  const text = SOURCES["Sidebar.svelte"];
  if (!text) throw new Error("no source for Sidebar.svelte");
  return text;
};

describe("the sidebar spells out names it has to cut short", () => {
  // On the name, not the row: mouseenter does not bubble, so a bubble on
  // the row would be taken over by the recap's and never handed back.
  it("gives a page's name its full text on hover", () => {
    expect(sidebar()).toMatch(/class="page-name"\s+use:tooltip=\{page\.name\}/);
  });

  it("opens a tab row's bubble with the row's own label", () => {
    expect(sidebar()).toContain("name: tabRowLabel(row),");
  });
});
