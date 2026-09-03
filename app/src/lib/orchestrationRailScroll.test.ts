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
// a handful of CSS declarations and one data attribute spread across
// three files, and a browser is the only thing that can see it -- so this
// pins the declarations themselves, the way autoCommitSurfaces.test.ts
// pins its four surfaces.
//
// The strip was a CSS grid with one `minmax(0, 1fr)` row until 2026-09-03.
// WebKit resolves a grid's row track against the grid's height WITHOUT
// subtracting the grid's own horizontal scrollbar, so once the rails
// overflowed sideways under a legacy (mouse, or "always show") scrollbar,
// every rail was 17px taller than the space above the bar and
// `overflow-y: hidden` clipped its foot -- the Add step button -- under
// it. Measured in a WKWebView probe, not inferred: a 460px grid with a
// 17px bar resolved its 1fr row to 460px (so did `overflow-x: scroll`
// and a `100%` row), while the same strip as a flex row put the rail's
// bottom at 443px. Flex cross-axis stretch does subtract the bar, which
// is also how the kanban's own `.board` strip has always been laid out.

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
const COLUMN_STRIP = "KanbanBoard.svelte";

describe("the rail strip", () => {
  it("scrolls sideways only", () => {
    const strip = ruleFor(GRID, ".grid");
    expect(strip).toContain("overflow-x: auto");
    expect(strip).toContain("overflow-y: hidden");
    // The shorthand is what brought the shared vertical scroll back.
    expect(strip).not.toMatch(/overflow: /);
  });

  it("is a flex row, not a grid", () => {
    // The scrollbar bug above lives in grid track sizing: any row track
    // (`1fr`, `100%`, or a rail's own `height: 100%` inside the grid)
    // comes out the height of the grid INCLUDING its horizontal bar.
    // A flex row stretches its items to the height above the bar.
    const strip = ruleFor(GRID, ".grid");
    expect(strip).toContain("display: flex");
    expect(strip).not.toContain("display: grid");
    expect(strip).not.toContain("grid-template-rows");
    expect(strip).not.toContain("grid-auto-columns");
  });

  it("lets the rails stretch to its height", () => {
    // `align-items: start` (or `flex-start`) is the content-height rule;
    // a rail that does not fill the strip cannot hand a full-height
    // scroller to its body, and one that outgrows it is clipped.
    expect(ruleFor(GRID, ".grid")).not.toMatch(/align-items: (flex-)?start/);
  });

  it("scrolls on the same rule the kanban's column strip does", () => {
    // Follow the board literally, not a grid that happens to resemble it.
    const board = ruleFor(COLUMN_STRIP, ".board");
    const strip = ruleFor(GRID, ".grid");
    for (const decl of ["display: flex", "overflow-x: auto"]) {
      expect(board).toContain(decl);
      expect(strip).toContain(decl);
    }
  });
});

describe("a rail", () => {
  it("is a flex column that refuses to outgrow the strip", () => {
    const rail = ruleFor(RAIL, ".rail");
    expect(rail).toContain("flex-direction: column");
    // The one declaration that makes the body scroll rather than the
    // column stretch -- flex items floor at their content height without
    // it, which is the same overflow by another route.
    expect(rail).toContain("min-height: 0");
  });

  it("carries the strip's 280px column minimum as its own flex basis", () => {
    // The grid's `minmax(280px, 1fr)` column, spelled for a flex item: at
    // least 280px, growing equally with its siblings, never shrinking
    // below it -- the strip scrolls instead. Border-box, because the grid
    // track was the rail's outer width too.
    const rail = ruleFor(RAIL, ".rail");
    expect(rail).toContain("flex: 1 0 280px");
    expect(rail).toContain("box-sizing: border-box");
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
