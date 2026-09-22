import { describe, it, expect } from "vitest";
import {
  layoutNodeGraph,
  railColour,
  NODE_W,
  NODE_H,
  STAGE_GAP,
  MEMBER_GAP,
  PARALLEL_GAP,
  LANE_HEAD_W,
  LANE_PAD_X,
  RAIL_COLOURS,
  type GraphEdge,
  type GraphRect,
} from "$lib/orchestration/orchestrationNodes";
import type { Orchestration, Rail, Stage, StageMode, Step } from "$lib/orchestration/orchestration";
import { BUILTIN_TOOLS } from "$lib/orchestration/orchestrationTools";

let seq = 0;
function step(cardPath = `/p/card-${++seq}.md`): Step {
  return { id: `s${++seq}`, position: seq, cardPath, toolId: null, toolParams: {} };
}
function toolStep(toolId: string, toolParams: Record<string, string> = {}): Step {
  return { id: `t${++seq}`, position: seq, cardPath: "", toolId, toolParams };
}
function stage(steps: Step[], mode?: StageMode, name?: string): Stage {
  return { id: `g${++seq}`, position: seq, mode, name, steps: steps.map((s, i) => ({ ...s, position: i })) };
}
function rail(name: string, stages: Stage[], extra: Partial<Rail> = {}): Rail {
  return {
    id: `r${++seq}`,
    name,
    position: seq,
    worktreePath: null,
    pageId: null,
    stages: stages.map((s, i) => ({ ...s, position: i })),
    ...extra,
  };
}
function orch(rails: Rail[]): Orchestration {
  return {
    rails: rails.map((r, i) => ({ ...r, position: i })),
    conflictNotes: [],
    railRuns: [],
    stepRuns: [],
  };
}

function centreY(r: GraphRect): number {
  return r.y + r.h / 2;
}
function contains(outer: GraphRect, inner: GraphRect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}
function ofKind(edges: GraphEdge[], kind: GraphEdge["kind"]): GraphEdge[] {
  return edges.filter((e) => e.kind === kind);
}

