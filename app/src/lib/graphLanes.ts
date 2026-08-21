// Lane assignment for the commit graph (spec SP4 §2). Input is a
// topo-ordered list (children before parents); output is one row per
// commit with everything the SVG cell needs: the commit's lane, lanes that
// pass straight through, lines coming in from lanes that were waiting for
// this commit, and lines going out to the lanes of extra parents.

import type { CommitInfo } from "./git";

export const LANE_COLORS = 8;
export const MAX_DRAWN_LANE = 12;

export interface GraphRow {
  lane: number;
  color: number;
  /// Lane count for this row (width), before trailing lanes close.
  lanes: number;
  /// Lanes that run straight through this row.
  passes: number[];
  /// Lanes (other than `lane`) that were waiting for this commit: drawn
  /// from their top into this row's dot.
  incoming: number[];
  /// Lanes opened (or reused) for the 2nd..nth parent: drawn from the dot
  /// down into those lanes.
  outgoing: number[];
  /// Whether the commit's own lane continues below the dot.
  hasParent: boolean;
  /// Whether the commit's lane was already running above it (a child
  /// pointed here); false for a lane's topmost commit.
  fromAbove: boolean;
}

export function computeGraph(commits: CommitInfo[]): GraphRow[] {
  const active: (string | null)[] = [];
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const widthBefore = active.length;
    let lane = active.indexOf(commit.sha);
    const fromAbove = lane >= 0;
    if (lane < 0) {
      lane = active.indexOf(null);
      if (lane < 0) {
        lane = active.length;
        active.push(null);
      }
    }
    const incoming: number[] = [];
    for (let i = 0; i < active.length; i++) {
      if (i !== lane && active[i] === commit.sha) {
        incoming.push(i);
        active[i] = null;
      }
    }
    const passes: number[] = [];
    for (let i = 0; i < active.length; i++) {
      if (i !== lane && active[i] !== null) passes.push(i);
    }

    const outgoing: number[] = [];
    if (commit.parents.length === 0) {
      active[lane] = null;
    } else {
      active[lane] = commit.parents[0];
      for (const parent of commit.parents.slice(1)) {
        let slot = active.indexOf(parent);
        if (slot < 0) {
          slot = active.indexOf(null);
          if (slot < 0) {
            slot = active.length;
            active.push(parent);
          } else {
            active[slot] = parent;
          }
        }
        outgoing.push(slot);
      }
    }
    while (active.length > 0 && active[active.length - 1] === null) active.pop();

    rows.push({
      lane,
      color: lane % LANE_COLORS,
      lanes: Math.max(widthBefore, active.length, lane + 1, ...outgoing.map((o) => o + 1)),
      passes,
      incoming,
      outgoing,
      hasParent: commit.parents.length > 0,
      fromAbove,
    });
  }
  return rows;
}
