import { describe, it, expect } from "vitest";
import {
  layoutNodeGraph,
  orderRails,
  railColour,
  laneX,
  rowY,
  ARRIVE,
  LANE_W,
  ROW_H,
  RAIL_COLOURS,
  type GraphEdge,
  type GraphRow,
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

type StepRow = Extract<GraphRow, { kind: "step" }>;
type RailRow = Extract<GraphRow, { kind: "rail" }>;
function stepRows(rows: GraphRow[]): StepRow[] {
  return rows.filter((r): r is StepRow => r.kind === "step");
}
function railRows(rows: GraphRow[]): RailRow[] {
  return rows.filter((r): r is RailRow => r.kind === "rail");
}
function ofKind(edges: GraphEdge[], kind: GraphEdge["kind"]): GraphEdge[] {
  return edges.filter((e) => e.kind === kind);
}
function dot(row: { row: number; lane: number }): string {
  return `${laneX(row.lane)} ${rowY(row.row)}`;
}

// One row per step, one lane per rail, the commit graph's own geometry:
// a dot's centre is a function of (row, lane) and nothing is measured.
describe("the node graph layout", () => {
  it("lays an empty plan out as no rows", () => {
    const g = layoutNodeGraph(orch([]), BUILTIN_TOOLS);
    expect(g.rows).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.height).toBe(0);
    expect(g.lanes).toBe(0);
    expect(g.width).toBe(LANE_W);
  });

  it("gives a rail a head row and one row per step, down its own lane", () => {
    const [a, b, c] = [step(), step(), step()];
    const g = layoutNodeGraph(orch([rail("Build", [stage([a]), stage([b]), stage([c])])]), BUILTIN_TOOLS);
    expect(g.rows.map((r) => r.kind)).toEqual(["rail", "step", "step", "step"]);
    expect(g.rows.map((r) => r.row)).toEqual([0, 1, 2, 3]);
    expect(g.rows.every((r) => r.lane === 0)).toBe(true);
    expect(stepRows(g.rows).map((r) => r.stepId)).toEqual([a.id, b.id, c.id]);
    expect(g.height).toBe(4 * ROW_H);
    expect(g.lanes).toBe(1);
    // The line joins the head to the last dot on the lane, and nothing
    // else is drawn: order is the line, and needs no arrowheads.
    expect(g.edges).toHaveLength(1);
    const line = g.edges[0];
    expect(line.kind).toBe("rail");
    expect(line.colour).toBe(g.rows[0].colour);
    expect(line.d).toBe(`M ${laneX(0)} ${rowY(0)} L ${laneX(0)} ${rowY(3)}`);
  });

  it("draws a rail with no steps as its head alone", () => {
    const g = layoutNodeGraph(orch([rail("Empty", [])]), BUILTIN_TOOLS);
    expect(g.rows.map((r) => r.kind)).toEqual(["rail"]);
    expect(g.edges).toEqual([]);
  });

  // The strip's own rule (isGroup): a single-step stage is not a group,
  // whatever mode it was written with.
  it("marks a single-step stage with no group", () => {
    const g = layoutNodeGraph(orch([rail("Build", [stage([step()], "parallel", "Named")])]), BUILTIN_TOOLS);
    expect(stepRows(g.rows)[0].group).toBeNull();
  });

  // Sequence is the straight run: the same line, the members one row
  // after another on the rail's lane, and the group only named.
  it("runs a sequence group straight down the lane, its rows marked", () => {
    const [a, b, c] = [step(), step(), step()];
    const g = layoutNodeGraph(
      orch([rail("Build", [stage([a, b, c], "sequence", "Prep")])]),
      BUILTIN_TOOLS
    );
    const members = stepRows(g.rows);
    expect(members.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(members.map((r) => r.row)).toEqual([1, 2, 3]);
    expect(members.map((r) => r.group?.mode)).toEqual(["sequence", "sequence", "sequence"]);
    expect(members.map((r) => r.group?.label)).toEqual(["Prep", "Prep", "Prep"]);
    expect(members.map((r) => r.group?.first)).toEqual([true, false, false]);
    expect(members.map((r) => r.group?.last)).toEqual([false, false, true]);
    expect(ofKind(g.edges, "fork")).toEqual([]);
    expect(ofKind(g.edges, "join")).toEqual([]);
    expect(g.lanes).toBe(1);
  });

  // Parallel is the fork: the first member stays on the lane, every
  // other takes the lane beside it -- one row each -- and each leaves
  // the line at the row before the group and rejoins it at the next
  // stage, the shape a branch and its merge have in the commit graph.
  it("forks a parallel group into the lanes beside the rail's and merges it back", () => {
    const before = step();
    const [a, b, c] = [step(), step(), step()];
    const after = step();
    const g = layoutNodeGraph(
      orch([rail("Build", [stage([before]), stage([a, b, c], "parallel"), stage([after])])]),
      BUILTIN_TOOLS
    );
    const rows = stepRows(g.rows);
    const [rb, ra, rb2, rc, rAfter] = rows;
    expect(rb.lane).toBe(0);
    expect([ra.lane, rb2.lane, rc.lane]).toEqual([0, 1, 2]);
    expect([ra.row, rb2.row, rc.row]).toEqual([2, 3, 4]);
    expect(rAfter.lane).toBe(0);
    expect(rAfter.row).toBe(5);
    // Positional fallback, exactly the strip's `stage N`.
    expect(ra.group?.label).toBe("stage 2");
    expect(g.lanes).toBe(3);
    expect(g.width).toBe(3 * LANE_W);
    const forks = ofKind(g.edges, "fork");
    expect(forks.map((e) => e.id).sort()).toEqual([`fork:${b.id}`, `fork:${c.id}`].sort());
    // From the last dot on the lane before the group...
    for (const fork of forks) expect(fork.d.startsWith(`M ${dot(rb)}`)).toBe(true);
    expect(forks.find((e) => e.id === `fork:${c.id}`)?.d.endsWith(dot(rc))).toBe(true);
    // ...and back into the next stage's dot.
    const joins = ofKind(g.edges, "join");
    expect(joins).toHaveLength(2);
    for (const join of joins) expect(join.d.endsWith(dot(rAfter))).toBe(true);
    expect(joins.find((e) => e.id === `join:${c.id}`)?.d.startsWith(`M ${dot(rc)}`)).toBe(true);
    // The rail's own line runs through to the stage after the fork.
    expect(ofKind(g.edges, "rail")[0].d.endsWith(`${laneX(0)} ${rowY(5)}`)).toBe(true);
    // No arrowheads inside a rail: forks and merges are lines.
    expect(g.edges.filter((e) => e.kind !== "starts" && e.kind !== "waits").every((e) => e.arrow === null)).toBe(true);
  });

  it("ends a rail's line at its last dot on the lane when a fork is last", () => {
    const [a, b] = [step(), step()];
    const g = layoutNodeGraph(orch([rail("Build", [stage([a, b], "parallel")])]), BUILTIN_TOOLS);
    const [ra] = stepRows(g.rows);
    expect(ofKind(g.edges, "join")).toEqual([]);
    expect(ofKind(g.edges, "rail")[0].d.endsWith(`${laneX(0)} ${rowY(ra.row)}`)).toBe(true);
  });

  // A stage written before groups existed has no mode and reads as
  // parallel, the way stageMode() reads it everywhere else.
  it("reads a mode-less group as parallel", () => {
    const g = layoutNodeGraph(orch([rail("Build", [stage([step(), step()])])]), BUILTIN_TOOLS);
    expect(stepRows(g.rows)[0].group?.mode).toBe("parallel");
    expect(g.lanes).toBe(2);
  });

  // Rails follow one another down the page, each on lanes of its own,
  // wide enough for its widest fork -- so a fork never lands on the
  // next rail's line.
  it("gives each rail its own lanes, as many as its widest fork", () => {
    const g = layoutNodeGraph(
      orch([
        rail("One", [stage([step()])]),
        rail("Two", [stage([step(), step(), step()], "parallel")]),
        rail("Three", []),
      ]),
      BUILTIN_TOOLS
    );
    expect(railRows(g.rows).map((r) => [r.rail.name, r.lane])).toEqual([
      ["One", 0],
      ["Two", 1],
      ["Three", 4],
    ]);
    expect(g.lanes).toBe(5);
    expect(g.rows.map((r) => r.row)).toEqual(g.rows.map((_, i) => i));
    expect(g.height).toBe(g.rows.length * ROW_H);
  });

  // Categorical, not semantic: the palette exists so adjacent lanes
  // differ, and it cycles once the rails outnumber it.
  it("gives each rail a colour by its position, cycling past the palette", () => {
    expect(railColour(0)).toBe(1);
    expect(railColour(RAIL_COLOURS - 1)).toBe(RAIL_COLOURS);
    expect(railColour(RAIL_COLOURS)).toBe(1);
    const rails = Array.from({ length: RAIL_COLOURS + 1 }, (_, i) => rail(`R${i}`, []));
    const g = layoutNodeGraph(orch(rails), BUILTIN_TOOLS);
    expect(railRows(g.rows).map((r) => r.colour)).toEqual([
      ...Array.from({ length: RAIL_COLOURS }, (_, i) => i + 1),
      1,
    ]);
  });

  // The search lens takes rails out of the strip; it takes them out of
  // the graph the same way -- and a rail keeps the colour it had, so
  // filtering does not recolour what is left.
  it("leaves out rails the lens hides, without recolouring the rest", () => {
    const hidden = rail("Hidden", [stage([step()])]);
    const kept = rail("Kept", [stage([step()])]);
    const g = layoutNodeGraph(orch([hidden, kept]), BUILTIN_TOOLS, (id) => id !== hidden.id);
    expect(railRows(g.rows).map((r) => r.railId)).toEqual([kept.id]);
    expect(railRows(g.rows)[0].colour).toBe(2);
    expect(railRows(g.rows)[0].lane).toBe(0);
    expect(g.rows.every((r) => r.railId === kept.id)).toBe(true);
  });
});

// Reading order: a rail another rail starts comes after it, so the curve
// between them runs down the page. Position breaks every tie.
describe("the rail order", () => {
  const START = "builtin:start-rail";

  it("keeps position order when nothing starts anything", () => {
    const o = orch([rail("B", []), rail("A", [])]);
    expect(orderRails(o, BUILTIN_TOOLS).map((r) => r.name)).toEqual(["B", "A"]);
  });

  it("puts a rail after the rail whose step starts it", () => {
    const o = orch([rail("Deploy", []), rail("Build", [stage([toolStep(START, { rail: "Deploy" })])])]);
    expect(orderRails(o, BUILTIN_TOOLS).map((r) => r.name)).toEqual(["Build", "Deploy"]);
  });

  it("puts a rail after the rail it waits for", () => {
    const o = orch([rail("Deploy", [], { trigger: { kind: "rail-done", rail: "build" } }), rail("Build", [])]);
    expect(orderRails(o, BUILTIN_TOOLS).map((r) => r.name)).toEqual(["Build", "Deploy"]);
  });

  it("falls back to position on a cycle", () => {
    const o = orch([
      rail("A", [stage([toolStep(START, { rail: "B" })])]),
      rail("B", [stage([toolStep(START, { rail: "A" })])]),
      rail("C", []),
    ]);
    expect(orderRails(o, BUILTIN_TOOLS).map((r) => r.name)).toEqual(["A", "B", "C"]);
  });

  it("orders the graph's rows the same way", () => {
    const o = orch([rail("Deploy", []), rail("Build", [stage([toolStep(START, { rail: "Deploy" })])])]);
    const g = layoutNodeGraph(o, BUILTIN_TOOLS);
    expect(railRows(g.rows).map((r) => r.rail.name)).toEqual(["Build", "Deploy"]);
    // Colour still follows POSITION, not reading order.
    expect(railRows(g.rows).map((r) => r.colour)).toEqual([2, 1]);
  });
});

// The one edge a step can draw between rails: `builtin:start-rail` names
// the rail it arms, by name, in a parameter. Resolved the way the
// scheduler resolves it (startRailVerdict) -- case- and
// space-insensitively, uniquely, never itself.
describe("start-rail arrows", () => {
  const START = "builtin:start-rail";

  it("curves from the step's dot down to the head of the rail it names", () => {
    const starter = toolStep(START, { rail: " deploy " });
    const from = rail("Build", [stage([step()]), stage([starter])]);
    const to = rail("Deploy", [stage([step()])]);
    const g = layoutNodeGraph(orch([from, to]), BUILTIN_TOOLS);
    const starts = ofKind(g.edges, "starts");
    expect(starts).toHaveLength(1);
    const edge = starts[0];
    const source = stepRows(g.rows).find((r) => r.stepId === starter.id) as StepRow;
    const head = railRows(g.rows).find((r) => r.railId === to.id) as RailRow;
    // The SOURCE rail's colour: the arrow says who fires whom.
    expect(edge.colour).toBe(source.colour);
    expect(edge.d.startsWith(`M ${dot(source)}`)).toBe(true);
    // Stops short of the head dot, so the arrowhead is not under it.
    expect(edge.d.endsWith(`${laneX(head.lane)} ${rowY(head.row) - ARRIVE}`)).toBe(true);
    expect(edge.arrow).not.toBeNull();
    // Nothing to say in words when the arrow says it.
    expect(source.note).toBeNull();
  });

  it("points at the head even when the target rail has no steps", () => {
    const starter = toolStep(START, { rail: "Deploy" });
    const g = layoutNodeGraph(orch([rail("Build", [stage([starter])]), rail("Deploy", [])]), BUILTIN_TOOLS);
    const head = railRows(g.rows)[1];
    expect(ofKind(g.edges, "starts")[0].d.endsWith(`${laneX(head.lane)} ${rowY(head.row) - ARRIVE}`)).toBe(true);
  });

  it.each([
    ["no name", {}, /no rail named/],
    ["a rail that does not exist", { rail: "Ship" }, /no rail called “Ship”/],
    ["a name two rails share", { rail: "Twin" }, /names 2 rails/],
    ["its own rail", { rail: "Build" }, /cannot start itself/],
  ])("warns on the row instead of drawing, for %s", (_, params, reason) => {
    const starter = toolStep(START, params);
    const g = layoutNodeGraph(
      orch([rail("Build", [stage([starter])]), rail("Twin", []), rail("Twin", [])]),
      BUILTIN_TOOLS
    );
    expect(ofKind(g.edges, "starts")).toEqual([]);
    const note = stepRows(g.rows).find((r) => r.stepId === starter.id)?.note;
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
    const note = stepRows(g.rows)[0].note;
    expect(note?.warn).toBe(false);
    expect(note?.text).toMatch(/another workspace/);
  });

  it("names the target in words when the lens has hidden it", () => {
    const starter = toolStep(START, { rail: "Deploy" });
    const to = rail("Deploy", [stage([step()])]);
    const g = layoutNodeGraph(orch([rail("Build", [stage([starter])]), to]), BUILTIN_TOOLS, (id) => id !== to.id);
    expect(ofKind(g.edges, "starts")).toEqual([]);
    expect(stepRows(g.rows)[0].note?.text).toBe("starts “Deploy”");
    expect(stepRows(g.rows)[0].note?.warn).toBe(false);
  });

  it("draws nothing for a tool step that is not a start-rail", () => {
    const g = layoutNodeGraph(
      orch([rail("Build", [stage([toolStep("builtin:run-tests")])]), rail("Deploy", [])]),
      BUILTIN_TOOLS
    );
    expect(ofKind(g.edges, "starts")).toEqual([]);
    expect(stepRows(g.rows)[0].note).toBeNull();
  });
});

// The other cross-rail fact, read the other way round: a rail's trigger
// says what IT waits for. Drawn dashed, in the waiting rail's colour,
// because the wait belongs to the rail that declared it.
describe("trigger arrows", () => {
  it("curves dashed from the end of the named rail to the waiting rail's head", () => {
    const first = rail("Build", [stage([step()]), stage([step()])]);
    const waits = rail("Deploy", [stage([step()])], { trigger: { kind: "rail-done", rail: "build" } });
    const g = layoutNodeGraph(orch([first, waits]), BUILTIN_TOOLS);
    const edges = ofKind(g.edges, "waits");
    expect(edges).toHaveLength(1);
    const edge = edges[0];
    const head = railRows(g.rows).find((r) => r.railId === waits.id) as RailRow;
    const last = stepRows(g.rows).filter((r) => r.railId === first.id).at(-1) as StepRow;
    expect(edge.colour).toBe(head.colour);
    expect(edge.dashed).toBe(true);
    expect(edge.arrow).not.toBeNull();
    expect(edge.d.startsWith(`M ${dot(last)}`)).toBe(true);
    expect(edge.d.endsWith(`${laneX(head.lane)} ${rowY(head.row) - ARRIVE}`)).toBe(true);
    // The head row says the same in the chip's own words.
    expect(head.note).toEqual({ text: "after “build”", warn: false, tip: expect.stringMatching(/waiting for/) });
  });

  // Fan-in from every rail is a sentence, not N arrows.
  it("labels an after-all-rails trigger instead of drawing every arrow", () => {
    const g = layoutNodeGraph(
      orch([rail("A", [stage([step()])]), rail("B", [], { trigger: { kind: "all-rails-done" } })]),
      BUILTIN_TOOLS
    );
    expect(ofKind(g.edges, "waits")).toEqual([]);
    expect(railRows(g.rows)[1].note?.text).toBe("after all rails");
    expect(railRows(g.rows)[1].note?.warn).toBe(false);
  });

  it("warns on the head row for a trigger that can never fire", () => {
    const g = layoutNodeGraph(
      orch([rail("A", [], { trigger: { kind: "rail-done", rail: "A" } })]),
      BUILTIN_TOOLS
    );
    expect(ofKind(g.edges, "waits")).toEqual([]);
    expect(railRows(g.rows)[0].note?.warn).toBe(true);
    expect(railRows(g.rows)[0].note?.tip).toMatch(/cannot wait for itself/);
  });

  it("keeps the label but drops the arrow when the lens hides the named rail", () => {
    const first = rail("Build", [stage([step()])]);
    const waits = rail("Deploy", [], { trigger: { kind: "rail-done", rail: "Build" } });
    const g = layoutNodeGraph(orch([first, waits]), BUILTIN_TOOLS, (id) => id !== first.id);
    expect(ofKind(g.edges, "waits")).toEqual([]);
    expect(railRows(g.rows)[0].note?.text).toBe("after “Build”");
  });
});
