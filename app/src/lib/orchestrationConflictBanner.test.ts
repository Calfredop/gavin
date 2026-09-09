import { describe, it, expect } from "vitest";
import { svelteSources } from "./sources";
import {
  collapseStorageKey,
  loadConflictsCollapsed,
  saveConflictsCollapsed,
} from "./orchestrationConflictBanner";

function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

describe("orchestration conflicts banner collapse", () => {
  it("keys the preference per workspace, under the app's namespace", () => {
    expect(collapseStorageKey("w1")).toMatch(/^gavin\./);
    expect(collapseStorageKey("w1")).not.toBe(collapseStorageKey("w2"));
  });

  // "Only expand on first appearance": with nothing remembered the box
  // opens, because a conflict nobody has seen yet is worth a glance.
  it("starts expanded when nothing has been remembered", () => {
    expect(loadConflictsCollapsed("w1", fakeStorage())).toBe(false);
  });

  it("remembers a collapse across a remount, per workspace", () => {
    const storage = fakeStorage();
    saveConflictsCollapsed("w1", true, storage);
    expect(loadConflictsCollapsed("w1", storage)).toBe(true);
    // Another workspace's box is untouched -- rails, and so conflicts,
    // are per workspace.
    expect(loadConflictsCollapsed("w2", storage)).toBe(false);
  });

  it("remembers re-expanding too, rather than falling back to the default", () => {
    const storage = fakeStorage();
    saveConflictsCollapsed("w1", true, storage);
    saveConflictsCollapsed("w1", false, storage);
    expect(loadConflictsCollapsed("w1", storage)).toBe(false);
    expect(storage.data[collapseStorageKey("w1")]).toBeDefined();
  });

  // A stale or hand-edited key must not decide the banner is broken:
  // forgetting is the only acceptable failure mode here.
  it("reads a corrupt or foreign payload as expanded", () => {
    for (const raw of ["", "yes", "{}", "[1]", "null"]) {
      expect(loadConflictsCollapsed("w1", fakeStorage({ [collapseStorageKey("w1")]: raw }))).toBe(
        false
      );
    }
  });

  it("survives storage being absent or refusing the write", () => {
    expect(loadConflictsCollapsed("w1", undefined)).toBe(false);
    expect(() => saveConflictsCollapsed("w1", true, undefined)).not.toThrow();
    const full = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(loadConflictsCollapsed("w1", full)).toBe(false);
    expect(() => saveConflictsCollapsed("w1", true, full)).not.toThrow();
  });
});

// The wiring itself is one line of component state, which no unit test can
// reach -- but a component that reads the preference and never writes it
// (or the reverse) is exactly the bug this card reported, so pin both ends
// against the source.
const SVELTE = svelteSources();

function codeOf(name: string): string {
  const text = SVELTE[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

describe("OrchestrationConflicts wiring", () => {
  const banner = codeOf("OrchestrationConflicts.svelte");

  it("seeds `collapsed` from the remembered preference, not from a literal", () => {
    expect(banner).toMatch(/loadConflictsCollapsed\(\s*workspaceId\s*\)/);
    expect(banner).not.toMatch(/collapsed\s*=\s*\$state\((true|false)\)/);
  });

  it("persists every toggle", () => {
    expect(banner).toMatch(/saveConflictsCollapsed\(/);
  });

  it("is handed the workspace whose preference it is", () => {
    expect(codeOf("OrchestrationHubView.svelte")).toMatch(
      /<OrchestrationConflicts[\s\S]{0,400}?\{workspaceId\}/
    );
  });
});
