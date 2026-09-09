import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  boardSelection,
  toggleCardSelected,
  clearBoardSelection,
  toggleSelection,
  selectedCards,
  runnableSelection,
  selectionRunConfirm,
} from "$lib/board/boardSelection";
import { launchEstimate } from "$lib/agents/launchEstimate";
import type { CardView } from "$lib/core/planBoard";

function card(id: string, kind: CardView["kind"] = "task", nestedChildren: CardView[] = []): CardView {
  return {
    id,
    title: id,
    status: "To Do",
    priority: null,
    order: null,
    kind,
    parent: null,
    parentTitle: null,
    parentBroken: false,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    contextName: "root",
    contextFolder: "/w/.gavin-root",
    fileName: `${id}.md`,
    parseWarning: false,
    nestedChildren,
  };
}

beforeEach(() => {
  boardSelection.set([]);
});

describe("toggleSelection", () => {
  it("adds an unpicked id at the end and removes a picked one", () => {
    expect(toggleSelection([], "a")).toEqual(["a"]);
    expect(toggleSelection(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleSelection(["a", "b"], "a")).toEqual(["b"]);
  });

  it("never mutates the array it was given", () => {
    const before = ["a"];
    toggleSelection(before, "b");
    expect(before).toEqual(["a"]);
  });
});

describe("selectedCards", () => {
  const all = [card("a"), card("b", "note"), card("c", "plan")];

  it("returns the picked cards in BOARD order, not click order", () => {
    expect(selectedCards(all, ["c", "a"]).map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("silently ignores ids this surface doesn't show", () => {
    // A context BoardPane projects one folder; a hub selection may name
    // cards it never renders. Those must not count, and must not throw.
    expect(selectedCards(all, ["a", "/elsewhere/z.md"]).map((c) => c.id)).toEqual(["a"]);
    expect(selectedCards([], ["a"])).toEqual([]);
  });

  it("returns each card once even if the projection repeats it", () => {
    expect(selectedCards([card("a"), card("a")], ["a"]).map((c) => c.id)).toEqual(["a"]);
  });
});

describe("runnableSelection", () => {
  const all = [card("a"), card("note", "note"), card("plan", "plan"), card("bound")];

  it("keeps tasks and plans, drops notes and cards with a live binding", () => {
    const ids = runnableSelection(all, (id) => id === "bound").map((c) => c.id);
    expect(ids).toEqual(["a", "plan"]);
  });

  it("is empty when nothing picked can run", () => {
    expect(runnableSelection([card("note", "note")], () => false)).toEqual([]);
  });
});

describe("the app-wide selection store", () => {
  it("toggles ids in and out", () => {
    toggleCardSelected("a");
    toggleCardSelected("b");
    expect(get(boardSelection)).toEqual(["a", "b"]);
    toggleCardSelected("a");
    expect(get(boardSelection)).toEqual(["b"]);
  });

  it("clearing an already-empty selection keeps the same array (no needless store churn)", () => {
    const before = get(boardSelection);
    clearBoardSelection();
    expect(get(boardSelection)).toBe(before);
    toggleCardSelected("a");
    clearBoardSelection();
    expect(get(boardSelection)).toEqual([]);
  });
});

// The bar used to launch on the click itself. A selection can span every
// column on the board, so it is the one press here with no upper bound
// at all -- which makes it the press that most needs both the list and
// the number before anything spawns.
describe("selectionRunConfirm", () => {
  const targets = [card("Fix login"), card("Add tests")];

  it("names the count and every card it is about to run", () => {
    const content = selectionRunConfirm(targets);
    expect(content.title).toBe("Run 2 selected cards?");
    expect(content.lines).toContain("Runs: Fix login, Add tests.");
    expect(content.confirmLabel).toBe("Run 2 cards");
  });

  it("singularizes a lone card", () => {
    const content = selectionRunConfirm([card("Only one")]);
    expect(content.title).toBe("Run 1 selected card?");
    expect(content.confirmLabel).toBe("Run 1 card");
  });

  it("carries the memory estimate as its last line", () => {
    const content = selectionRunConfirm(
      targets,
      launchEstimate({
        count: 2,
        profileId: "claude-code",
        means: { "claude-code": 2 * 1024 ** 3 },
        storedMeans: {},
        measuredAgents: 1,
        sample: {
          supported: true,
          totalBytes: 32 * 1024 ** 3,
          freePercent: 50,
          pressureLevel: 1,
          swapUsedBytes: 0,
          sampledAtMs: 0,
        },
        maxInFlight: null,
        inFlight: 0,
      })
    );
    expect(content.lines[content.lines.length - 1]).toBe(
      "2 agents ≈ 4 GB (2 GB each, from the 1 running now) on top of 16 of 32 GB."
    );
  });

  it("says nothing about memory when no estimate is passed", () => {
    expect(selectionRunConfirm(targets).lines.some((l) => l.includes("GB"))).toBe(false);
  });
});
