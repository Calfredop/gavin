import { describe, it, expect } from "vitest";
import { parseConflicts, applyChoice, hasMarkers, locateRegion, splitEol, joinEol } from "$lib/conflictMarkers";

const MERGE = "a\n<<<<<<< HEAD\nours1\nours2\n=======\ntheirs1\n>>>>>>> feature\nz\n";
const DIFF3 = "a\n<<<<<<< HEAD\nours1\n||||||| base\nbase1\n=======\ntheirs1\n>>>>>>> feature\nz\n";
const ZDIFF3 = "<<<<<<< ours\nO\n||||||| e3b0c44\nB\n=======\nT\n>>>>>>> theirs\n";

describe("parseConflicts", () => {
  it("parses merge-style blocks with labels and line ranges", () => {
    const b = parseConflicts(MERGE);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ index: 0, from: 1, to: 7, ours: ["ours1", "ours2"], base: null, theirs: ["theirs1"], oursLabel: "HEAD", theirsLabel: "feature" });
  });

  it("parses diff3 and zdiff3 blocks with a base section", () => {
    expect(parseConflicts(DIFF3)[0]).toMatchObject({ ours: ["ours1"], base: ["base1"], theirs: ["theirs1"] });
    expect(parseConflicts(ZDIFF3)[0]).toMatchObject({ from: 0, to: 7, ours: ["O"], base: ["B"], theirs: ["T"] });
  });

  it("handles CRLF, adjacent blocks and empty sides", () => {
    const crlf = "<<<<<<< a\r\nx\r\n=======\r\n>>>>>>> b\r\n<<<<<<< a\r\n=======\r\ny\r\n>>>>>>> b\r\n";
    const b = parseConflicts(crlf);
    expect(b).toHaveLength(2);
    expect(b[0]).toMatchObject({ ours: ["x"], theirs: [] });
    expect(b[1]).toMatchObject({ index: 1, from: 4, to: 8, ours: [], theirs: ["y"] });
  });

  it("does not treat a bare ======= outside a block as a marker, and ignores an unterminated block", () => {
    expect(parseConflicts("Title\n=======\nbody\n")).toEqual([]);
    expect(hasMarkers("Title\n=======\nbody\n")).toBe(false);
    const open = "<<<<<<< HEAD\nx\n=======\ny\n";
    expect(parseConflicts(open)).toEqual([]);
    expect(hasMarkers(open)).toBe(true);
  });
});

describe("applyChoice", () => {
  it("replaces the marker region with the chosen side and keeps EOL + final newline", () => {
    const b = parseConflicts(MERGE)[0];
    expect(applyChoice(MERGE, b, "ours")).toBe("a\nours1\nours2\nz\n");
    expect(applyChoice(MERGE, b, "theirs")).toBe("a\ntheirs1\nz\n");
    expect(applyChoice(MERGE, b, "both")).toBe("a\nours1\nours2\ntheirs1\nz\n");
    expect(applyChoice(MERGE, b, "both-reverse")).toBe("a\ntheirs1\nours1\nours2\nz\n");
    const crlf = "<<<<<<< a\r\nx\r\n=======\r\ny\r\n>>>>>>> b";
    expect(applyChoice(crlf, parseConflicts(crlf)[0], "theirs")).toBe("y");
    const noFinal = "p\n<<<<<<< a\nx\n=======\ny\n>>>>>>> b";
    expect(applyChoice(noFinal, parseConflicts(noFinal)[0], "ours")).toBe("p\nx");
  });

  it("removes the region entirely when the chosen side is empty", () => {
    const doc = "p\n<<<<<<< a\n=======\ny\n>>>>>>> b\nq\n";
    expect(applyChoice(doc, parseConflicts(doc)[0], "ours")).toBe("p\nq\n");
  });
});

describe("locateRegion", () => {
  it("finds the block's lines in order, resuming after the previous match", () => {
    const side = "a\nx\nb\nx\nc\n";
    expect(locateRegion(side, ["x"], 0)).toEqual({ from: 1, to: 2 });
    expect(locateRegion(side, ["x"], 2)).toEqual({ from: 3, to: 4 });
    expect(locateRegion(side, ["b", "x"], 0)).toEqual({ from: 2, to: 4 });
    expect(locateRegion(side, ["nope"], 0)).toBeNull();
    expect(locateRegion(side, [], 3)).toBeNull();
  });
});

describe("splitEol / joinEol", () => {
  it("round-trips LF, CRLF and missing final newline", () => {
    for (const text of ["a\nb\n", "a\r\nb\r\n", "a\nb", ""]) {
      const parts = splitEol(text);
      expect(joinEol(parts.lines, parts.eol, parts.finalNewline)).toBe(text);
    }
    expect(splitEol("a\r\nb\r\n")).toEqual({ lines: ["a", "b"], eol: "crlf", finalNewline: true });
    expect(splitEol("a\nb")).toEqual({ lines: ["a", "b"], eol: "lf", finalNewline: false });
  });
});
