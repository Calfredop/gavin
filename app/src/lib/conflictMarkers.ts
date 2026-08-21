// Conflict markers as the resolution model (spec conflicts §1): the Result
// document is the on-disk file, markers and all. These helpers parse git's
// three marker styles (merge / diff3 / zdiff3), rewrite one block with a
// chosen side, and keep the file's EOL style and final-newline state.

export type Eol = "lf" | "crlf";
export type Choice = "ours" | "theirs" | "both" | "both-reverse";

export interface ConflictBlock {
  index: number;
  /// Line range of the whole marker region: [from, to).
  from: number;
  to: number;
  ours: string[];
  base: string[] | null;
  theirs: string[];
  oursLabel: string;
  theirsLabel: string;
}

export function splitEol(text: string): { lines: string[]; eol: Eol; finalNewline: boolean } {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  const eol: Eol = crlf > 0 && crlf * 2 >= lf ? "crlf" : "lf";
  const finalNewline = text.endsWith("\n");
  const body = finalNewline ? text.slice(0, -(text.endsWith("\r\n") ? 2 : 1)) : text;
  const lines = body === "" && text === "" ? [] : body.split(/\r?\n/);
  return { lines, eol, finalNewline };
}

export function joinEol(lines: string[], eol: Eol, finalNewline: boolean): string {
  const sep = eol === "crlf" ? "\r\n" : "\n";
  if (lines.length === 0) return "";
  return lines.join(sep) + (finalNewline ? sep : "");
}

function marker(line: string, ch: string): string | null {
  // Seven `ch` at the start, then end-of-line or a space (git's own rule).
  const run = ch.repeat(7);
  if (!line.startsWith(run)) return null;
  if (line.length === 7) return "";
  return line[7] === " " ? line.slice(8) : null;
}

export function hasMarkers(doc: string): boolean {
  return splitEol(doc).lines.some((l) => marker(l, "<") !== null || marker(l, ">") !== null);
}

export function parseConflicts(doc: string): ConflictBlock[] {
  const { lines } = splitEol(doc);
  const blocks: ConflictBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const start = marker(lines[i], "<");
    if (start === null) {
      i++;
      continue;
    }
    // Inside a block: ours until `|||||||` (base) or `=======`, then theirs until `>>>>>>>`.
    let j = i + 1;
    const ours: string[] = [];
    let base: string[] | null = null;
    const theirs: string[] = [];
    let section: "ours" | "base" | "theirs" = "ours";
    let closed = false;
    let theirsLabel = "";
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (section !== "theirs" && marker(l, "|") !== null) {
        section = "base";
        base = [];
        continue;
      }
      if (section !== "theirs" && l === "=======") {
        section = "theirs";
        continue;
      }
      const end = marker(l, ">");
      if (section === "theirs" && end !== null) {
        theirsLabel = end;
        closed = true;
        break;
      }
      if (section === "ours") ours.push(l);
      else if (section === "base") base!.push(l);
      else theirs.push(l);
    }
    if (!closed) break; // unterminated: not a block (hasMarkers still flags it)
    blocks.push({ index: blocks.length, from: i, to: j + 1, ours, base, theirs, oursLabel: start, theirsLabel });
    i = j + 1;
  }
  return blocks;
}

export function applyChoice(doc: string, block: ConflictBlock, choice: Choice): string {
  const { lines, eol, finalNewline } = splitEol(doc);
  const replacement =
    choice === "ours" ? block.ours : choice === "theirs" ? block.theirs : choice === "both" ? [...block.ours, ...block.theirs] : [...block.theirs, ...block.ours];
  const next = [...lines.slice(0, block.from), ...replacement, ...lines.slice(block.to)];
  return joinEol(next, eol, finalNewline);
}

/// Finds `needle` as a contiguous run of lines in `sideText`, searching from
/// `fromLine` onward — used to highlight a block's ours/theirs text in the
/// full side panes. Empty needles have no region.
export function locateRegion(sideText: string, needle: string[], fromLine: number): { from: number; to: number } | null {
  if (needle.length === 0) return null;
  const hay = splitEol(sideText).lines;
  for (let i = Math.max(0, fromLine); i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let k = 0; k < needle.length; k++) {
      if (hay[i + k] !== needle[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return { from: i, to: i + needle.length };
  }
  return null;
}
