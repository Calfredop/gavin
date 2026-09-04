import { describe, it, expect } from "vitest";
import {
  PAGE_PRESETS,
  WITH_AGENT_LABEL,
  newPageEntries,
  paneControlsApply,
  type PagePreset,
} from "./titleBarActions";
import { allSessionIds } from "./layout";
import type { Workspace, WorkspacesData } from "./workspace";

function ws(over: Partial<Workspace> = {}): Workspace {
  return { id: "ws-1", name: "ws-1", pages: [], activePageId: null, ...over };
}

function state(over: Partial<Workspace> = {}): WorkspacesData {
  return { workspaces: [ws(over)], activeWorkspaceId: "ws-1" };
}

describe("paneControlsApply", () => {
  it("offers the pane controls on the terminal view", () => {
    expect(paneControlsApply(state({ activeView: "terminal" }), false)).toBe(true);
  });

  it("withdraws them on every hub tab", () => {
    for (const view of ["home", "kanban", "git", "settings"]) {
      expect(paneControlsApply(state({ activeView: view }), false)).toBe(false);
    }
  });

  it("withdraws them under the app hub, whatever the workspace was showing", () => {
    expect(paneControlsApply(state({ activeView: "terminal" }), true)).toBe(false);
  });

  it("follows the default view of a workspace that has never picked one", () => {
    // A rooted workspace lands on Home; a rootless one on the terminal.
    expect(paneControlsApply(state({ rootPath: "/r" }), false)).toBe(false);
    expect(paneControlsApply(state(), false)).toBe(true);
  });

  it("withdraws them when no workspace is active at all", () => {
    expect(paneControlsApply({ workspaces: [], activeWorkspaceId: null }, false)).toBe(false);
  });
});

describe("PAGE_PRESETS", () => {
  it("builds a tree over exactly the ids its session count asks for", () => {
    for (const preset of PAGE_PRESETS) {
      const ids = Array.from({ length: preset.sessionCount }, (_, i) => `s${i}`);
      expect(allSessionIds(preset.build(ids)).sort()).toEqual([...ids].sort());
    }
  });

  it("has a unique id and a label per entry", () => {
    expect(new Set(PAGE_PRESETS.map((p) => p.id)).size).toBe(PAGE_PRESETS.length);
    expect(PAGE_PRESETS.every((p) => p.label.length > 0)).toBe(true);
  });
});

describe("newPageEntries", () => {
  it("leads with the agent checkbox, then lists every preset in table order", () => {
    const entries = newPageEntries(false, () => {}, () => {});
    expect(entries.map((e) => ("separator" in e ? "--" : e.label))).toEqual([
      WITH_AGENT_LABEL,
      "--",
      ...PAGE_PRESETS.map((p) => p.label),
    ]);
  });

  it("hands the picked preset back whole, so the caller never re-looks it up", () => {
    const picked: PagePreset[] = [];
    const entries = newPageEntries(false, () => {}, (p) => picked.push(p));
    for (const entry of entries.slice(2)) {
      if (!("separator" in entry)) entry.onPick();
    }
    expect(picked).toEqual(PAGE_PRESETS);
  });

  // The checkbox qualifies the picks under it, so it has to say which
  // way it is set BEFORE one of them is chosen -- and it must not shut
  // the menu it is a row of, or the tick would never be seen.
  it("draws the checkbox from the state it was given, and keeps the menu open", () => {
    for (const withAgent of [false, true]) {
      const [toggle] = newPageEntries(withAgent, () => {}, () => {});
      expect("separator" in toggle ? null : toggle.checked).toBe(withAgent);
      expect("separator" in toggle ? null : toggle.keepOpen).toBe(true);
    }
  });

  it("routes the checkbox to the toggle callback and nothing else", () => {
    let toggles = 0;
    const picked: PagePreset[] = [];
    const [toggle] = newPageEntries(false, () => (toggles += 1), (p) => picked.push(p));
    if (!("separator" in toggle)) toggle.onPick();
    expect(toggles).toBe(1);
    expect(picked).toEqual([]);
  });

  // A preset is a plain pick whether the box is ticked or not: one
  // click still adds a page, and the tick only changes what starts in
  // its panes.
  it("leaves the presets as one-click picks that dismiss the menu", () => {
    for (const entry of newPageEntries(true, () => {}, () => {}).slice(2)) {
      if ("separator" in entry) continue;
      expect(entry.keepOpen).toBeUndefined();
      expect(entry.checked).toBeUndefined();
    }
  });
});
