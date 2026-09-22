// The Orchestration tab's second view: the plan as a node graph
// (orchestrationViewMode.ts picks between this and the rail strip).
//
// One lane per rail, one node per step, laid out by ARITHMETIC over
// fixed node sizes rather than by measuring the DOM. That is what makes
// this a pure module the component can be a template over: every
// rectangle and every edge path is decided here, unit-tested here, and
// the Svelte file only positions what it is handed. It is also why the
// nodes are one fixed size -- a title that has to fit a known box is a
// title the layout can place before it is drawn.
//
// What the graph says, and what it does not. Time runs left to right
// inside a lane, exactly as it runs top to bottom inside a rail: stage
// after stage, an arrow between each pair. A single-step stage is the
// bare node (the strip's own rule, isGroup). A sequence group is a chain
// -- members joined by the same arrow the stages are, because the strip
// says "ordered" with a connector and this view should not invent a
// second way (grouping spec §4.1). A parallel group is a stack behind
// one fan: a bus with a stub to each member and no arrowheads, so the
// enclosure reads as "these start together". Lanes are independent of
// each other, and nothing about their vertical stacking is a timeline
// (orchestration spec O8): the only lines that cross lanes are the two
// facts the plan can actually state -- a `builtin:start-rail` step
// naming the rail it arms, drawn solid from the step in its own rail's
// colour, and a rail's `rail-done` trigger, drawn dashed in the waiting
// rail's colour from the end of the rail it waits for. A general
// dependency DAG is out of scope by the tab spec's preamble, and the
// graph draws no edge the scheduler would not act on.
//
// Colour. Each rail takes one of the eight `--lane-*` colours by its
// position -- the palette theme.css keeps for the commit graph, and for
// the same reason it fits here: it is categorical, not semantic, and its
// one job is that adjacent lanes look different. It marks the lane's
// stripe, its name, its edges and each node's rail bar; it is always
// beside the rail's name and never the only thing saying which rail a
// node is on. Run state and conflict severity keep the axes they own on
// the strip (a badge and a fill), so a colour that answered "which
// rail" is not also asked to answer "what state".

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
// Exported so the component and the tests read the same numbers. The
// node is wide enough for an icon, a few words of title and two badges
// (the chip's own row, at chip size); the gaps are the arrows' lengths.

export const NODE_W = 200;
export const NODE_H = 38;
/// Between stages: the flow arrow.
export const STAGE_GAP = 44;
/// Between a sequence group's members: a shorter arrow, so the chain
/// reads as tighter than the stage flow around it.
export const MEMBER_GAP = 28;
/// Between a parallel group's stacked members.
export const PARALLEL_GAP = 8;
export const GROUP_PAD = 8;
/// The group's label row, above its members.
export const GROUP_HEAD = 20;
/// Room for the fan's bus on each side of a parallel stack.
export const FAN_W = 16;
/// The lane head: rail name, state, controls. Content starts past it.
export const LANE_HEAD_W = 176;
export const LANE_PAD_X = 16;
export const LANE_PAD_Y = 12;
export const LANE_GAP = 8;
export const LANE_MIN_H = 64;
/// Arrowhead: length along the edge and half its width.
const ARROW_LEN = 7;
const ARROW_HALF = 4;
/// How far a curved edge's control points reach.
const CURVE = 56;

/// How many `--lane-N` colours theme.css defines.
export const RAIL_COLOURS = 8;

export interface GraphRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/// A sentence the graph cannot draw as a line, hung on a node or a lane.
/// `warn` is the strip's own rule for a trigger chip: a condition that
/// can never fire is drawn as a warning, a wait quietly.
export interface GraphNote {
  text: string;
  warn: boolean;
  tip: string | null;
}

export interface GraphLane extends GraphRect {
  railId: string;
  rail: Rail;
  /// 1..RAIL_COLOURS, the N of `--lane-N`.
  colour: number;
  /// The rail's trigger, in the header chip's words, or null when it
  /// starts by hand.
  note: GraphNote | null;
}

export interface GraphStage extends GraphRect {
  stageId: string;
  railId: string;
  /// Null for a single-step stage, which draws bare (isGroup).
  mode: StageMode | null;
  /// The group's label (stageLabel); null when `mode` is.
  label: string | null;
}

