import { describe, it, expect } from "vitest";

// The orchestration tab used to have ONE vertical scroll: the grid
// scrolled in both axes, rails were content-height (`align-items: start`)
// and each header held its place with `position: sticky`. That put every
// rail on a single scrollbar -- reading the bottom of a long rail pushed
// every OTHER rail's steps off the top, and the sticky headers were the
// only thing left saying which column you were in.
//
// It now follows the kanban: the strip scrolls sideways, and each rail is
// exactly one viewport tall and scrolls its own stages under a header
// fixed by layout. None of that is reachable from a unit test -- it is
// four CSS declarations and one data attribute spread across three files,
// and a browser is the only thing that can see it -- so this pins the
// declarations themselves, the way autoCommitSurfaces.test.ts pins its
// four surfaces.

const SVELTE = import.meta.glob("./*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const TS = import.meta.glob("./orchestrationDragGlue.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function source(name: string): string {
  const text = SVELTE[`./${name}`] ?? TS[`./${name}`];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

/// A module's source with its `//` comments stripped, so an assertion
/// about what the CODE does is not satisfied (or broken) by prose that
/// merely names the same identifier.
function codeOf(name: string): string {
  return source(name)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

/// The declaration block of one CSS rule, by selector, from a component's
/// `<style>`. Whitespace-collapsed, so a reformat does not fail the suite.
function ruleFor(file: string, selector: string): string {
  const text = source(file);
  const at = text.indexOf(`\n  ${selector} {`);
  if (at === -1) throw new Error(`no \`${selector}\` rule in ${file}`);
  const open = text.indexOf("{", at);
  const close = text.indexOf("}", open);
  return text.slice(open + 1, close).replace(/\s+/g, " ").trim();
}

const GRID = "OrchestrationHubView.svelte";
const RAIL = "OrchestrationRail.svelte";
const GLUE = "orchestrationDragGlue.ts";
const COLUMN = "KanbanColumn.svelte";

describe("the rail grid", () => {
  it("scrolls sideways only", () => {
    const grid = ruleFor(GRID, ".grid");
    expect(grid).toContain("overflow-x: auto");
    expect(grid).toContain("overflow-y: hidden");
    // The shorthand is what brought the shared vertical scroll back.
    expect(grid).not.toMatch(/overflow: /);
  });

  it("pins its one row track to its own height", () => {
    // Without a definite row track a rail taller than the viewport grows
    // the row instead of scrolling, and `overflow-y: hidden` then CLIPS
    // its steps rather than making them reachable -- strictly worse than
    // the shared scroll it replaced.
    expect(ruleFor(GRID, ".grid")).toContain("grid-template-rows: minmax(0, 1fr)");
  });

  it("lets the rails stretch to that track", () => {
    // `align-items: start` is the content-height rule; a rail that does
    // not fill the row cannot hand a full-height scroller to its body.
    expect(ruleFor(GRID, ".grid")).not.toContain("align-items: start");
  });
});

describe("a rail", () => {
  it("is a flex column that refuses to outgrow its track", () => {
    const rail = ruleFor(RAIL, ".rail");
    expect(rail).toContain("flex-direction: column");
    // The one declaration that makes the body scroll rather than the
    // column stretch -- flex items floor at their content height without
    // it, which is the same overflow by another route.
    expect(rail).toContain("min-height: 0");
  });

  it("keeps its header out of the scroller entirely", () => {
    const header = ruleFor(RAIL, "header");
    expect(header).toContain("flex: none");
    // Fixed by layout now. `position: sticky` was for a header INSIDE the
    // scrolled content; left behind it would be a dead declaration
    // implying a scroll ancestor that no longer exists.
    expect(header).not.toContain("position: sticky");
  });

  it("scrolls its stages in a body the drag glue can find", () => {
    expect(source(RAIL)).toContain('<div class="rail-body" data-orch-rail-body>');
    const body = ruleFor(RAIL, ".rail-body");
    expect(body).toContain("overflow-y: auto");
    expect(body).toContain("flex: 1 1 auto");
    expect(body).toContain("min-height: 0");
  });

  it("scrolls on the same three declarations a kanban column does", () => {
    // The card asked for the board's behaviour, not a second one that
    // merely looks like it.
    const cards = ruleFor(COLUMN, ".cards");
    const body = ruleFor(RAIL, ".rail-body");
    for (const decl of ["overflow-y: auto", "flex: 1 1 auto"]) {
      expect(cards).toContain(decl);
      expect(body).toContain(decl);
    }
  });
});

describe("drag auto-scroll", () => {
  it("nudges the rail under the pointer, not the grid, on y", () => {
    const glue = codeOf(GLUE);
    expect(glue).toContain('querySelector("[data-orch-rail-body]")');
    expect(glue).toContain("body.scrollTop += dy");
    // The grid keeps the x axis and only the x axis.
    expect(glue).toContain("scrollEl.scrollLeft += dx");
    expect(glue).not.toContain("scrollEl.scrollTop");
  });

  it("documents the attribute in the data-attribute contract", () => {
    expect(source(GLUE)).toContain("//   [data-orch-rail-body]");
  });
});
