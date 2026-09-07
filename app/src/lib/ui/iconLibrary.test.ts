import { describe, it, expect } from "vitest";
import { render } from "svelte/server";
import type { Component } from "svelte";
import { ICON_LIBRARY, ICON_NAMES, iconByName, iconLabel, searchIcons } from "./iconLibrary";

/// The rendered lucide class of a glyph -- the only stable identity an
/// icon component has from the outside. Borrowed from toolKindIcon.test.ts,
/// which asks the same question of the kind vocabulary.
function glyphClass(icon: Component<{ size?: number }>, name: string): string {
  const body = render(icon, { props: { size: 13 } }).body;
  const classes = [...body.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/));
  const named = classes.filter((c) => c.startsWith("lucide-") && c !== "lucide-icon");
  expect(named.length, `${name} rendered no lucide-<name> class`).toBeGreaterThan(0);
  return named[named.length - 1];
}

const ALL = ICON_LIBRARY.flatMap((g) => g.icons);

describe("the icon library", () => {
  // The name is the only part of an entry that reaches disk, so a
  // collision is not a rendering bug: two entries under one name means
  // the tool that stored it gets whichever the Map happened to keep.
  it("gives every icon a name of its own", () => {
    const seen = new Set<string>();
    for (const entry of ALL) {
      expect(seen.has(entry.name), `two entries are both called ${entry.name}`).toBe(false);
      seen.add(entry.name);
    }
    expect(ICON_NAMES.length).toBe(ALL.length);
  });

  // A picker is a grid of pictures. Two entries drawing one picture make
  // the second unpickable in practice -- and it is an easy mistake to
  // make here, because lucide keeps ALIASES: `history` and `file-code-2`
  // are both aliases of an icon whose real name has changed, so two
  // entries can be spelled differently in the import list and still be
  // the same glyph.
  it("draws no two icons the same", () => {
    const seen = new Map<string, string>();
    for (const entry of ALL) {
      const glyph = glyphClass(entry.icon, entry.name);
      expect(seen.get(glyph), `${entry.name} and ${seen.get(glyph)} both draw ${glyph}`).toBeUndefined();
      seen.set(glyph, entry.name);
    }
  });

  it("labels every icon, so the picker has something to say about it", () => {
    for (const entry of ALL) expect(entry.label.trim(), entry.name).not.toBe("");
  });

  it("resolves every name it offers", () => {
    for (const name of ICON_NAMES) expect(iconByName(name), name).toBeTruthy();
  });
});

describe("resolving a stored name", () => {
  // The two absences that mean the same thing: a tool that never had an
  // icon, and one whose stored value was cleared.
  it("answers nothing for nothing", () => {
    expect(iconByName(null)).toBeNull();
    expect(iconByName(undefined)).toBeNull();
    expect(iconByName("")).toBeNull();
  });

  // A name a NEWER gavin offered, or one dropped from the library. Null
  // rather than a stand-in glyph, because the caller has a better answer
  // than any placeholder -- whatever the thing drew before it had an
  // icon of its own.
  it("answers nothing for a name this build does not have", () => {
    expect(iconByName("teleporter")).toBeNull();
    expect(iconLabel("teleporter")).toBeNull();
  });

  it("gives the picker's own label back", () => {
    expect(iconLabel("rocket")).toBe("Rocket");
    expect(iconLabel(null)).toBeNull();
  });
});

describe("searching the library", () => {
  it("is the whole library when nothing is typed", () => {
    expect(searchIcons("")).toBe(ICON_LIBRARY);
    expect(searchIcons("   ")).toBe(ICON_LIBRARY);
  });

  // The name and the label disagree often enough to matter: the picture
  // a human calls a warning is stored as `triangle-alert`.
  it("matches the label as well as the name", () => {
    const found = searchIcons("warning").flatMap((g) => g.icons.map((i) => i.name));
    expect(found).toContain("triangle-alert");
  });

  it("matches a name the label does not contain", () => {
    const found = searchIcons("sticky").flatMap((g) => g.icons.map((i) => i.name));
    expect(found).toEqual(["sticky-note"]);
  });

  // A heading over nothing reads as a group that failed to load rather
  // than one with no match.
  it("drops a group with no matches rather than drawing an empty heading", () => {
    for (const group of searchIcons("git")) expect(group.icons.length).toBeGreaterThan(0);
    expect(searchIcons("nothing-matches-this")).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(searchIcons("ROCKET").flatMap((g) => g.icons.map((i) => i.name))).toEqual(["rocket"]);
  });
});
