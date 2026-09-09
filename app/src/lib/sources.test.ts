import { describe, it, expect } from "vitest";

import {
  allSources,
  hasSource,
  source,
  sourceKeys,
  sourcesMatching,
  svelteSources,
  tsSources,
} from "./sources";

// The seam every source-reading guard in this tree now goes through, so
// this file is the tripwire under all of them.
//
// The failure it exists to catch is not a wrong answer, it is an EMPTY
// one. A guard that sweeps the map and asserts a property of every entry
// passes trivially over a map with four files in it, so a glob that
// quietly stops matching -- a renamed folder, a pattern that no longer
// reaches the file, an exclusion that grew a `**` -- turns half the
// static suite green while covering nothing. Nobody would look at a green
// run and go find out why.
//
// So the count is pinned. The numbers below are floors taken from what
// the map actually returned when they were written (313 entries, 118 of
// them components), rounded well down so that ordinary deletion does not
// trip them and a collapse does.

describe("the lib source map", () => {
  it("holds every component and module in lib", () => {
    expect(Object.keys(allSources()).length).toBeGreaterThanOrEqual(300);
    expect(Object.keys(svelteSources()).length).toBeGreaterThanOrEqual(110);
    expect(Object.keys(tsSources()).length).toBeGreaterThanOrEqual(180);
  });

  it("reaches files nested under lib, not just its top level", () => {
    // `ui/` and `wizardSteps/` are the folders that already existed when
    // the seam was built. If the glob ever flattens back to `./*`, these
    // are the first entries to vanish -- and every later domain folder
    // would vanish with them.
    expect(hasSource("StatusBadge.svelte")).toBe(true);
    expect(sourceKeys().some((key) => key.includes("/"))).toBe(true);
  });

  it("finds a file by bare name whatever folder it sits in", () => {
    expect(source("StatusBadge.svelte")).toContain("<script");
    expect(source("layoutState.ts")).toContain("export");
  });

  it("throws rather than answering for a file it does not hold", () => {
    expect(() => source("NoSuchThing.svelte")).toThrow(/no source for NoSuchThing\.svelte/);
  });

  it("excludes the tests themselves, so a guard cannot assert over its siblings", () => {
    expect(hasSource("sources.test.ts")).toBe(false);
    expect(sourceKeys().every((key) => !key.endsWith(".test.ts"))).toBe(true);
  });

  it("filters by name and text", () => {
    const styled = sourcesMatching((name, text) => name.endsWith(".svelte") && text.includes("<style"));
    expect(Object.keys(styled).length).toBeGreaterThan(50);
    expect(Object.keys(styled).every((name) => name.endsWith(".svelte"))).toBe(true);
  });
});