// One node per step, one lane per rail, laid out by arithmetic alone --
// no DOM measuring -- so the component is a template over rectangles
// and the edges are strings it never has to compute.
describe("the node graph layout", () => {
  it("lays an empty plan out as nothing, with room for the lane head", () => {
    const g = layoutNodeGraph(orch([]), BUILTIN_TOOLS);
    expect(g.lanes).toEqual([]);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.height).toBe(0);
    expect(g.width).toBeGreaterThanOrEqual(LANE_HEAD_W + LANE_PAD_X);
  });

  it("flows a rail's stages left to right on one lane, an arrow between each pair", () => {
    const [a, b, c] = [step(), step(), step()];
    const g = layoutNodeGraph(orch([rail("Build", [stage([a]), stage([b]), stage([c])])]), BUILTIN_TOOLS);
    expect(g.lanes).toHaveLength(1);
    expect(g.nodes.map((n) => n.stepId)).toEqual([a.id, b.id, c.id]);
    const [na, nb, nc] = g.nodes;
    // Past the lane head, then one node width plus one arrow apart.
    expect(na.x).toBe(LANE_HEAD_W + LANE_PAD_X);
    expect(nb.x).toBe(na.x + NODE_W + STAGE_GAP);
    expect(nc.x).toBe(nb.x + NODE_W + STAGE_GAP);
    // Every node sits on the lane's centre line, so the arrows are level.
    for (const n of g.nodes) expect(centreY(n)).toBe(centreY(g.lanes[0]));
    const flows = ofKind(g.edges, "flow");
    expect(flows).toHaveLength(2);
    for (const e of flows) {
      expect(e.arrow).not.toBeNull();
      expect(e.colour).toBe(g.lanes[0].colour);
    }
    expect(flows[0].d).toBe(`M ${na.x + NODE_W} ${centreY(na)} L ${nb.x} ${centreY(nb)}`);
  });

  // The rail's own rule (orchestration.ts isGroup): a single-step stage
  // draws bare. Its box IS the node's box, and it wears no mode.
  it("draws a single-step stage as the bare node", () => {
    const s = step();
    const g = layoutNodeGraph(orch([rail("Build", [stage([s], "parallel", "Named")])]), BUILTIN_TOOLS);
    expect(g.stages).toHaveLength(1);
    expect(g.stages[0].mode).toBeNull();
    expect(g.stages[0].label).toBeNull();
    const { x, y, w, h } = g.nodes[0];
    expect(g.stages[0]).toMatchObject({ x, y, w, h });
  });

  // Sequence is drawn with the geometry the strip already uses for
  // order: a connector between members (grouping spec §4.1). Members
  // form a chain, and each link is an arrow.
  it("chains a sequence group's members left to right inside its box", () => {
    const [a, b, c] = [step(), step(), step()];
    const g = layoutNodeGraph(
      orch([rail("Build", [stage([a, b, c], "sequence", "Prep")])]),
      BUILTIN_TOOLS
    );
    const box = g.stages[0];
    expect(box.mode).toBe("sequence");
    expect(box.label).toBe("Prep");
    const [na, nb, nc] = g.nodes;
    expect(na.y).toBe(nb.y);
    expect(nb.y).toBe(nc.y);
    expect(nb.x).toBe(na.x + NODE_W + MEMBER_GAP);
    expect(nc.x).toBe(nb.x + NODE_W + MEMBER_GAP);
    for (const n of g.nodes) expect(contains(box, n)).toBe(true);
    const flows = ofKind(g.edges, "flow");
    expect(flows).toHaveLength(2);
    expect(flows.every((e) => e.arrow !== null)).toBe(true);
    // The members sit on the lane's centre line too: the arrow INTO the
    // group meets the chain without a kink.
    expect(centreY(na)).toBe(centreY(g.lanes[0]));
  });

  // Parallel is the enclosure, not the chain: members stack, and one
  // fan -- a bus with a stub to each member, no arrowheads -- says they
  // start together.
  it("stacks a parallel group's members behind one fan", () => {
    const [a, b, c] = [step(), step(), step()];
    const g = layoutNodeGraph(orch([rail("Build", [stage([a, b, c], "parallel")])]), BUILTIN_TOOLS);
    const box = g.stages[0];
    expect(box.mode).toBe("parallel");
    // Positional fallback, exactly the strip's `stage N`.
    expect(box.label).toBe("stage 1");
    const [na, nb, nc] = g.nodes;
    expect(na.x).toBe(nb.x);
    expect(nb.x).toBe(nc.x);
    expect(nb.y).toBe(na.y + NODE_H + PARALLEL_GAP);
    expect(nc.y).toBe(nb.y + NODE_H + PARALLEL_GAP);
    for (const n of g.nodes) expect(contains(box, n)).toBe(true);
    expect(ofKind(g.edges, "flow")).toEqual([]);
    const fans = ofKind(g.edges, "fan");
    expect(fans).toHaveLength(1);
    expect(fans[0].arrow).toBeNull();
    // The middle member is on the lane's centre line: the stack is
    // centred on the flow, not hung below it.
    expect(centreY(nb)).toBe(centreY(g.lanes[0]));
  });

  // A stage written before groups existed has no mode and reads as
  // parallel, the way stageMode() reads it everywhere else.
  it("reads a mode-less group as parallel", () => {
    const g = layoutNodeGraph(orch([rail("Build", [stage([step(), step()])])]), BUILTIN_TOOLS);
    expect(g.stages[0].mode).toBe("parallel");
  });

  it("stacks lanes top to bottom in rail order, none overlapping", () => {
    const g = layoutNodeGraph(
      orch([rail("One", [stage([step()])]), rail("Two", [stage([step(), step()], "parallel")]), rail("Three", [])]),
      BUILTIN_TOOLS
    );
    expect(g.lanes.map((l) => l.rail.name)).toEqual(["One", "Two", "Three"]);
    for (let i = 1; i < g.lanes.length; i++) {
      expect(g.lanes[i].y).toBeGreaterThanOrEqual(g.lanes[i - 1].y + g.lanes[i - 1].h);
    }
    // An empty rail still gets a lane -- it is a rail the human can see
    // and start filling -- and every rect is inside the canvas.
    const all: GraphRect[] = [...g.lanes, ...g.stages, ...g.nodes];
    for (const r of all) {
      expect(r.x + r.w).toBeLessThanOrEqual(g.width);
      expect(r.y + r.h).toBeLessThanOrEqual(g.height);
    }
  });

  // Categorical, not semantic: the palette exists so adjacent lanes
  // differ, and it cycles once the rails outnumber it.
  it("gives each rail a colour by its position, cycling past the palette", () => {
    expect(railColour(0)).toBe(1);
    expect(railColour(RAIL_COLOURS - 1)).toBe(RAIL_COLOURS);
    expect(railColour(RAIL_COLOURS)).toBe(1);
    const rails = Array.from({ length: RAIL_COLOURS + 1 }, (_, i) => rail(`R${i}`, []));
    const g = layoutNodeGraph(orch(rails), BUILTIN_TOOLS);
    expect(g.lanes.map((l) => l.colour)).toEqual([...Array.from({ length: RAIL_COLOURS }, (_, i) => i + 1), 1]);
  });

  // The search lens takes rails out of the strip; it takes them out of
  // the graph the same way -- and a rail keeps the colour it had, so
  // filtering does not recolour what is left.
  it("leaves out rails the lens hides, without recolouring the rest", () => {
    const hidden = rail("Hidden", [stage([step()])]);
    const kept = rail("Kept", [stage([step()])]);
    const g = layoutNodeGraph(orch([hidden, kept]), BUILTIN_TOOLS, (id) => id !== hidden.id);
    expect(g.lanes.map((l) => l.railId)).toEqual([kept.id]);
    expect(g.lanes[0].colour).toBe(2);
    expect(g.nodes.every((n) => n.railId === kept.id)).toBe(true);
  });
});

