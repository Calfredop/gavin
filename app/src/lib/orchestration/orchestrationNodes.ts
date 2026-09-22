// The Orchestration tab's second view: the plan as a node graph
// (orchestrationViewMode.ts picks between this and the rail strip).
//
// Drawn the way the Git tab draws commits (GitGraphRow.svelte): one ROW
// per step, a gutter of lanes on the left with a dot on the row's lane,
// and one line of text beside it. Rails are lanes. A rail's rows run top
// to bottom in stage order, its head row wearing the rail's name the way
// a branch ref sits on its tip commit, and the rail's line joins its dots
// the way a branch line joins commits. A single-step stage is a dot on
// the line; a SEQUENCE group is a straight run of dots (the strip says
// "ordered" with a connector, and a straight line is the same statement,
// grouping spec §4.1); a PARALLEL group FORKS -- its members take the
// lanes beside the rail's, one row each, and merge back into the line at
// the next stage -- because a fork and a merge are what "these happen
// at once" already looks like in the graph next door.
//
// Laid out by ARITHMETIC: every row is ROW_H tall and every lane LANE_W
// wide, so a dot's centre is a function of (row, lane), a curve is a
// string, and the component is a template over rows -- no DOM measuring,
// and the geometry is unit-tested here. Rails follow one another down
// the page rather than sharing rows, ordered so that a rail another rail
// starts comes after it (orderRails); their vertical stacking is not a
// timeline (orchestration spec O8), it is reading order.
//
// The only lines that cross lanes are the two facts the plan can state
// between rails: a `builtin:start-rail` step naming the rail it arms,
// drawn from the step's dot to that rail's head in the step's rail's
// colour, and a rail's `rail-done` trigger, drawn dashed in the waiting
// rail's colour from the end of the rail it waits for. A general
// dependency DAG is out of scope by the tab spec's preamble, and the
// graph draws no edge the scheduler would not act on.
//
// Colour. Each rail takes one of the eight `--lane-*` colours by its
// position -- the palette theme.css keeps for the commit graph, fitting
// here for the same reason: categorical, not semantic, its one job being
// that adjacent lanes look different. It marks the rail's line, its
// dots and the chip carrying its name, and is always beside that name;
// run state and conflict severity keep the badges they wear on the
// strip, so no colour answers two questions.

import type { Orchestration, Rail, Stage, StageMode, Step } from "$lib/orchestration/orchestration";
import {
  isGroup,
  isToolStep,
  railTriggerLabel,
  railTriggerVerdict,
  stageLabel,
  stageMode,
  stepParams,
} from "$lib/orchestration/orchestration";
import { findTool, gavinActionOf, type Tool } from "$lib/orchestration/orchestrationTools";

// ---- Geometry, in CSS pixels -----------------------------------------------
// The commit graph's own numbers (GitGraphRow.svelte), so the two graphs
// read as one family.

export const ROW_H = 22;
export const LANE_W = 14;
/// How far short of a head dot's centre a cross-rail arrow stops, so the
/// arrowhead is not buried under the dot.
export const ARRIVE = 8;
/// Arrowhead: length along the edge and half its width.
const ARROW_LEN = 6;
const ARROW_HALF = 3.5;

/// How many `--lane-N` colours theme.css defines.
export const RAIL_COLOURS = 8;

/// The centre of a lane's column.
export function laneX(lane: number): number {
  return lane * LANE_W + LANE_W / 2;
}

/// The centre of a row.
export function rowY(row: number): number {
  return row * ROW_H + ROW_H / 2;
}

/// A sentence the graph cannot draw as a line, hung on a row. `warn` is
/// the strip's own rule for a trigger chip: a condition that can never
/// fire is drawn as a warning, a wait quietly.
export interface GraphNote {
  text: string;
  warn: boolean;
  tip: string | null;
}

/// Which group a step row belongs to, for the chip on the group's first
/// row and the bracket the rows share.
export interface GroupMark {
  stageId: string;
  mode: StageMode;
  label: string;
  first: boolean;
  last: boolean;
  size: number;
}

export type GraphRow =
  | {
      kind: "rail";
      row: number;
      railId: string;
      rail: Rail;
      /// The rail's own lane: where its line and its single-step dots sit.
      lane: number;
      /// 1..RAIL_COLOURS, the N of `--lane-N`.
      colour: number;
      /// The rail's trigger, in the header chip's words, or null when it
      /// starts by hand.
      note: GraphNote | null;
    }
  | {
      kind: "step";
      row: number;
      railId: string;
      stageId: string;
      stepId: string;
      step: Step;
      /// The rail's lane, or a lane beside it for a parallel member.
      lane: number;
      colour: number;
      group: GroupMark | null;
      /// What a start-rail step could not draw an arrow for, or null.
      note: GraphNote | null;
    };

