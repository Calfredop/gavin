// Every Tauri module the desktop's library imports has to resolve to a
// shim here. One that does not is Tauri's own JS in the bundle: at best a
// build that fails on a name the shim does not export, at worst code that
// reaches for a native bridge from a page that must not have one.
import { describe, expect, it } from "vitest";
// The desktop's own source map rather than node:fs, as its guards do:
// @types/node is not installed for a browser bundle.
import { allSources } from "$lib/sources";
import { companionSources } from "$companion/testing/companionSources";
import config from "../../../svelte.config.js";

function tauriModulesImportedBy(sources: Record<string, string>): string[] {
  const found = new Set<string>();
  for (const text of Object.values(sources)) {
    for (const match of text.matchAll(/from\s+"(@tauri-apps\/[^"]+)"/g)) found.add(match[1]);
  }
  return [...found].sort();
}

const alias: Record<string, string> = config.kit?.alias ?? {};
const aliased = Object.keys(alias).filter((name) => name.startsWith("@tauri-apps/"));

describe("the Tauri modules the desktop's library imports", () => {
  const imported = tauriModulesImportedBy(allSources());

  it("are found by this guard", () => {
    expect(imported).toContain("@tauri-apps/api/core");
    expect(imported).toContain("@tauri-apps/api/event");
    expect(imported.length).toBeGreaterThanOrEqual(5);
  });

  it("each resolve to a shim of this bundle's", () => {
    expect(imported.filter((name) => !aliased.includes(name))).toEqual([]);
  });

  it("each resolve to a file that exists", () => {
    const shipped = Object.keys(companionSources());
    for (const name of aliased) {
      expect(shipped, name).toContain(alias[name].replace(/^src\//, ""));
    }
  });
});

describe("the bundle's own code", () => {
  it("imports no Tauri module that is not a shim either", () => {
    expect(tauriModulesImportedBy(companionSources()).filter((name) => !aliased.includes(name))).toEqual([]);
  });
});
