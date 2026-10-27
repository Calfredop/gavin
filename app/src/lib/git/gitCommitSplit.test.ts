import { describe, it, expect } from "vitest";
import {
  MIN_COMMIT_BOX_PX,
  MIN_LISTS_PX,
  MIN_MESSAGE_PX,
  MIN_FILES_PX,
  MIN_DIFF_PX,
  commitBoxShare,
  detailSplitFromDrag,
  detailGrow,
} from "$lib/git/gitCommitSplit";

describe("commitBoxShare", () => {
  it("turns the box's dragged height into its share of the column", () => {
    expect(commitBoxShare(200, 600, 0.3)).toBe(0.3333);
    expect(commitBoxShare(300, 600, 0.3)).toBe(0.5);
  });

  // The two sides have different floors: the box keeps its fields, the
  // lists keep a header and a row each.
  it("keeps the box above its own floor", () => {
    expect(commitBoxShare(50, 600, 0.3)).toBe(Math.round((MIN_COMMIT_BOX_PX / 600) * 1e4) / 1e4);
    expect(commitBoxShare(-100, 600, 0.3)).toBe(0.2333);
  });

  it("keeps both lists readable above it", () => {
    expect(commitBoxShare(590, 600, 0.3)).toBe(Math.round(((600 - MIN_LISTS_PX) / 600) * 1e4) / 1e4);
    expect(commitBoxShare(10_000, 600, 0.3)).toBe(0.8067);
  });

  it("leaves the box where it was when the column cannot hold both floors", () => {
    expect(commitBoxShare(100, MIN_COMMIT_BOX_PX + MIN_LISTS_PX, 0.42)).toBe(0.42);
    expect(commitBoxShare(100, 0, 0.42)).toBe(0.42);
  });
});

describe("detailSplitFromDrag", () => {
  const h = { message: 100, files: 100, diff: 400 };

  it("trades height between message and files, leaving the diff alone", () => {
    const s = detailSplitFromDrag(0, 150, h)!;
    expect(s).toEqual({ message: 0.25, files: 0.0833 });
    expect(detailGrow(s)[2]).toBe(0.6667);
  });

  it("trades height between files and diff, leaving the message alone", () => {
    expect(detailSplitFromDrag(1, 300, h)).toEqual({ message: 0.1667, files: 0.5 });
  });

  it("keeps the message and the files above their floors", () => {
    expect(detailSplitFromDrag(0, 0, h)).toEqual({ message: Math.round((MIN_MESSAGE_PX / 600) * 1e4) / 1e4, files: 0.26 });
    expect(detailSplitFromDrag(0, 10_000, h)).toEqual({ message: 0.2867, files: Math.round((MIN_FILES_PX / 600) * 1e4) / 1e4 });
  });

  it("keeps the files and the diff above their floors", () => {
    expect(detailSplitFromDrag(1, 0, h)!.files).toBe(0.0467);
    expect(detailSplitFromDrag(1, 10_000, h)!.files).toBe(Math.round(((500 - MIN_DIFF_PX) / 600) * 1e4) / 1e4);
  });

  it("leaves a pair too small for both floors as it was", () => {
    expect(detailSplitFromDrag(0, 45, { message: 30, files: 20, diff: 550 })).toEqual({ message: 0.05, files: 0.0333 });
  });

  // offsetHeight is 0 while the tab is hidden or still laying out.
  it("has no answer while the detail has no height", () => {
    expect(detailSplitFromDrag(0, 100, { message: 0, files: 0, diff: 0 })).toBeNull();
  });
});

describe("detailGrow", () => {
  it("gives the diff the rest", () => {
    expect(detailGrow({ message: 0.2, files: 0.3 })).toEqual([0.2, 0.3, 0.5]);
  });

  it("never gives the diff a negative factor", () => {
    expect(detailGrow({ message: 0.7, files: 0.6 })[2]).toBe(0);
  });
});