// The one edge a step can draw between rails: `builtin:start-rail` names
// the rail it arms, by name, in a parameter. Resolved the way the
// scheduler resolves it (startRailVerdict) -- case- and
// space-insensitively, uniquely, never itself.
describe("start-rail arrows", () => {
  const START = "builtin:start-rail";

  it("draws an arrow from the step to the rail it names", () => {
    const starter = toolStep(START, { rail: " deploy " });
    const from = rail("Build", [stage([step()]), stage([starter])]);
    const to = rail("Deploy", [stage([step()])]);
    const g = layoutNodeGraph(orch([from, to]), BUILTIN_TOOLS);
    const starts = ofKind(g.edges, "starts");
    expect(starts).toHaveLength(1);
    const edge = starts[0];
    // The SOURCE rail's colour: the arrow says who fires whom.
    expect(edge.colour).toBe(g.lanes[0].colour);
    expect(edge.arrow).not.toBeNull();
    // Lands on the target rail's first stage, on its centre line.
    const target = g.stages.find((s) => s.railId === to.id) as GraphRect;
    expect(edge.d.endsWith(`${target.x} ${centreY(target)}`)).toBe(true);
    // Nothing to say in words when the arrow says it.
    expect(g.nodes.find((n) => n.stepId === starter.id)?.note).toBeNull();
  });

  it("lands on the lane's head when the target rail has no stages yet", () => {
    const starter = toolStep(START, { rail: "Deploy" });
    const g = layoutNodeGraph(orch([rail("Build", [stage([starter])]), rail("Deploy", [])]), BUILTIN_TOOLS);
    const edge = ofKind(g.edges, "starts")[0];
    const lane = g.lanes[1];
    expect(edge.d.endsWith(`${LANE_HEAD_W + LANE_PAD_X} ${centreY(lane)}`)).toBe(true);
  });

  it.each([
    ["no name", {}, /no rail named/],
    ["a rail that does not exist", { rail: "Ship" }, /no rail called “Ship”/],
    ["a name two rails share", { rail: "Twin" }, /names 2 rails/],
    ["its own rail", { rail: "Build" }, /cannot start itself/],
  ])("warns on the step instead of drawing, for %s", (_, params, reason) => {
    const starter = toolStep(START, params);
    const g = layoutNodeGraph(
      orch([rail("Build", [stage([starter])]), rail("Twin", []), rail("Twin", [])]),
      BUILTIN_TOOLS
    );
    expect(ofKind(g.edges, "starts")).toEqual([]);
    const note = g.nodes.find((n) => n.stepId === starter.id)?.note;
    expect(note?.warn).toBe(true);
    expect(note?.tip).toMatch(reason);
  });

  // A target in another workspace has no lane here to point at. Named
  // in words, and not as a warning: the step is fine, the rail is
  // simply on another board.
  it("names a rail in another workspace rather than pointing at nothing", () => {
    const starter = toolStep(START, { rail: "Deploy", workspace: "ws-other" });
    const g = layoutNodeGraph(orch([rail("Build", [stage([starter])])]), BUILTIN_TOOLS);
    expect(ofKind(g.edges, "starts")).toEqual([]);
    const note = g.nodes[0].note;
    expect(note?.warn).toBe(false);
    expect(note?.text).toMatch(/another workspace/);
  });

  it("names the target in words when the lens has hidden its lane", () => {
    const starter = toolStep(START, { rail: "Deploy" });
    const to = rail("Deploy", [stage([step()])]);
    const g = layoutNodeGraph(orch([rail("Build", [stage([starter])]), to]), BUILTIN_TOOLS, (id) => id !== to.id);
    expect(ofKind(g.edges, "starts")).toEqual([]);
    expect(g.nodes[0].note?.text).toBe("starts “Deploy”");
    expect(g.nodes[0].note?.warn).toBe(false);
  });

  it("draws nothing for a tool step that is not a start-rail", () => {
    const g = layoutNodeGraph(
      orch([rail("Build", [stage([toolStep("builtin:run-tests")])]), rail("Deploy", [])]),
      BUILTIN_TOOLS
    );
    expect(ofKind(g.edges, "starts")).toEqual([]);
    expect(g.nodes[0].note).toBeNull();
  });
});

