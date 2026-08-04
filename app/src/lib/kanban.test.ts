import { describe, it, expect } from "vitest";
import {
  addCard,
  updateCard,
  moveCard,
  deleteCard,
  linkSession,
  unlinkSession,
  updateSessionLink,
  addLabel,
  updateLabel,
  deleteLabel,
  addColumn,
  renameColumn,
  reorderColumn,
  deleteColumnCascade,
  moveCardsOutOfColumn,
  type Board,
  type Card,
  type Label,
} from "./kanban";

function card(id: string, position: number, labelIds: string[] = []): Card {
  return { id, title: id, description: "", labelIds, priority: "none", position };
}

function label(id: string, name: string): Label {
  return { id, name, color: "#ff0000" };
}

function board(columns: { id: string; cards: Card[] }[], labels: Label[] = []): Board {
  return { columns: columns.map((c, i) => ({ id: c.id, name: c.id, position: i, cards: c.cards })), labels };
}

describe("addCard", () => {
  it("appends the card to the given column", () => {
    const b = board([{ id: "c1", cards: [] }]);
    const updated = addCard(b, "c1", card("card-1", 0));
    expect(updated.columns[0].cards).toEqual([card("card-1", 0)]);
  });

  it("leaves other columns untouched", () => {
    const b = board([{ id: "c1", cards: [] }, { id: "c2", cards: [card("existing", 0)] }]);
    const updated = addCard(b, "c1", card("card-1", 0));
    expect(updated.columns[1].cards).toEqual([card("existing", 0)]);
  });
});

describe("updateCard", () => {
  it("patches only the given fields", () => {
    const b = board([{ id: "c1", cards: [card("card-1", 0)] }]);
    const updated = updateCard(b, "card-1", { title: "New title", priority: "high" });
    expect(updated.columns[0].cards[0].title).toBe("New title");
    expect(updated.columns[0].cards[0].priority).toBe("high");
    expect(updated.columns[0].cards[0].description).toBe("");
  });

  it("is a no-op when the card id doesn't exist", () => {
    const b = board([{ id: "c1", cards: [card("card-1", 0)] }]);
    const updated = updateCard(b, "does-not-exist", { title: "X" });
    expect(updated).toEqual(b);
  });
});

describe("moveCard", () => {
  it("moves a card to a different column at the given index", () => {
    const b = board([
      { id: "c1", cards: [card("card-1", 0), card("card-2", 1)] },
      { id: "c2", cards: [] },
    ]);
    const updated = moveCard(b, "card-1", "c2", 0);
    expect(updated.columns[0].cards.map((c) => c.id)).toEqual(["card-2"]);
    expect(updated.columns[1].cards.map((c) => c.id)).toEqual(["card-1"]);
  });

  it("reindexes position within the source column after removal", () => {
    const b = board([{ id: "c1", cards: [card("card-1", 0), card("card-2", 1)] }, { id: "c2", cards: [] }]);
    const updated = moveCard(b, "card-1", "c2", 0);
    expect(updated.columns[0].cards[0].position).toBe(0);
  });

  it("reorders within the same column", () => {
    const b = board([{ id: "c1", cards: [card("a", 0), card("b", 1), card("c", 2)] }]);
    const updated = moveCard(b, "c", "c1", 0);
    expect(updated.columns[0].cards.map((c) => c.id)).toEqual(["c", "a", "b"]);
  });
});

describe("deleteCard", () => {
  it("removes the card from its column", () => {
    const b = board([{ id: "c1", cards: [card("card-1", 0), card("card-2", 1)] }]);
    const updated = deleteCard(b, "card-1");
    expect(updated.columns[0].cards.map((c) => c.id)).toEqual(["card-2"]);
  });
});

describe("linkSession", () => {
  it("sets the card's sessionLink", () => {
    const b = board([{ id: "c1", cards: [card("card-1", 0)] }]);
    const link = { sessionId: "s1", cwd: "/tmp", command: null };
    const updated = linkSession(b, "card-1", link);
    expect(updated.columns[0].cards[0].sessionLink).toEqual(link);
  });

  it("leaves other cards untouched", () => {
    const b = board([{ id: "c1", cards: [card("card-1", 0), card("card-2", 1)] }]);
    const updated = linkSession(b, "card-1", { sessionId: "s1", cwd: "/tmp", command: null });
    expect(updated.columns[0].cards[1].sessionLink).toBeUndefined();
  });
});

