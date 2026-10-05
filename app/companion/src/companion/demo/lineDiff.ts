// What `git diff` says about two versions of one small file, in the
// desktop's own wire shape (`FileDiff`), for the Demo Workstation.
//
// The demo's files are a page or two long and the ones a human edits on a
// phone stay that way, so this is the plain longest-common-subsequence
// diff rather than git's Myers: the same hunks for inputs this size, at a
// fraction of the code. Anything big enough to make the table expensive
// answers the way the host answers a huge diff -- `tooLarge`.
import type { FileDiff, Hunk, Line } from "$lib/git/git";

/// Lines of unchanged text around each change, as `git diff` shows.
const CONTEXT = 3;

/// Past this many cells the table is not worth building.
const MAX_CELLS = 4_000_000;

interface Text {
  lines: string[];
  /// The last line has no newline after it -- a change of its own, which
  /// git reports as `\ No newline at end of file`.
  unterminated: boolean;
}

function linesOf(content: string | null): Text {
  if (!content) return { lines: [], unterminated: false };
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
    return { lines, unterminated: false };
  }
  return { lines, unterminated: true };
}

/// Each line as it compares: an unterminated last line is not equal to
/// the same words followed by a newline, exactly as in git.
function keysOf(text: Text): string[] {
  return text.lines.map((line, i) =>
    text.unterminated && i === text.lines.length - 1 ? `${line}\u0000` : line
  );
}

function editScript(before: Text, after: Text): Line[] {
  const a = keysOf(before);
  const b = keysOf(after);
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: the longest common run of a[i..] and b[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lastOld = before.unterminated ? n - 1 : -1;
  const lastNew = after.unterminated ? m - 1 : -1;
  const line = (kind: Line["kind"], i: number | null, j: number | null): Line => {
    const text = i !== null ? before.lines[i] : after.lines[j as number];
    const out: Line = { kind, text };
    if (i !== null) out.oldNo = i + 1;
    if (j !== null) out.newNo = j + 1;
    if ((i !== null && i === lastOld) || (j !== null && j === lastNew)) out.noNewline = true;
    return out;
  };
  const script: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      script.push(line("context", i++, j++));
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      // Removals ahead of additions, the way git orders a changed block.
      script.push(line("del", i++, null));
    } else {
      script.push(line("add", null, j++));
    }
  }
  while (i < n) script.push(line("del", i++, null));
  while (j < m) script.push(line("add", null, j++));
  return script;
}

/// `3` for one line, `3,4` for more, and `0,0` for none -- git's spelling.
function range(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

function hunkOf(script: Line[], from: number, to: number): Hunk {
  const lines = script.slice(from, to);
  const before = script.slice(0, from);
  const oldBefore = before.filter((l) => l.oldNo !== undefined).length;
  const newBefore = before.filter((l) => l.newNo !== undefined).length;
  const oldLines = lines.filter((l) => l.oldNo !== undefined).length;
  const newLines = lines.filter((l) => l.newNo !== undefined).length;
  // A side with no lines in the hunk is numbered by the line BEFORE it,
  // which is how a new file comes to read `-0,0`.
  const oldStart = oldLines > 0 ? oldBefore + 1 : oldBefore;
  const newStart = newLines > 0 ? newBefore + 1 : newBefore;
  return {
    header: `@@ -${range(oldStart, oldLines)} +${range(newStart, newLines)} @@`,
    oldStart,
    oldLines,
    newStart,
    newLines,
    lines,
  };
}

/// The diff from `before` to `after` (null: the file is absent on that
/// side). Unchanged content has no hunks.
export function lineDiff(path: string, before: string | null, after: string | null): FileDiff {
  const old = linesOf(before);
  const next = linesOf(after);
  if ((old.lines.length + 1) * (next.lines.length + 1) > MAX_CELLS) {
    return { path, binary: false, tooLarge: true, hunks: [] };
  }
  const script = editScript(old, next);
  const changed = script.flatMap((l, i) => (l.kind === "context" ? [] : [i]));
  const hunks: Hunk[] = [];
  let k = 0;
  while (k < changed.length) {
    const from = Math.max(0, changed[k] - CONTEXT);
    let last = changed[k];
    // Changes closer than two contexts apart share one hunk: their
    // contexts would otherwise overlap.
    while (k + 1 < changed.length && changed[k + 1] - last <= 2 * CONTEXT) last = changed[++k];
    hunks.push(hunkOf(script, from, Math.min(script.length, last + CONTEXT + 1)));
    k += 1;
  }
  return { path, binary: false, tooLarge: false, hunks };
}
