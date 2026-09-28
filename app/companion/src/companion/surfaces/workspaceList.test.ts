import { describe, expect, it } from "vitest";
import type { Workspace } from "$lib/core/workspace";
import { DEMO, sampleState } from "$companion/demo/sampleData";
import { workspaceRows, type WorkspaceListInput } from "$companion/surfaces/workspaceList";

function demoInput(): WorkspaceListInput {
  const state = sampleState();
  return {
    workspaces: state.workspaces.workspaces,
    boards: state.boards,
    trees: state.trees,
    tabs: {
      sessionStatusById: {
        "s-atlas-main": "idle",
        "s-atlas-auth": "working",
        "s-atlas-store": "waiting_for_input",
        "s-atlas-billing": "idle",
        "s-notes-sync": "working",
        "s-scratch": "idle",
      },
      fileTabsById: {},
      boardTabsById: {},
      cardTabsById: {},
    },
  };
}

function row(input: WorkspaceListInput, id: string) {
  const found = workspaceRows(input).find((r) => r.id === id);
  if (!found) throw new Error(`no row for ${id}`);
  return found;
}

describe("the workspace list", () => {
  it("has a row for every workspace, in the desk's order", () => {
    expect(workspaceRows(demoInput()).map((r) => r.name)).toEqual(["atlas-api", "field-notes", "Scratchpad"]);
  });

  it("puts the workspaces pinned at the desk first, oldest pin on top", () => {
    const input = demoInput();
    input.workspaces = input.workspaces.map((w): Workspace => {
      if (w.id === DEMO.scratch) return { ...w, pinnedAt: 100 };
      if (w.id === DEMO.notes) return { ...w, pinnedAt: 200 };
      return w;
    });
    expect(workspaceRows(input).map((r) => r.name)).toEqual(["Scratchpad", "field-notes", "atlas-api"]);
  });

  it("says what each workspace's agents are doing, in the desk's words", () => {
    const input = demoInput();
    expect(row(input, DEMO.atlas).agents).toBe("1 running · 1 waiting · 2 pages");
    expect(row(input, DEMO.notes).agents).toBe("1 running · 1 page");
    expect(row(input, DEMO.scratch).agents).toBe("1 page");
  });

  it("counts who is waiting on the human, which is what the row's badge shows", () => {
    const input = demoInput();
    expect(row(input, DEMO.atlas).waiting).toBe(1);
    expect(row(input, DEMO.notes).waiting).toBe(0);
  });

  it("counts an agent that broke, and leads the line with it", () => {
    const input = demoInput();
    input.tabs.sessionStatusById["s-atlas-auth"] = "failed";
    expect(row(input, DEMO.atlas).failed).toBe(1);
    expect(row(input, DEMO.atlas).agents).toBe("1 stopped · 1 waiting · 2 pages");
  });

  it("counts the cards in each column, in board order, with the unmatched statuses after", () => {
    const columns = row(demoInput(), DEMO.atlas).columns;
    expect(columns.map((c) => [c.name, c.count, c.tone])).toEqual([
      ["To Do", 4, "todo"],
      ["In Progress", 3, "progress"],
      ["Review", 1, "progress"],
      ["Done", 1, "done"],
      ["Blocked", 1, "progress"],
    ]);
    expect(row(demoInput(), DEMO.atlas).cards).toBe(10);
  });

  it("does not count a task nested in a plan as a card of its own", () => {
    // field-notes has four card files; one is a task inside "Offline sync".
    expect(row(demoInput(), DEMO.notes).cards).toBe(3);
  });

  it("names the folder a workspace is bound to", () => {
    expect(row(demoInput(), DEMO.atlas).folder).toBe("/Users/demo/code/atlas-api");
  });

  it("has no folder and no columns to show for a workspace bound to none", () => {
    const scratch = row(demoInput(), DEMO.scratch);
    expect(scratch.folder).toBeNull();
    expect(scratch.columns).toEqual([]);
    expect(scratch.cards).toBe(0);
  });

  it("shows no counts, rather than zeros, until a workspace's board has arrived", () => {
    const input = demoInput();
    input.boards = {};
    const atlas = row(input, DEMO.atlas);
    expect(atlas.columns).toEqual([]);
    expect(atlas.cards).toBe(0);
    expect(atlas.loaded).toBe(false);
    input.boards = sampleState().boards;
    expect(row(input, DEMO.atlas).loaded).toBe(true);
  });

  it("takes the workspace's accent, and the default where the desk set none", () => {
    expect(row(demoInput(), DEMO.atlas).color).toBe("#2dd4bf");
    expect(row(demoInput(), DEMO.scratch).color).toBe("#4a9eff");
  });

  it("refuses an accent that is not a colour", () => {
    const input = demoInput();
    input.workspaces = input.workspaces.map((w) =>
      w.id === DEMO.atlas ? { ...w, color: "red; background: url(x)" } : w
    );
    expect(row(input, DEMO.atlas).color).toBe("#4a9eff");
  });
});
