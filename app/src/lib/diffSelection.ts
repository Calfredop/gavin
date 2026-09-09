// Line-selection rules for partial staging (spec §3): only add/del lines,
// one hunk at a time, shift-click/drag extends from an anchor.

import { lineId, parseLineId, type Hunk } from "$lib/git";

export function selectionHunk(ids: ReadonlySet<string>): number | null {
  const first = ids.values().next();
  return first.done ? null : parseLineId(first.value).hunk;
}

export function rangeIds(hunks: Hunk[], hunkIndex: number, a: number, b: number): Set<string> {
  const hunk = hunks[hunkIndex];
  const ids = new Set<string>();
  if (!hunk) return ids;
  const [from, to] = a <= b ? [a, b] : [b, a];
  for (let i = from; i <= to; i++) {
    if (hunk.lines[i] && hunk.lines[i].kind !== "context") ids.add(lineId(hunkIndex, i));
  }
  return ids;
}

export function clickLine(
  current: ReadonlySet<string>,
  hunks: Hunk[],
  hunkIndex: number,
  lineIndex: number,
  shift: boolean,
  anchor: number | null
): { ids: Set<string>; anchor: number | null } {
  const line = hunks[hunkIndex]?.lines[lineIndex];
  if (!line || line.kind === "context") return { ids: new Set(current), anchor };
  const sameHunk = selectionHunk(current) === hunkIndex;
  if (shift && sameHunk && anchor !== null) {
    return { ids: rangeIds(hunks, hunkIndex, anchor, lineIndex), anchor };
  }
  const id = lineId(hunkIndex, lineIndex);
  const ids = sameHunk ? new Set(current) : new Set<string>();
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: lineIndex };
}