export type GraphEdgeKind =
  /// A rail's line, down its own lane from its head to its last dot there.
  | "rail"
  /// A parallel member leaving the rail's lane for its own.
  | "fork"
  /// A parallel member rejoining the rail's lane at the next stage.
  | "join"
  /// A `builtin:start-rail` step to the head of the rail it arms.
  | "starts"
  /// A `rail-done` trigger: from the rail waited for to the rail waiting.
  | "waits";

export interface GraphEdge {
  id: string;
  kind: GraphEdgeKind;
  /// The `--lane-N` the edge is drawn in: the rail it belongs to.
  colour: number;
  /// SVG path data.
  d: string;
  /// SVG polygon points for the arrowhead, or null for a bare line.
  arrow: string | null;
  dashed: boolean;
}

export interface NodeGraph {
  rows: GraphRow[];
  edges: GraphEdge[];
  /// How many lanes the gutter holds.
  lanes: number;
  /// The gutter's width and the rows' total height.
  width: number;
  height: number;
}

/// The `--lane-N` a rail at this index (in POSITION order, over every
/// rail, hidden or not) is drawn in. Keyed to position rather than to
/// reading order so neither the search lens taking rails out nor a
/// start-rail step reordering them recolours what is left.
export function railColour(index: number): number {
  return (index % RAIL_COLOURS) + 1;
}

// ---- Cross-rail facts ------------------------------------------------------

/// The rails called `name`, matched the way `startRailVerdict` and
/// `railTriggerVerdict` match a typed name: trimmed, case-insensitive.
function railsNamed(orch: Orchestration, name: string): Rail[] {
  const wanted = name.trim().toLowerCase();
  return orch.rails.filter((r) => r.name.trim().toLowerCase() === wanted);
}

type StartLink =
  | { kind: "rail"; rail: Rail }
  | { kind: "external" }
  | { kind: "broken"; reason: string }
  | { kind: "none" };

/// What a step's `builtin:start-rail` points at, in the same words
/// `startRailVerdict` refuses with -- the human reads that refusal on the
/// stalled step, and the note on the row should not say it differently.
/// A PAUSED target is still a target here: the verdict refuses to arm
/// one, but the arrow says what the step names, not whether the press
/// would land.
function startLink(orch: Orchestration, fromRailId: string, step: Step, tools: Tool[]): StartLink {
  if (!isToolStep(step)) return { kind: "none" };
  const tool = findTool(tools, step.toolId as string);
  if (!tool || gavinActionOf(tool) !== "start-rail") return { kind: "none" };
  const params = stepParams(step);
  if ((params.workspace ?? "").trim()) return { kind: "external" };
  const name = (params.rail ?? "").trim();
  if (!name) return { kind: "broken", reason: "no rail named — set this step's Rail parameter" };
  const matches = railsNamed(orch, name);
  if (matches.length === 0) {
    return { kind: "broken", reason: `no rail called “${name}” in this workspace` };
  }
  if (matches.length > 1) {
    return { kind: "broken", reason: `“${name}” names ${matches.length} rails — rename one of them` };
  }
  if (matches[0].id === fromRailId) return { kind: "broken", reason: "a rail cannot start itself" };
  return { kind: "rail", rail: matches[0] };
}

/// The rail a `rail-done` trigger resolves to, or null when the verdict
/// would call it broken (no name, no such rail, two of them, itself).
function waitsOn(orch: Orchestration, rail: Rail): Rail | null {
  const trigger = rail.trigger;
  if (!trigger || trigger.kind !== "rail-done") return null;
  const matches = railsNamed(orch, trigger.rail ?? "");
  if (matches.length !== 1 || matches[0].id === rail.id) return null;
  return matches[0];
}

/// A rail's trigger as its head row's note: the chip's own label, warned
/// when the verdict says it can never fire, with the verdict's sentence
/// as the tip. Null for a rail that starts by hand.
function railNote(orch: Orchestration, rail: Rail): GraphNote | null {
  if (!rail.trigger) return null;
  const verdict = railTriggerVerdict(orch, rail);
  return {
    text: railTriggerLabel(rail.trigger),
    warn: verdict.kind === "broken",
    tip: verdict.kind === "wait" || verdict.kind === "broken" ? verdict.reason : null,
  };
}

