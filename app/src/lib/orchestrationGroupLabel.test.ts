import { describe, it, expect } from "vitest";
import { svelteSources } from "$lib/sources";

// A group's label is drawn twice -- by its header on the rail, and by the
// drag ghost while it flies -- and nothing links those two files. The
// ghost used to carry a hardcoded "Group", which type-checks, renders
// fine and tells a human dragging one group past three others nothing
// about which one they are holding. stageLabel is now the single
// spelling; this pins both surfaces to it, since neither a component
// `<style>` nor a template literal is reachable from the pure suite.
//
// Reads the component sources rather than the rendered DOM, following
// autoCommitSurfaces.test.ts.

const SOURCES = svelteSources();

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

const RAIL = "OrchestrationRail.svelte";
const GHOST = "OrchestrationDragPreview.svelte";

describe("a group's label", () => {
  it("is drawn by the rail header through the shared helper", () => {
    expect(source(RAIL)).toContain("{stageLabel(stage, i)}");
  });

  it("is drawn by the drag ghost through the shared helper", () => {
    // By id, because the ghost renders outside the rail and has only the
    // stage id the glue put in the drag state.
    expect(source(GHOST)).toContain("stageLabelById(orch, id)");
  });

  it("is never a second copy of the positional fallback", () => {
    // The two surfaces agreeing is the whole point: a fallback spelled
    // out again in either file is free to drift from the other.
    for (const name of [RAIL, GHOST]) {
      expect(source(name)).not.toContain("`stage ${");
    }
  });
});
