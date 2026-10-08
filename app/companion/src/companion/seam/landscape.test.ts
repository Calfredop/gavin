// A phone on its side: nothing under the Dynamic Island or the rounded
// corners, and chrome that leaves the list more than a row or two.
//
// On an iPhone 16 Pro (iOS 27) turned sideways the viewport is 874x402
// and `env(safe-area-inset-*)` is top 0, right 62, bottom 20, left 62.
// Each surface padded itself by the side insets, and what did not -- the
// Git tab's Changes/Branches strip, the desktop's file rows inside it --
// started at x=0, under the Island. And the header, the surface strip,
// the branch row, the sync row and the Changes strip stacked up to leave
// the Git list 158 of the 402px.
//
// What this holds: the page frame keeps clear of both side insets, once
// for every surface; nothing inside it reads a side inset again (a
// second 62px), except a layer fixed over the page, which spans the
// frame's padding and keeps clear itself; and one query, true of a phone
// on its side and of nothing upright or tablet-sized, folds the header
// into the surface strip, and Git's and the board's tool rows into one
// each. How tall each surface's list then is was measured on the phone
// (README, "On its side").
import { describe, expect, it } from "vitest";
import { companionSources } from "$companion/testing/companionSources";
import {
  componentRules,
  matchesMedia,
  padsBothSides,
  readsSideInset,
  type PlacedRule,
} from "$companion/testing/safeArea";
import { drawnComponents } from "$companion/testing/textColours";

const PAGE = "routes/+page.svelte";
const DRAWN = drawnComponents(companionSources());
const RULES = componentRules(DRAWN);

const frame = RULES.find((rule) => rule.file === PAGE && rule.selectors.includes(".companion"));

function isFixed(rule: PlacedRule): boolean {
  return rule.declarations.get("position") === "fixed";
}

/// Phones, each way up, and tablets on their side.
const SIDEWAYS_PHONES = {
  "iPhone 16 Pro": { width: 874, height: 402 },
  "iPhone SE": { width: 667, height: 375 },
  "iPhone 16 Pro Max": { width: 956, height: 440 },
  "a small Android": { width: 800, height: 360 },
};
const NOT_SIDEWAYS_PHONES = {
  "iPhone 16 Pro upright": { width: 402, height: 874 },
  "iPhone SE upright": { width: 375, height: 667 },
  "iPad mini on its side": { width: 1133, height: 744 },
  "iPad Air on its side": { width: 1180, height: 820 },
};

/// The query a fold sits in, in a file, for a selector.
function foldQuery(file: string, selector: string, property: string, value: string): string | null {
  const rule = RULES.find(
    (r) => r.file === file && r.selectors.includes(selector) && r.declarations.get(property) === value
  );
  return rule?.within.at(-1) ?? null;
}

describe("the side insets", () => {
  it("are the page frame's, both sides, on every surface", () => {
    expect(frame).toBeDefined();
    expect(frame?.within).toEqual([]);
    expect(frame && padsBothSides(frame)).toBe(true);
  });

  it("are read by nothing inside the frame, which would keep a second 62px clear", () => {
    // The guard sees the bundle at all: its surfaces and the desktop's
    // components inside them.
    expect(Object.keys(DRAWN)).toEqual(
      expect.arrayContaining(["companion/surfaces/PhoneGit.svelte", "$lib/git/GitFileRow.svelte", "$lib/core/Modal.svelte"])
    );
    const again = RULES.filter((rule) => readsSideInset(rule) && rule !== frame && !isFixed(rule));
    expect(again.map((rule) => `${rule.file} ${rule.selectors.join(", ")}`)).toEqual([]);
  });

  it("are kept clear by every layer fixed over the page, which spans the frame's padding", () => {
    const fixed = RULES.filter(isFixed);
    // The New card sheet and the desktop's dialogs, at least.
    expect(fixed.map((rule) => rule.file)).toEqual(
      expect.arrayContaining(["companion/surfaces/PhoneCompose.svelte", "$lib/core/Modal.svelte"])
    );
    expect(fixed.filter((rule) => !padsBothSides(rule)).map((rule) => `${rule.file} ${rule.selectors.join(", ")}`)).toEqual(
      []
    );
  });
});

describe("the chrome on a phone on its side", () => {
  const folds = {
    "the header beside the surface strip": foldQuery(PAGE, ".companion .chrome", "flex-direction", "row"),
    "Git's branch beside its sync buttons": foldQuery("companion/surfaces/PhoneGit.svelte", ".top", "display", "flex"),
    "the board's tools beside its column strip": foldQuery(
      "companion/surfaces/PhoneBoard.svelte",
      ".top",
      "display",
      "flex"
    ),
  };

  it("folds into fewer rows, all under the one query", () => {
    const queries = Object.values(folds);
    expect(queries.every((q) => q !== null)).toBe(true);
    expect(new Set(queries).size).toBe(1);
  });

  it("folds on a phone on its side, and not upright or on a tablet", () => {
    const query = folds["the header beside the surface strip"] ?? "";
    for (const [name, viewport] of Object.entries(SIDEWAYS_PHONES)) {
      expect({ name, folds: matchesMedia(query, viewport) }).toEqual({ name, folds: true });
    }
    for (const [name, viewport] of Object.entries(NOT_SIDEWAYS_PHONES)) {
      expect({ name, folds: matchesMedia(query, viewport) }).toEqual({ name, folds: false });
    }
  });
});
