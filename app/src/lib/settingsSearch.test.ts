import { describe, it, expect } from "vitest";
import { searchSettings, type SettingsSection } from "$lib/settingsSearch";

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
