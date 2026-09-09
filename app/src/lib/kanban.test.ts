import { describe, it, expect } from "vitest";
import {
  addColumn,
  renameColumn,
  reorderColumn,
  deleteColumn,
  addLabel,
  updateLabel,
  deleteLabel,
  type Board,
  type Label,
} from "$lib/kanban";

function label(id: string, name: string): Label {
  return { id, name, color: "#ff0000" };
}

function board(columnIds: string[], labels: Label[] = []): Board {
  return { columns: columnIds.map((id, i) => ({ id, name: id, position: i })), labels, cardSessions: [] };
}

describe("addColumn", () => {
  it("appends the column", () => {
    const b = addColumn(board(["a"]), { id: "b", name: "b", position: 1 });
    expect(b.columns.map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("renameColumn", () => {
  it("renames only the target", () => {
    const b = renameColumn(board(["a", "b"]), "a", "Renamed");
    expect(b.columns[0].name).toBe("Renamed");
    expect(b.columns[1].name).toBe("b");
  });
});

describe("reorderColumn", () => {
  it("moves a column to the given index and reindexes positions", () => {
    const b = reorderColumn(board(["x", "y", "z"]), "z", 0);
    expect(b.columns.map((c) => c.id)).toEqual(["z", "x", "y"]);
    expect(b.columns.map((c) => c.position)).toEqual([0, 1, 2]);
  });

  // Same post-removal index contract as the drag engine supplies.
  it("targetIndex is POST-removal: index 1 puts x between y and z in [x,y,z]", () => {
    const b = reorderColumn(board(["x", "y", "z"]), "x", 1);
    expect(b.columns.map((c) => c.id)).toEqual(["y", "x", "z"]);
  });

  it("unknown column is a no-op", () => {
    const before = board(["x"]);
    expect(reorderColumn(before, "nope", 0)).toBe(before);
  });
});

describe("deleteColumn", () => {
  it("removes the column and reindexes the rest", () => {
    const b = deleteColumn(board(["a", "b", "c"]), "b");
    expect(b.columns.map((c) => c.id)).toEqual(["a", "c"]);
    expect(b.columns.map((c) => c.position)).toEqual([0, 1]);
  });
});

describe("labels", () => {
  it("addLabel appends", () => {
    const b = addLabel(board([]), label("l1", "urgent"));
    expect(b.labels).toHaveLength(1);
  });

  it("updateLabel patches only the target", () => {
    const b = updateLabel(board([], [label("l1", "urgent"), label("l2", "ui")]), "l1", { name: "hot" });
    expect(b.labels[0].name).toBe("hot");
    expect(b.labels[1].name).toBe("ui");
  });

  it("deleteLabel removes only the target", () => {
    const b = deleteLabel(board([], [label("l1", "urgent"), label("l2", "ui")]), "l1");
    expect(b.labels.map((l) => l.id)).toEqual(["l2"]);
  });
});
