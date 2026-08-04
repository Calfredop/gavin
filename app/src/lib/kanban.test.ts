import { describe, it, expect } from "vitest";
import {
  addCard,
  updateCard,
  moveCard,
  deleteCard,
  addLabel,
  updateLabel,
  deleteLabel,
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
