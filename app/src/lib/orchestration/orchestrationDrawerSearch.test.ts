import { describe, it, expect } from "vitest";
import { svelteSources } from "$lib/sources";

// The Orchestration drawer carries a quick filter of its own, over the
// three lists it holds: saved groups, tools, and the unplaced cards.
//
// The tab's box above it could never reach the first two -- it is a lens
// over the RAILS, and a tool has never been on a rail to be found -- and
// the tool list is the part of the panel that grows without bound, so a
// workspace with thirty saved tools had no way to reach one but scroll.
//
// Two things about it are only visible in the rendered template, which a
// unit test cannot mount, so they are pinned here the way
// orchestrationDrawerNoRails.test.ts pins the tab's body:
//
//   1. every list the panel draws comes from the FILTERED view, not from
//      the raw prop beside it -- one `{#each tools}` left behind is a
//      section the box silently does not filter;
//   2. a query here does NOT take dragging away. The hub unhooks its
//      drag engine while ITS box is set, because rails leave the grid
//      and a new-stage index measured over what is left drops the step
//      in the wrong slot. Nothing here moves a rail: a drawer row is
//      grabbed by its own id and dropped at an index measured in the
//      rails. So the drag attributes stay on the rows, and the hub's
//      lock keeps keying on the tab's query alone.

const SVELTE = svelteSources();

/// A component's source with its comments stripped -- `//` lines in the
/// script and `<!-- -->` blocks in the template -- so an assertion about
/// what the TEMPLATE does is not satisfied (or broken) by prose that
/// merely names the same string.
function codeOf(name: string): string {
  const text = SVELTE[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

describe("the drawer's own quick filter", () => {
  const drawer = codeOf("OrchestrationDrawer.svelte");
  const templateAt = drawer.indexOf("<aside class=\"drawer\"");
  const template = drawer.slice(templateAt);

  it("runs on the shared matcher rather than a hand-rolled one", () => {
    expect(drawer).toContain('import { searchDrawer } from "$lib/orchestration/orchestrationSearch"');
    expect(drawer).toMatch(/searchDrawer\(query, \{[^}]*templates[^}]*tools[^}]*groups[^}]*\}\)/s);
  });

  it("uses the app's one search box, not a bare input", () => {
    expect(drawer).toContain('import SearchInput from "$lib/ui/SearchInput.svelte"');
    expect(template).toMatch(/<SearchInput\b/);
    expect(template).not.toMatch(/<input\b/);
  });

  // A 32px rail has no room for a text box, and the panel's collapse is
  // the same gesture as putting it away.
  it("draws the box only while the panel is open", () => {
    const openGate = template.indexOf("{#if !collapsed}");
    expect(openGate).toBeGreaterThan(0);
    expect(template.indexOf("<SearchInput")).toBeGreaterThan(openGate);
  });

  it("draws every list from the filtered view, never from the raw prop", () => {
    expect(template).toContain("{#each view.templates as t");
    expect(template).toContain("{#each view.tools as tool");
    expect(template).toContain("{#each view.groups as group");
    for (const raw of ["{#each templates", "{#each tools", "{#each sortedTools", "{#each groups"]) {
      expect(template).not.toContain(raw);
    }
  });

  // A hit inside a section the human had rolled up would otherwise be
  // counted and not shown.
  it("forces both collapsible sections open while a query is running", () => {
    expect(drawer).toMatch(/sectionOpen\s*=\s*\([^)]*\)[^=]*=>\s*view\.filtering \|\| !/);
    expect(template).toContain("{#if sectionOpen(templatesCollapsed)}");
    expect(template).toContain("{#if sectionOpen(toolsCollapsed)}");
  });

  it("says what each section is showing out of what it holds", () => {
    expect(template).toContain("{view.templates.length}{view.filtering ? ` / ${view.templatesTotal}` : \"\"}");
    expect(template).toContain("{view.tools.length}{view.filtering ? ` / ${view.toolsTotal}` : \"\"}");
    // The header count owes both lenses: the tab's hides cards before
    // they ever reach this component, this one hides them here.
    expect(drawer).toContain("${view.cardsTotal + hiddenCount}");
  });

  it("keeps the drag handles on its rows, so a filtered panel still places", () => {
    for (const attr of ["data-orch-card", "data-orch-tool", "data-orch-template"]) {
      const at = template.indexOf(attr);
      expect(at).toBeGreaterThan(0);
      // The row's drag attribute turns on targetRailId and the compat
      // gates only. `query`/`view.filtering` must not appear in it.
      const decl = template.slice(at, template.indexOf("\n", at));
      expect(decl).not.toMatch(/view\.filtering|query/);
    }
  });
});

describe("the hub's drag lock still keys on the tab's box alone", () => {
  const hub = codeOf("OrchestrationHubView.svelte");

  it("locks dragging on the tab lens, which the drawer's box is not part of", () => {
    expect(hub).toContain("const filtering = $derived(lens.filtering)");
    expect(hub).toMatch(/if \(!bodyEl \|\| !gridEl \|\| filtering\) return;/);
  });

  // The drawer owns its query outright: nothing is passed down for it,
  // and nothing is read back up. Otherwise the tab's drag lock and the
  // panel's filter would be one switch again.
  it("hands the drawer no query and takes none back", () => {
    const at = hub.indexOf("<OrchestrationDrawer");
    expect(at).toBeGreaterThan(0);
    const props = hub.slice(at, hub.indexOf("/>", at));
    expect(props).toContain("filtering={lens.filtering}");
    expect(props).not.toMatch(/query|searchDrawer/);
  });
});