export interface GraphNode extends GraphRect {
  stepId: string;
  railId: string;
  stageId: string;
  step: Step;
  /// What a start-rail step could not draw an arrow for, or null.
  note: GraphNote | null;
}

export type GraphEdgeKind =
  /// Stage to stage, or member to member inside a sequence: an arrow.
  | "flow"
  /// A parallel group's bus and stubs, and the short stubs that join a
  /// group's border to its first and last member: lines, no arrowhead.
  | "fan"
  /// A `builtin:start-rail` step to the rail it arms.
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
  /// SVG polygon points for the arrowhead, or null for a line.
  arrow: string | null;
  dashed: boolean;
}

export interface NodeGraph {
  lanes: GraphLane[];
  stages: GraphStage[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

/// The `--lane-N` a rail at this index (in position order, over EVERY
/// rail, hidden or not) is drawn in. Keyed to the full list so the
/// search lens, which takes rails out, does not recolour the rest.
export function railColour(index: number): number {
  return (index % RAIL_COLOURS) + 1;
}

// ---- Edges -----------------------------------------------------------------

/// An arrowhead pointing right with its tip at (x, y). Every edge in the
/// graph arrives horizontally -- the flow is left to right, and the two
/// curved kinds end with a horizontal tangent -- so one orientation is
/// all the drawing needs.
function arrowRight(x: number, y: number): string {
  return `${x},${y} ${x - ARROW_LEN},${y - ARROW_HALF} ${x - ARROW_LEN},${y + ARROW_HALF}`;
}

function line(id: string, kind: GraphEdgeKind, colour: number, x1: number, y1: number, x2: number, y2: number, arrow: boolean): GraphEdge {
  return {
    id,
    kind,
    colour,
    d: `M ${x1} ${y1} L ${x2} ${y2}`,
    arrow: arrow ? arrowRight(x2, y2) : null,
    dashed: false,
  };
}

// ---- Stages ----------------------------------------------------------------

/// A stage measured on its own, before it knows where it stands: its box
/// and its members' boxes relative to the box's origin, plus the y of its
/// PORT -- the line the flow enters and leaves on. Placing the stage is
/// then a matter of putting its port on the lane's centre line, which is
/// what keeps every arrow in a lane level however tall its groups are.
interface MeasuredStage {
  stage: Stage;
  w: number;
  h: number;
  port: number;
  mode: StageMode | null;
  label: string | null;
  members: { step: Step; x: number; y: number }[];
}

function measureStage(stage: Stage, index: number): MeasuredStage {
  const steps = [...stage.steps].sort((a, b) => a.position - b.position);
  if (!isGroup(stage)) {
    return {
      stage,
      w: NODE_W,
      h: NODE_H,
      port: NODE_H / 2,
      mode: null,
      label: null,
      members: steps.map((step) => ({ step, x: 0, y: 0 })),
    };
  }
  const mode = stageMode(stage);
  const label = stageLabel(stage, index);
  const n = steps.length;
  if (mode === "sequence") {
    const top = GROUP_HEAD + GROUP_PAD;
    return {
      stage,
      w: 2 * GROUP_PAD + n * NODE_W + (n - 1) * MEMBER_GAP,
      h: GROUP_HEAD + 2 * GROUP_PAD + NODE_H,
      port: top + NODE_H / 2,
      mode,
      label,
      members: steps.map((step, i) => ({ step, x: GROUP_PAD + i * (NODE_W + MEMBER_GAP), y: top })),
    };
  }
  const stackH = n * NODE_H + (n - 1) * PARALLEL_GAP;
  const top = GROUP_HEAD + GROUP_PAD;
  return {
    stage,
    w: 2 * GROUP_PAD + 2 * FAN_W + NODE_W,
    h: GROUP_HEAD + 2 * GROUP_PAD + stackH,
    port: top + stackH / 2,
    mode,
    label,
    members: steps.map((step, i) => ({ step, x: GROUP_PAD + FAN_W, y: top + i * (NODE_H + PARALLEL_GAP) })),
  };
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
/// stalled step, and the note on the node should not say it differently.
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

/// A rail's trigger as the lane's note: the chip's own label, warned
/// when the verdict says it can never fire, with the verdict's sentence
/// as the tip. Null for a rail that starts by hand.
function laneNote(orch: Orchestration, rail: Rail): GraphNote | null {
  if (!rail.trigger) return null;
  const verdict = railTriggerVerdict(orch, rail);
  return {
    text: railTriggerLabel(rail.trigger),
    warn: verdict.kind === "broken",
    tip: verdict.kind === "wait" || verdict.kind === "broken" ? verdict.reason : null,
  };
}

// ---- The layout ------------------------------------------------------------

/// Where a lane's flow begins and ends: the left edge of its first stage
/// and the right edge of its last, on the centre line -- or, for a rail
/// with no stages, the point just past the lane head, so an arrow still
/// has somewhere to land.
interface LanePorts {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export function layoutNodeGraph(
  orch: Orchestration,
  tools: Tool[],
  railShown: (railId: string) => boolean = () => true
): NodeGraph {
  const lanes: GraphLane[] = [];
  const stages: GraphStage[] = [];
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const ports = new Map<string, LanePorts>();
  const laneById = new Map<string, GraphLane>();
  const contentX = LANE_HEAD_W + LANE_PAD_X;

  const sorted = [...orch.rails].sort((a, b) => a.position - b.position);
  let y = 0;
  let right = contentX;

  sorted.forEach((rail, index) => {
    if (!railShown(rail.id)) return;
    const colour = railColour(index);
    const measured = [...rail.stages]
      .sort((a, b) => a.position - b.position)
      .filter((s) => s.steps.length > 0)
      .map((s, i) => measureStage(s, i));
    // Tallest reach above and below the port line, so the lane holds
    // every group with its port on the centre.
    let above = NODE_H / 2;
    let below = NODE_H / 2;
    for (const m of measured) {
      above = Math.max(above, m.port);
      below = Math.max(below, m.h - m.port);
    }
    const laneH = Math.max(LANE_MIN_H, above + below + 2 * LANE_PAD_Y);
    const cy = y + laneH / 2;

    let x = contentX;
    let prev: GraphStage | null = null;
    for (const m of measured) {
      const box: GraphStage = {
        stageId: m.stage.id,
        railId: rail.id,
        x,
        y: cy - m.port,
        w: m.w,
        h: m.h,
        mode: m.mode,
        label: m.label,
      };
      stages.push(box);
      if (prev) {
        edges.push(line(`flow:${prev.stageId}>${box.stageId}`, "flow", colour, prev.x + prev.w, cy, box.x, cy, true));
      }
      const placed = m.members.map(({ step, x: mx, y: my }) => ({
        step,
        rect: { x: box.x + mx, y: box.y + my, w: NODE_W, h: NODE_H },
      }));
      for (const { step, rect } of placed) {
        nodes.push({ ...rect, stepId: step.id, railId: rail.id, stageId: m.stage.id, step, note: null });
      }
      if (m.mode === "sequence") {
        // The border-to-member stubs, then the chain.
        const first = placed[0].rect;
        const last = placed[placed.length - 1].rect;
        edges.push({
          id: `fan:${m.stage.id}`,
          kind: "fan",
          colour,
          d: `M ${box.x} ${cy} L ${first.x} ${cy} M ${last.x + last.w} ${cy} L ${box.x + box.w} ${cy}`,
          arrow: null,
          dashed: false,
        });
        for (let i = 1; i < placed.length; i++) {
          const a = placed[i - 1];
          const b = placed[i];
          edges.push(
            line(`flow:${a.step.id}>${b.step.id}`, "flow", colour, a.rect.x + a.rect.w, cy, b.rect.x, cy, true)
          );
        }
      } else if (m.mode === "parallel") {
        // One fan: entry stub, left bus with a stub to each member, the
        // same on the right, exit stub.
        const first = placed[0].rect;
        const busL = box.x + GROUP_PAD + FAN_W / 2;
        const busR = first.x + NODE_W + FAN_W / 2;
        const centres = placed.map(({ rect }) => rect.y + rect.h / 2);
        const top = Math.min(cy, ...centres);
        const bottom = Math.max(cy, ...centres);
        const parts = [
          `M ${box.x} ${cy} L ${busL} ${cy}`,
          `M ${busL} ${top} L ${busL} ${bottom}`,
          ...centres.map((my) => `M ${busL} ${my} L ${first.x} ${my}`),
          ...centres.map((my) => `M ${first.x + NODE_W} ${my} L ${busR} ${my}`),
          `M ${busR} ${top} L ${busR} ${bottom}`,
          `M ${busR} ${cy} L ${box.x + box.w} ${cy}`,
        ];
        edges.push({ id: `fan:${m.stage.id}`, kind: "fan", colour, d: parts.join(" "), arrow: null, dashed: false });
      }
      prev = box;
      x += m.w + STAGE_GAP;
      right = Math.max(right, box.x + box.w);
    }

    const firstBox = measured.length > 0 ? stages[stages.length - measured.length] : null;
    const lastBox = prev;
    ports.set(rail.id, {
      start: { x: firstBox ? firstBox.x : contentX, y: cy },
      end: { x: lastBox ? lastBox.x + lastBox.w : contentX, y: cy },
    });

    const lane: GraphLane = {
      railId: rail.id,
      rail,
      x: 0,
      y,
      w: 0, // the canvas width, filled in once it is known
      h: laneH,
      colour,
      note: laneNote(orch, rail),
    };
    lanes.push(lane);
    laneById.set(rail.id, lane);
    y += laneH + LANE_GAP;
  });

  const width = right + LANE_PAD_X;
  const height = lanes.length > 0 ? y - LANE_GAP : 0;
  for (const lane of lanes) lane.w = width;

  // Cross-rail edges, once every lane has its ports. A step whose target
  // is not drawn -- another workspace, a lens that hid it, a name that
  // resolves to nothing -- says so on the node instead.
  for (const node of nodes) {
    const link = startLink(orch, node.railId, node.step, tools);
    if (link.kind === "none") continue;
    if (link.kind === "external") {
      node.note = { text: "starts a rail in another workspace", warn: false, tip: null };
      continue;
    }
    if (link.kind === "broken") {
      node.note = { text: "no rail to start", warn: true, tip: link.reason };
      continue;
    }
    const target = ports.get(link.rail.id);
    if (!target) {
      node.note = { text: `starts “${link.rail.name}”`, warn: false, tip: null };
      continue;
    }
    const colour = laneById.get(node.railId)?.colour ?? 1;
    const sx = node.x + node.w / 2;
    const tx = target.start.x;
    const ty = target.start.y;
    // Leaves from the node's bottom when the target lane is below, its
    // top when above, and arrives horizontally: the same tangent every
    // flow arrow has, so the arrowhead is the same shape.
    const down = ty >= node.y + node.h;
    const sy = down ? node.y + node.h : node.y;
    const c1y = sy + (down ? CURVE : -CURVE);
    edges.push({
      id: `starts:${node.stepId}`,
      kind: "starts",
      colour,
      d: `M ${sx} ${sy} C ${sx} ${c1y}, ${tx - CURVE} ${ty}, ${tx} ${ty}`,
      arrow: arrowRight(tx, ty),
      dashed: false,
    });
  }

  for (const lane of lanes) {
    const trigger = lane.rail.trigger;
    if (!trigger || trigger.kind !== "rail-done" || lane.note?.warn) continue;
    const matches = railsNamed(orch, trigger.rail ?? "");
    if (matches.length !== 1) continue;
    const source = ports.get(matches[0].id);
    const target = ports.get(lane.railId);
    if (!source || !target) continue;
    const { x: sx, y: sy } = source.end;
    const { x: tx, y: ty } = target.start;
    edges.push({
      id: `waits:${lane.railId}`,
      kind: "waits",
      colour: lane.colour,
      d: `M ${sx} ${sy} C ${sx + CURVE} ${sy}, ${tx - CURVE} ${ty}, ${tx} ${ty}`,
      arrow: arrowRight(tx, ty),
      dashed: true,
    });
  }

  return { lanes, stages, nodes, edges, width, height };
}
