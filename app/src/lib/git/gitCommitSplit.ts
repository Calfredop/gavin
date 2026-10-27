// Geometry for the dividers in the Git tab that size a commit's message
// against its files: the bar above the commit box in the Changes column,
// and the two bars in a selected commit's detail (message | files | diff).
//
// Both store SHARES, like every divider (splitShare.ts), with one
// difference from the Unstaged/Staged split: nothing is stored until
// somebody drags. Before that each block is sized the way it always was
// -- the commit box to its fields, the message and the file list to
// their content under a cap -- so the first drag starts from heights
// measured on screen, not from a default share.

import { shareFromSize } from "$lib/panes/splitShare";
import { MIN_LIST_PX } from "$lib/git/gitChangesSplit";

/// The commit box's floor: Summary, two lines of Description, the
/// Amend/Commit row and the author line.
export const MIN_COMMIT_BOX_PX = 140;

/// What the lists above the commit box keep: each list its header and a
/// row, plus the 4px bar between them.
export const MIN_LISTS_PX = MIN_LIST_PX * 2 + 4;

/// The commit box's share of the lists and the box together, given a
/// drag that wants the box `desired` px tall. `fallback` is the share it
/// had when the drag began: a column too short for both floors leaves the
/// box where it was.
export function commitBoxShare(desired: number, total: number, fallback: number): number {
  return shareFromSize(desired, total, MIN_COMMIT_BOX_PX, fallback, MIN_LISTS_PX);
}

/// A selected commit's detail, split three ways: `message` and `files`
/// are shares of the three blocks' combined height, and the diff takes
/// the rest.
export interface CommitDetailSplit {
  message: number;
  files: number;
}

/// Two lines of the message.
export const MIN_MESSAGE_PX = 44;
/// One file row.
export const MIN_FILES_PX = 28;
/// A hunk header and a few lines.
export const MIN_DIFF_PX = 64;

/// The three blocks' heights, measured when a drag begins.
export interface DetailHeights {
  message: number;
  files: number;
  diff: number;
}

/// The bar between message and files is 0; between files and diff, 1.
export type DetailBar = 0 | 1;

/// The split after dragging `bar` so the block above it wants `desired`
/// px. Only that bar's two blocks trade height; the third keeps what it
/// had. Null while the detail has no measurable height, so the caller
/// keeps the split it has.
export function detailSplitFromDrag(bar: DetailBar, desired: number, h: DetailHeights): CommitDetailSplit | null {
  const total = h.message + h.files + h.diff;
  if (!(total > 0)) return null;
  let { message, files } = h;
  if (bar === 0) {
    const pair = message + files;
    if (pair > 0) message = shareFromSize(desired, pair, MIN_MESSAGE_PX, message / pair, MIN_FILES_PX) * pair;
    files = pair - message;
  } else {
    const pair = files + h.diff;
    if (pair > 0) files = shareFromSize(desired, pair, MIN_FILES_PX, files / pair, MIN_DIFF_PX) * pair;
  }
  return { message: round(message / total), files: round(files / total) };
}

/// The three blocks' flex-grow factors for a stored split. The diff's is
/// never negative, whatever a hand-edited config.json holds.
export function detailGrow(split: CommitDetailSplit): [number, number, number] {
  return [split.message, split.files, Math.max(0, round(1 - split.message - split.files))];
}

// Four decimals, so a stored share round-trips through JSON unchanged.
function round(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}