// The other cross-rail fact, read the other way round: a rail's trigger
// says what IT waits for. Drawn dashed, in the waiting rail's colour,
// because the wait belongs to the rail that declared it.
describe("trigger arrows", () => {
  it("draws a dashed arrow from the named rail's end to the waiting rail's start", () => {
    const first = rail("Build", [stage([step()]), stage([step()])]);
    const waits = rail("Deploy", [stage([step()])], { trigger: { kind: "rail-done", rail: "build" } });
    const g = layoutNodeGraph(orch([first, waits]), BUILTIN_TOOLS);
    const edges = ofKind(g.edges, "waits");
    expect(edges).toHaveLength(1);
    const edge = edges[0];
    expect(edge.colour).toBe(g.lanes[1].colour);
    expect(edge.dashed).toBe(true);
    expect(edge.arrow).not.toBeNull();
    const last = g.stages.filter((s) => s.railId === first.id).at(-1) as GraphRect;
    const target = g.stages.find((s) => s.railId === waits.id) as GraphRect;
    expect(edge.d.startsWith(`M ${last.x + last.w} ${centreY(last)}`)).toBe(true);
    expect(edge.d.endsWith(`${target.x} ${centreY(target)}`)).toBe(true);
    // The lane says the same in the chip's own words.
    expect(g.lanes[1].note).toEqual({ text: "after “build”", warn: false, tip: expect.stringMatching(/waiting for/) });
  });

  // Fan-in from every rail is a sentence, not N arrows.
  it("labels an after-all-rails trigger instead of drawing every arrow", () => {
    const g = layoutNodeGraph(
      orch([rail("A", [stage([step()])]), rail("B", [], { trigger: { kind: "all-rails-done" } })]),
      BUILTIN_TOOLS
    );
    expect(ofKind(g.edges, "waits")).toEqual([]);
    expect(g.lanes[1].note?.text).toBe("after all rails");
    expect(g.lanes[1].note?.warn).toBe(false);
  });

  it("warns on the lane for a trigger that can never fire", () => {
    const g = layoutNodeGraph(
      orch([rail("A", [], { trigger: { kind: "rail-done", rail: "A" } })]),
      BUILTIN_TOOLS
    );
    expect(ofKind(g.edges, "waits")).toEqual([]);
    expect(g.lanes[0].note?.warn).toBe(true);
    expect(g.lanes[0].note?.tip).toMatch(/cannot wait for itself/);
  });

  it("keeps the label but drops the arrow when the lens hides the named rail", () => {
    const first = rail("Build", [stage([step()])]);
    const waits = rail("Deploy", [], { trigger: { kind: "rail-done", rail: "Build" } });
    const g = layoutNodeGraph(orch([first, waits]), BUILTIN_TOOLS, (id) => id !== first.id);
    expect(ofKind(g.edges, "waits")).toEqual([]);
    expect(g.lanes[0].note?.text).toBe("after “Build”");
  });
});
