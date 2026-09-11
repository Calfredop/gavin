import { describe, it, expect } from "vitest";
import { svelteSources } from "$lib/sources";

// With no rails the Orchestration tab used to render ONE paragraph --
// "No rails yet" -- in place of its whole body, and the body is what
// holds the unplaced drawer. So the drawer, the panel listing the cards
// and tools a rail is built FROM, was withheld exactly when the workspace
// had nothing built yet. The drawer already took `targetRailId: null`
// and went inert on it (its rows disable, its hint says why); only the
// template's branch kept it off screen.
//
// A rendered tab is out of a unit test's reach, so this pins the
// template's shape the way orchestrationRailScroll.test.ts pins its
// declarations: the body (grid + drawer) is gated on the plan having
// LOADED, never on the rail count, and the empty-state copy lives inside
// the grid next to the drawer, where the filtered "no rail matches" copy
// already does.

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

describe("the unplaced drawer stands even with no rails", () => {
  const hub = codeOf("OrchestrationHubView.svelte");
  // From the loaded-gate on: the markup that decides what the tab's
  // lower half is.
  const loadedGate = hub.indexOf("{#if !orch}");
  const template = hub.slice(loadedGate);

  it("gates the body on the plan having loaded, never on the rail count", () => {
    expect(loadedGate).toBeGreaterThan(0);
    const bodyAt = template.indexOf('<div class="body"');
    expect(bodyAt).toBeGreaterThan(0);
    const gate = template.slice(0, bodyAt);
    expect(gate).not.toMatch(/rails\.length/);
    expect(gate).not.toContain("No rails yet");
  });

  it("puts the “No rails yet” copy inside the grid, beside the drawer", () => {
    const gridAt = template.indexOf('<div class="grid"');
    const emptyAt = template.indexOf("No rails yet");
    const drawerAt = template.indexOf("<OrchestrationDrawer");
    expect(gridAt).toBeGreaterThan(0);
    expect(emptyAt).toBeGreaterThan(gridAt);
    expect(drawerAt).toBeGreaterThan(emptyAt);
  });

  it("hands the drawer a null target rail rather than withholding the drawer", () => {
    expect(template).toMatch(/targetRailId=\{rails\[0\]\?\.id \?\? null\}/);
  });

  it("the drawer tells the human to add a rail when there is none to place onto", () => {
    const drawer = codeOf("OrchestrationDrawer.svelte");
    // The no-rail hint is the FIRST branch of the drawer's hint line --
    // ahead of the search and drag hints, which presume a rail -- not a
    // case folded into the generic "drag onto a rail" copy.
    expect(drawer).toMatch(/\{#if !targetRailId\}/);
    expect(drawer).toContain("+ Rail");
  });

  it("withholds every drawer row's drag handle while there is no rail", () => {
    const drawer = codeOf("OrchestrationDrawer.svelte");
    // The drag glue takes ANY row wearing the attribute as a drag
    // subject on pointerdown, disabled or not, so `disabled` alone is a
    // look, not a lock: the attribute itself has to go, the way a
    // blocked tool row already loses its handle.
    expect(drawer).toMatch(/data-orch-card=\{targetRailId \? entry\.plan\.path : undefined\}/);
    expect(drawer).toMatch(/data-orch-tool=\{blocked \|\| !targetRailId \? undefined : tool\.id\}/);
    expect(drawer).toMatch(/data-orch-template=\{groupsBlocked \|\| !targetRailId \? undefined : t\.id\}/);
  });
});