describe("unlinkSession", () => {
  it("clears the card's sessionLink", () => {
    const linked = { ...card("card-1", 0), sessionLink: { sessionId: "s1", cwd: "/tmp", command: null } };
    const b = board([{ id: "c1", cards: [linked] }]);
    const updated = unlinkSession(b, "card-1");
    expect(updated.columns[0].cards[0].sessionLink).toBeUndefined();
  });
});

describe("updateSessionLink", () => {
  it("replaces the sessionId while preserving cwd/command", () => {
    const linked = { ...card("card-1", 0), sessionLink: { sessionId: "old", cwd: "/tmp/project", command: "npm test" } };
    const b = board([{ id: "c1", cards: [linked] }]);
    const updated = updateSessionLink(b, "card-1", "new");
    expect(updated.columns[0].cards[0].sessionLink).toEqual({ sessionId: "new", cwd: "/tmp/project", command: "npm test" });
  });

  it("is a no-op when the card has no existing link", () => {
    const b = board([{ id: "c1", cards: [card("card-1", 0)] }]);
    const updated = updateSessionLink(b, "card-1", "new");
    expect(updated.columns[0].cards[0].sessionLink).toBeUndefined();
  });
});

describe("addLabel", () => {
  it("appends the label to the board", () => {
    const b = board([]);
    const updated = addLabel(b, label("l1", "urgent"));
    expect(updated.labels).toEqual([label("l1", "urgent")]);
  });
});

describe("updateLabel", () => {
  it("patches the given label's name/color", () => {
    const b = board([], [label("l1", "urgent")]);
    const updated = updateLabel(b, "l1", { name: "critical" });
    expect(updated.labels[0].name).toBe("critical");
    expect(updated.labels[0].color).toBe("#ff0000");
  });
});

describe("deleteLabel", () => {
  it("removes the label from the board", () => {
    const b = board([], [label("l1", "urgent")]);
    const updated = deleteLabel(b, "l1");
    expect(updated.labels).toEqual([]);
  });

  it("strips the deleted label's id from every card referencing it", () => {
    const b = board([{ id: "c1", cards: [card("card-1", 0, ["l1", "l2"])] }], [label("l1", "urgent")]);
    const updated = deleteLabel(b, "l1");
    expect(updated.columns[0].cards[0].labelIds).toEqual(["l2"]);
  });
});

describe("addColumn", () => {
  it("appends the column to the board", () => {
    const b = board([{ id: "c1", cards: [] }]);
    const updated = addColumn(b, { id: "c2", name: "New", position: 1, cards: [] });
    expect(updated.columns.map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});

describe("renameColumn", () => {
  it("renames the given column, leaving others untouched", () => {
    const b = board([{ id: "c1", cards: [] }, { id: "c2", cards: [] }]);
    const updated = renameColumn(b, "c1", "Renamed");
    expect(updated.columns[0].name).toBe("Renamed");
    expect(updated.columns[1].name).toBe("c2");
  });
});

describe("reorderColumn", () => {
  it("moves a column to the given index", () => {
    const b = board([{ id: "a", cards: [] }, { id: "b", cards: [] }, { id: "c", cards: [] }]);
    const updated = reorderColumn(b, "c", 0);
    expect(updated.columns.map((c) => c.id)).toEqual(["c", "a", "b"]);
  });

  it("reindexes position after reordering", () => {
    const b = board([{ id: "a", cards: [] }, { id: "b", cards: [] }]);
    const updated = reorderColumn(b, "b", 0);
    expect(updated.columns.map((c) => c.position)).toEqual([0, 1]);
  });
});

describe("deleteColumnCascade", () => {
  it("removes the column and every card inside it", () => {
    const b = board([
      { id: "c1", cards: [card("card-1", 0)] },
      { id: "c2", cards: [] },
    ]);
    const updated = deleteColumnCascade(b, "c1");
    expect(updated.columns.map((c) => c.id)).toEqual(["c2"]);
  });
});

describe("moveCardsOutOfColumn", () => {
  it("relocates every card from source to the end of target, then the caller deletes the empty source", () => {
    const b = board([
      { id: "c1", cards: [card("card-1", 0), card("card-2", 1)] },
      { id: "c2", cards: [card("existing", 0)] },
    ]);
    const moved = moveCardsOutOfColumn(b, "c1", "c2");
    expect(moved.columns[0].cards).toEqual([]);
    expect(moved.columns[1].cards.map((c) => c.id)).toEqual(["existing", "card-1", "card-2"]);

    const updated = deleteColumnCascade(moved, "c1");
    expect(updated.columns.map((c) => c.id)).toEqual(["c2"]);
    expect(updated.columns[0].cards.map((c) => c.id)).toEqual(["existing", "card-1", "card-2"]);
  });
});