/// Reading order for the rails: a rail that another rail starts (by a
/// start-rail step, or by waiting on it) comes after that rail, and
/// otherwise rails keep their position order. That is what makes the
/// cross-rail curves run DOWN the page, the way a merge's parent sits
/// below it in the commit graph, instead of doubling back. A cycle --
/// two rails each starting the other -- cannot be honoured at all, and
/// honouring the rest of the plan around it would move rails for a
/// reason the reader cannot see, so the whole order falls back to
/// position, which is the order the strip shows.
export function orderRails(orch: Orchestration, tools: Tool[]): Rail[] {
  const byPosition = [...orch.rails].sort((a, b) => a.position - b.position);
  const before = new Map<string, Set<string>>(byPosition.map((r) => [r.id, new Set<string>()]));
  const after = new Map<string, Set<string>>(byPosition.map((r) => [r.id, new Set<string>()]));
  function depends(first: string, then: string): void {
    if (first === then) return;
    before.get(then)?.add(first);
    after.get(first)?.add(then);
  }
  for (const rail of byPosition) {
    for (const stage of rail.stages) {
      for (const step of stage.steps) {
        const link = startLink(orch, rail.id, step, tools);
        if (link.kind === "rail") depends(rail.id, link.rail.id);
      }
    }
    const waited = waitsOn(orch, rail);
    if (waited) depends(waited.id, rail.id);
  }
  const ordered: Rail[] = [];
  const pending = new Set(byPosition.map((r) => r.id));
  const inDegree = new Map([...before].map(([id, deps]) => [id, deps.size]));
  while (pending.size > 0) {
    // The lowest-positioned rail with nothing left before it. None
    // ready with rails still pending is a cycle.
    const ready = byPosition.find((r) => pending.has(r.id) && inDegree.get(r.id) === 0);
    if (!ready) return byPosition;
    pending.delete(ready.id);
    ordered.push(ready);
    for (const next of after.get(ready.id) ?? []) {
      inDegree.set(next, Math.max(0, (inDegree.get(next) ?? 0) - 1));
    }
  }
  return ordered;
}

// ---- Edges -----------------------------------------------------------------

/// A curve between two dots with VERTICAL tangents at both ends, the
/// shape the commit graph's forks and merges have (GitGraphRow's curveIn
/// and curveOut), stretched over however many rows it spans.
function curve(x0: number, y0: number, x1: number, y1: number): string {
  const mid = (y0 + y1) / 2;
  return `M ${x0} ${y0} C ${x0} ${mid}, ${x1} ${mid}, ${x1} ${y1}`;
}

/// An arrowhead with its tip at (x, y), pointing down when the edge
/// arrived from above and up otherwise.
function arrowVertical(x: number, y: number, down: boolean): string {
  const back = down ? y - ARROW_LEN : y + ARROW_LEN;
  return `${x},${y} ${x - ARROW_HALF},${back} ${x + ARROW_HALF},${back}`;
}

// ---- The layout ------------------------------------------------------------

/// How many lanes a rail needs: its own, plus one for each parallel
/// member beyond the first in its widest group.
function lanesFor(rail: Rail): number {
  let widest = 1;
  for (const stage of rail.stages) {
    if (isGroup(stage) && stageMode(stage) === "parallel") widest = Math.max(widest, stage.steps.length);
  }
  return widest;
}

function sortedStages(rail: Rail): Stage[] {
  return [...rail.stages].sort((a, b) => a.position - b.position).filter((s) => s.steps.length > 0);
}

