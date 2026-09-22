import { describe, it, expect } from "vitest";
import { searchSettings, type SettingsSection } from "$lib/core/settingsSearch";
import { source } from "$lib/sources";

const SECTIONS: SettingsSection[] = [
  { id: "workspace", keywords: ["Workspace", "Name", "Colour", "Color", "Root"] },
  { id: "terminal", keywords: ["Terminal", "Font size", "font"] },
  { id: "daemon", keywords: ["Daemon", "Restart daemon", "gavin-daemon"] },
];

describe("searchSettings", () => {
  it("keeps every section and reports not filtering for an empty query", () => {
    const result = searchSettings(SECTIONS, "");
    expect(result.filtering).toBe(false);
    expect(result.shown).toBe(3);
    expect(result.total).toBe(3);
    expect(SECTIONS.every((s) => result.visible(s.id))).toBe(true);
  });

  it("keeps every section for a whitespace-only query", () => {
    const result = searchSettings(SECTIONS, "   ");
    expect(result.filtering).toBe(false);
    expect(result.shown).toBe(3);
  });

  it("matches a section by its title", () => {
    const result = searchSettings(SECTIONS, "daemon");
    expect(result.filtering).toBe(true);
    expect(result.visible("daemon")).toBe(true);
    expect(result.visible("workspace")).toBe(false);
    expect(result.visible("terminal")).toBe(false);
    expect(result.shown).toBe(1);
    expect(result.total).toBe(3);
  });

  it("matches a section by a keyword that is not its title", () => {
    const result = searchSettings(SECTIONS, "restart");
    expect(result.visible("daemon")).toBe(true);
    expect(result.shown).toBe(1);
  });

  it("is case-insensitive", () => {
    expect(searchSettings(SECTIONS, "COLOUR").visible("workspace")).toBe(true);
    expect(searchSettings(SECTIONS, "ColoR").visible("workspace")).toBe(true);
  });

  it("requires every token in a multi-word query, order-independent", () => {
    expect(searchSettings(SECTIONS, "font size").visible("terminal")).toBe(true);
    expect(searchSettings(SECTIONS, "size font").visible("terminal")).toBe(true);
    expect(searchSettings(SECTIONS, "font daemon").visible("terminal")).toBe(false);
  });

  it("hides every section when nothing matches", () => {
    const result = searchSettings(SECTIONS, "nonexistent");
    expect(result.filtering).toBe(true);
    expect(result.shown).toBe(0);
    expect(SECTIONS.every((s) => !result.visible(s.id))).toBe(true);
  });
});

// The keyword tables as they SHIP, read out of the two panels' source the
// way settingsSearchSurfaces.test.ts reads them. The fixture above proves
// the matcher; this proves the vocabulary, which is where the misses were:
// 41 plain-language queries measured against these tables showed the
// right section for 4 and an empty screen for 37 (see
// plans/done/typesafe-experiments-round-2.md). The synonyms below are the
// ones that were plain gaps -- a word a human types for a setting that no
// entry carried -- and the by-meaning fallback only runs after THESE have
// had their chance, so a synonym dropped from a table is a network call
// and a wait where a substring used to do.
function shippedSections(file: string): SettingsSection[] {
  const text = source(file);
  const body = text.match(/const SECTIONS: SettingsSection\[\] = \[([\s\S]*?)\n {2}\];/);
  if (!body) throw new Error(`${file}: SECTIONS not found in the shape this test expects`);
  return body[1]
    .split(/\{\s*id:/)
    .slice(1)
    .map((raw) => {
      const id = raw.match(/^\s*"([a-z-]+)"/)?.[1] ?? "";
      const list = raw.match(/keywords:\s*\[([\s\S]*?)\]/)?.[1] ?? "";
      const keywords = [...list.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      return { id, keywords };
    });
}

/// query -> the section(s) it must reach. Several where the word is
/// honestly ambiguous: "quota" is both the fallback chain's trigger and
/// the pause cycle's, and hiding either would send the human to the
/// wrong one.
const GLOBAL_SYNONYMS: [string, string[]][] = [
  ["text size", ["terminal"]],
  ["zoom", ["terminal"]],
  ["max agents", ["memory-wall"]],
  ["concurrent", ["memory-wall"]],
  ["limit agents", ["memory-wall"]],
  ["auto-commit", ["cards"]],
  ["dark mode", ["appearance"]],
  ["colour scheme", ["appearance"]],
  ["color scheme", ["appearance"]],
  ["quota", ["fallback-agent", "agent-pause"]],
  ["rate limit", ["fallback-agent", "agent-pause"]],
  ["upgrade", ["updates"]],
  ["new version", ["updates"]],
  ["beta", ["updates"]],
  ["phone", ["remote-access"]],
  ["device", ["remote-access"]],
];

/// The per-workspace panel has no Appearance, Memory wall, Updates or
/// Remote access; the rest of the list applies to it as well.
const HUB_SYNONYMS: [string, string[]][] = [
  ["text size", ["terminal"]],
  ["zoom", ["terminal"]],
  ["auto-commit", ["cards"]],
  ["quota", ["fallback-agent", "agent-pause"]],
  ["rate limit", ["fallback-agent", "agent-pause"]],
];

describe.each([
  ["GlobalSettingsView.svelte", GLOBAL_SYNONYMS],
  ["SettingsHubView.svelte", HUB_SYNONYMS],
])("the shipped keyword tables in %s", (file, synonyms) => {
  const sections = shippedSections(file);

  it("were read out of the source, not guessed", () => {
    expect(sections.length).toBeGreaterThan(5);
    expect(sections.every((s) => s.id !== "" && s.keywords.length > 0)).toBe(true);
  });

  it.each(synonyms)("reach a section for %j", (query, expected) => {
    const result = searchSettings(sections, query);
    expect(result.shown, `"${query}" shows an empty screen`).toBeGreaterThan(0);
    for (const id of expected) {
      expect(result.visible(id), `"${query}" should reach "${id}"`).toBe(true);
    }
  });
});
