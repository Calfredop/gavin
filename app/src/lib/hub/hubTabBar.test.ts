import { describe, it, expect } from "vitest";
import { svelteSources } from "$lib/sources";

// The Kanban and Orchestration tabs each open with a first row that is the
// same thing -- a search lens over a wide scrolling surface -- and the two
// had drifted apart. Kanban's search sat at an `<input>`'s default ~20
// characters (no flex-grow, and a 520px cap that a non-growing box never
// reaches) with no rule under the row, so the controls floated over the
// columns; Orchestration spent the left of its row on an "Orchestration"
// heading the hub's own tab strip had already said.
//
// Nothing links the two files, so the drift is invisible to every other
// suite and to a reader of either one. This pins the shape they now share.
// It reads the sources rather than the rendered DOM on purpose: a
// component `<style>` is compiled away, and vite hands SSR an empty string
// for a CSS import, so the declarations themselves are only legible here.

const SOURCES = svelteSources();

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

/// The declarations of one rule, by exact selector, as a trimmed map.
/// Crude by design -- these components have no nested at-rules around the
/// bars, so "the text between this selector's braces" is the rule.
function rule(componentSource: string, selector: string): Record<string, string> {
  const style = /<style[^>]*>([\s\S]*)<\/style>/.exec(componentSource);
  if (!style) throw new Error("component has no <style> block");
  const css = style[1].replace(/\/\*[\s\S]*?\*\//g, "");
  const found = new Map<string, string>();
  for (const [, prelude, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    found.set(prelude.trim().replace(/\s+/g, " "), body);
  }
  const body = found.get(selector);
  if (body === undefined) {
    throw new Error(`no rule for "${selector}" (saw: ${[...found.keys()].join(", ")})`);
  }
  const out: Record<string, string> = {};
  for (const decl of body.split(";")) {
    const at = decl.indexOf(":");
    if (at < 0) continue;
    out[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
  }
  return out;
}

describe("the hub tabs' first row", () => {
  const kanbanBar = rule(source("KanbanBoard.svelte"), ".board-bar");
  const orchBar = rule(source("OrchestrationHubView.svelte"), ".bar");
  const kanbanSearch = rule(source("KanbanBoard.svelte"), ".board-bar :global(.board-search)");
  const orchSearch = rule(source("OrchestrationHubView.svelte"), ".bar :global(.bar-search)");

  // Every first row under the header, plus the Scratchpad that sits
  // beside them. One height, one hairline: a literal in any of these
  // is how the band steps again the moment the header divider made
  // that step visible.
  const FIRST_ROWS: [string, string][] = [
    ["Sidebar.svelte", ".workspace-row.scratchpad"],
    ["KanbanBoard.svelte", ".board-bar"],
    ["OrchestrationHubView.svelte", ".bar"],
    ["WorkspaceToolsHubView.svelte", ".bar"],
    ["GitToolbar.svelte", ".toolbar"],
    ["FilesHubView.svelte", ".tree-head"],
    ["PlanExplorerHubView.svelte", ".sidebar-head"],
    ["FileEditor.svelte", ".modes"],
  ];

  it("draws a rule under both bars", () => {
    // Without it the lens reads as controls floating over the board rather
    // than as a bar the surface below belongs to.
    expect(kanbanBar["border-bottom"]).toBe("1px solid var(--border)");
    expect(orchBar["border-bottom"]).toBe("1px solid var(--border)");
  });

  it("gives both searches the same width", () => {
    // An input left at its default size is the narrow box this card was
    // filed about; the cap keeps it from swallowing a wide window.
    expect(kanbanSearch["flex"]).toBe("1 1 auto");
    expect(orchSearch["flex"]).toBe("1 1 auto");
    expect(kanbanSearch["max-width"]).toBe(orchSearch["max-width"]);
  });

  it("leaves the tab's name to the tab strip", () => {
    // The Orchestration tab is reached by a strip that spells its label,
    // so a heading inside it only repeated itself and cost the row width.
    expect(source("OrchestrationHubView.svelte")).not.toMatch(/<h2[\s>]/);
    expect(source("KanbanBoard.svelte")).not.toMatch(/<h2[\s>]/);
  });

  it("sizes every first row from the shared hub-bar height", () => {
    for (const [file, selector] of FIRST_ROWS) {
      const bar = rule(source(file), selector);
      expect(`${file} ${selector}: ${bar.height}`).toBe(
        `${file} ${selector}: var(--hub-bar-height)`
      );
      expect(`${file} ${selector}: ${bar["box-sizing"]}`).toBe(
        `${file} ${selector}: border-box`
      );
    }
    expect(rule(source("ReviewHubView.svelte"), ".review")["--review-strip-height"]).toBe(
      "var(--hub-bar-height)"
    );
    // Files and Plans sidebars are flex children: without a zero
    // min-height the search / + context button grows the row past the
    // band even when height is set.
    for (const [file, selector] of [
      ["FilesHubView.svelte", ".tree-head"],
      ["PlanExplorerHubView.svelte", ".sidebar-head"],
    ] as const) {
      const bar = rule(source(file), selector);
      expect(`${file}: ${bar["min-height"]}`).toBe(`${file}: 0`);
      expect(`${file}: ${bar["max-height"]}`).toBe(`${file}: var(--hub-bar-height)`);
    }
  });

  it("puts the PRD and agent pick row under the editor toolbar", () => {
    const editor = source("FileEditor.svelte");
    expect(editor.indexOf('class="modes"')).toBeLessThan(editor.indexOf("{@render afterToolbar()}"));
    for (const file of ["PrdHubView.svelte", "AgentFileHubView.svelte"]) {
      const text = source(file);
      expect(text).toContain("{#snippet afterToolbar()}");
      expect(text).toContain("<HubFilePicker");
      expect(text.indexOf("<FileEditor")).toBeLessThan(text.indexOf("<HubFilePicker"));
    }
  });

  it("draws the same hairline across the collapsed rail", () => {
    const sidebar = source("Sidebar.svelte");
    expect(rule(sidebar, ".collapsed-list .collapsed-row + .collapsed-row")["border-top"]).toBe(
      "1px solid var(--border)"
    );
    expect(rule(sidebar, ".sidebar.collapsed .footer-divider").margin).toBe("0");
    expect(rule(sidebar, ".rail-chrome .collapsed-row").height).toBe("var(--hub-bar-height)");
    expect(rule(sidebar, ".rail-chrome .collapsed-row")["border-bottom"]).toBe(
      "1px solid var(--border)"
    );
  });

  it("draws the workspace hairline on the top of each row", () => {
    expect(rule(source("Sidebar.svelte"), ".workspace-row")["border-top"]).toBe(
      "1px solid var(--border)"
    );
    // The Scratchpad is the first row: the header already owns that
    // seam, and a second rule there would be a double line.
    expect(rule(source("Sidebar.svelte"), ".workspace-row.scratchpad")["border-top"]).toBe(
      "none"
    );
    // Its BOTTOM is the hub-bar hairline, inside the 40px -- the same
    // edge Kanban's bar uses. A rule on the next workspace's top sat
    // one pixel lower.
    expect(rule(source("Sidebar.svelte"), ".workspace-row.scratchpad")["border-bottom"]).toBe(
      "1px solid var(--border)"
    );
  });
});