export function layoutNodeGraph(
  orch: Orchestration,
  tools: Tool[],
  railShown: (railId: string) => boolean = () => true
): NodeGraph {
  const rows: GraphRow[] = [];
  const edges: GraphEdge[] = [];
  const colourOf = new Map<string, number>();
  [...orch.rails]
    .sort((a, b) => a.position - b.position)
    .forEach((rail, index) => colourOf.set(rail.id, railColour(index)));

  /// Where each drawn rail's head sits and where its line ends, for the
  /// cross-rail curves once every rail is placed.
  const heads = new Map<string, { row: number; lane: number }>();
  const tails = new Map<string, { row: number; lane: number }>();
  const stepRows = new Map<string, Extract<GraphRow, { kind: "step" }>>();

  let lane = 0;
  for (const rail of orderRails(orch, tools)) {
    if (!railShown(rail.id)) continue;
    const colour = colourOf.get(rail.id) ?? 1;
    const base = lane;
    lane += lanesFor(rail);

    const headRow = rows.length;
    rows.push({ kind: "rail", row: headRow, railId: rail.id, rail, lane: base, colour, note: railNote(orch, rail) });
    heads.set(rail.id, { row: headRow, lane: base });

    // The row the line last touched on the rail's own lane: the fork
    // point for the next parallel group, and where the line ends.
    let onBase = headRow;
    let tail = { row: headRow, lane: base };
    // Members waiting to merge back at the next stage's first row.
    let joining: { stepId: string; row: number; lane: number }[] = [];

    sortedStages(rail).forEach((stage, index) => {
      const steps = [...stage.steps].sort((a, b) => a.position - b.position);
      const group = isGroup(stage);
      const mode = group ? stageMode(stage) : null;
      const label = group ? stageLabel(stage, index) : null;
      const parallel = mode === "parallel";
      const firstRow = rows.length;
      // Every member of a fork leaves the line at the row BEFORE the
      // group -- the previous stage's dot, or the head -- and not at the
      // first member's, which would draw "a, then b and c" for three
      // steps that start together.
      const forkFrom = onBase;
      for (const joined of joining) {
        edges.push({
          id: `join:${joined.stepId}`,
          kind: "join",
          colour,
          d: curve(laneX(joined.lane), rowY(joined.row), laneX(base), rowY(firstRow)),
          arrow: null,
          dashed: false,
        });
      }
      joining = [];
      steps.forEach((step, i) => {
        const row = rows.length;
        const stepLane = parallel ? base + i : base;
        const entry: Extract<GraphRow, { kind: "step" }> = {
          kind: "step",
          row,
          railId: rail.id,
          stageId: stage.id,
          stepId: step.id,
          step,
          lane: stepLane,
          colour,
          group:
            group && mode && label
              ? { stageId: stage.id, mode, label, first: i === 0, last: i === steps.length - 1, size: steps.length }
              : null,
          note: null,
        };
        rows.push(entry);
        stepRows.set(step.id, entry);
        tail = { row, lane: stepLane };
        if (stepLane === base) {
          onBase = row;
        } else {
          edges.push({
            id: `fork:${step.id}`,
            kind: "fork",
            colour,
            d: curve(laneX(base), rowY(forkFrom), laneX(stepLane), rowY(row)),
            arrow: null,
            dashed: false,
          });
          joining.push({ stepId: step.id, row, lane: stepLane });
        }
      });
    });

    if (onBase > headRow) {
      edges.push({
        id: `rail:${rail.id}`,
        kind: "rail",
        colour,
        d: `M ${laneX(base)} ${rowY(headRow)} L ${laneX(base)} ${rowY(onBase)}`,
        arrow: null,
        dashed: false,
      });
    }
    tails.set(rail.id, tail);
  }

  // Cross-rail edges, once every head is placed. A step whose target is
  // not drawn -- another workspace, a lens that hid it, a name that
  // resolves to nothing -- says so on its row instead.
  for (const entry of stepRows.values()) {
    const link = startLink(orch, entry.railId, entry.step, tools);
    if (link.kind === "none") continue;
    if (link.kind === "external") {
      entry.note = { text: "starts a rail in another workspace", warn: false, tip: null };
      continue;
    }
    if (link.kind === "broken") {
      entry.note = { text: "no rail to start", warn: true, tip: link.reason };
      continue;
    }
    const head = heads.get(link.rail.id);
    if (!head) {
      entry.note = { text: `starts “${link.rail.name}”`, warn: false, tip: null };
      continue;
    }
    const down = head.row > entry.row;
    const ty = rowY(head.row) + (down ? -ARRIVE : ARRIVE);
    edges.push({
      id: `starts:${entry.stepId}`,
      kind: "starts",
      colour: entry.colour,
      d: curve(laneX(entry.lane), rowY(entry.row), laneX(head.lane), ty),
      arrow: arrowVertical(laneX(head.lane), ty, down),
      dashed: false,
    });
  }

  for (const entry of rows) {
    if (entry.kind !== "rail") continue;
    const waited = waitsOn(orch, entry.rail);
    if (!waited) continue;
    const source = tails.get(waited.id);
    if (!source) continue;
    const down = entry.row > source.row;
    const ty = rowY(entry.row) + (down ? -ARRIVE : ARRIVE);
    edges.push({
      id: `waits:${entry.railId}`,
      kind: "waits",
      colour: entry.colour,
      d: curve(laneX(source.lane), rowY(source.row), laneX(entry.lane), ty),
      arrow: arrowVertical(laneX(entry.lane), ty, down),
      dashed: true,
    });
  }

  return {
    rows,
    edges,
    lanes: lane,
    width: Math.max(1, lane) * LANE_W,
    height: rows.length * ROW_H,
  };
}
