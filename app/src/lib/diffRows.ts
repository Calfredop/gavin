// Projects parsed hunks into render rows for the two diff layouts
// (spec §3). Both carry the same "<hunk>:<line>" ids so the line selection
// is shared between them.

import { lineId, type Hunk, type Line, type LineKind } from "$lib/git";

export type HunkRow = { kind: "hunk"; hunkIndex: number; header: string; lineCount: number };
export type UnifiedLineRow = { kind: "line"; hunkIndex: number; lineIndex: number; id: string; line: Line };
export type UnifiedRow = HunkRow | UnifiedLineRow;

export interface SplitCell {
  id: string;
  lineIndex: number;
  kind: LineKind;
  text: string;
  no?: number;
}
export type SplitPairRow = { kind: "pair"; hunkIndex: number; left: SplitCell | null; right: SplitCell | null };
export type SplitRow = HunkRow | SplitPairRow;

function hunkRow(hunkIndex: number, hunk: Hunk): HunkRow {
  return { kind: "hunk", hunkIndex, header: hunk.header, lineCount: hunk.lines.length };
}

export function toUnifiedRows(hunks: Hunk[]): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  hunks.forEach((hunk, hunkIndex) => {
    rows.push(hunkRow(hunkIndex, hunk));
    hunk.lines.forEach((line, lineIndex) => {
      rows.push({ kind: "line", hunkIndex, lineIndex, id: lineId(hunkIndex, lineIndex), line });
    });
  });
  return rows;
}

export function toSplitRows(hunks: Hunk[]): SplitRow[] {
  const rows: SplitRow[] = [];
  hunks.forEach((hunk, hunkIndex) => {
    rows.push(hunkRow(hunkIndex, hunk));
    let dels: SplitCell[] = [];
    let adds: SplitCell[] = [];
    const flush = (): void => {
      const n = Math.max(dels.length, adds.length);
      for (let i = 0; i < n; i++) {
        rows.push({ kind: "pair", hunkIndex, left: dels[i] ?? null, right: adds[i] ?? null });
      }
      dels = [];
      adds = [];
    };
    hunk.lines.forEach((line, lineIndex) => {
      const id = lineId(hunkIndex, lineIndex);
      if (line.kind === "del") {
        // A new deletion run after additions starts a fresh pairing block.
        if (adds.length > 0) flush();
        dels.push({ id, lineIndex, kind: "del", text: line.text, no: line.oldNo });
      } else if (line.kind === "add") {
        adds.push({ id, lineIndex, kind: "add", text: line.text, no: line.newNo });
      } else {
        flush();
        rows.push({
          kind: "pair",
          hunkIndex,
          left: { id, lineIndex, kind: "context", text: line.text, no: line.oldNo },
          right: { id, lineIndex, kind: "context", text: line.text, no: line.newNo },
        });
      }
    });
    flush();
  });
  return rows;
}
