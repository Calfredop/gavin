import { describe, it, expect } from "vitest";
import { resizeZones, needsResizeGrips, GRIP, CORNER } from "./windowResize";

describe("resizeZones", () => {
  it("covers all eight directions exactly once", () => {
    const directions = resizeZones().map((z) => z.direction);
    expect(new Set(directions).size).toBe(8);
    expect(directions).toEqual(
      expect.arrayContaining([
        "North",
        "South",
        "East",
        "West",
        "NorthEast",
        "NorthWest",
        "SouthEast",
        "SouthWest",
      ])
    );
  });

  it("puts the corners last, so they beat the edges they overlap", () => {
    // The only hit-testing there is: these are siblings in one stacking
    // context. A corner ordered before its two edges is unreachable
    // except in a sliver, and the diagonal drag is the one people use.
    const corners = ["NorthEast", "NorthWest", "SouthEast", "SouthWest"];
    const zones = resizeZones();
    const firstCorner = zones.findIndex((z) => corners.includes(z.direction));
    const lastEdge = zones.map((z) => corners.includes(z.direction)).lastIndexOf(false);
    expect(firstCorner).toBeGreaterThan(lastEdge);
  });

  it("names a cursor that matches the axis each grip moves", () => {
    const cursorFor = Object.fromEntries(
      resizeZones().map((z) => [z.direction, z.cursor])
    );
    expect(cursorFor.North).toBe("ns-resize");
    expect(cursorFor.South).toBe("ns-resize");
    expect(cursorFor.East).toBe("ew-resize");
    expect(cursorFor.West).toBe("ew-resize");
    // The diagonals are the pair that is easy to swap, and a swapped one
    // points the arrow at the corner opposite the one it drags.
    expect(cursorFor.NorthWest).toBe("nwse-resize");
    expect(cursorFor.SouthEast).toBe("nwse-resize");
    expect(cursorFor.NorthEast).toBe("nesw-resize");
    expect(cursorFor.SouthWest).toBe("nesw-resize");
  });

  it("anchors every zone to the window's own edges", () => {
    // A grip that forgot an anchor collapses to the top-left corner and
    // silently takes the others' presses.
    for (const zone of resizeZones()) {
      const anchored = ["top:0", "bottom:0", "left:0", "right:0"].filter((a) =>
        zone.style.includes(a)
      );
      expect(anchored.length, zone.direction).toBeGreaterThanOrEqual(2);
    }
  });

  it("makes a corner a bigger target than an edge is thick", () => {
    expect(CORNER).toBeGreaterThan(GRIP);
  });
});

describe("needsResizeGrips", () => {
  it("draws them everywhere except macOS", () => {
    // macOS borderless windows keep the OS's edge drag; a GTK one does
    // not, which is the whole reason this component exists.
    expect(needsResizeGrips(true)).toBe(false);
    expect(needsResizeGrips(false)).toBe(true);
  });
});
