import { describe, expect, it } from "vitest";
import type { GavinTree } from "$lib/core/gavin";
import { DEMO, sampleState } from "$companion/demo/sampleData";
import { NOTHING_OWED, phoneItems, type ItemsInput } from "$companion/surfaces/phoneItems";

function atlas(edit?: (tree: GavinTree) => void, extra: Partial<ItemsInput> = {}): ItemsInput {
  const state = sampleState();
  const tree = state.trees[DEMO.atlas];
  edit?.(tree);
  return {
    workspaceId: DEMO.atlas,
    tree,
    board: state.boards[DEMO.atlas],
    hasRoot: true,
    itemsBlockedReason: null,
    ...extra,
  };
}

/// Sets a demo card's status, by file name.
function status(fileName: string, value: string) {
  return (tree: GavinTree): void => {
    for (const ctx of tree.contexts) {
      const plan = ctx.plans.find((p) => p.fileName === fileName);
      if (plan) plan.status = value;
    }
  };
}

describe("the Decisions surface", () => {
  it("lists the cards with a decision waiting, and the clean is ready for them", () => {
    const list = phoneItems("decisions", atlas());
    expect(list.cards.map((c) => [c.title, c.status, c.items.map((i) => i.text)])).toEqual([
      ["Pick the session store", "In Progress", ["Redis or Postgres for the session store?"]],
    ]);
    expect(list.summary).toBe("1 decision waiting on you");
    expect(list.cleanLabel).toBe("Clean stale decisions");
    expect(list.cleanBlocked).toBeNull();
    expect(list.cleanable.map((e) => e.title)).toEqual(["Pick the session store"]);
  });

  it("leaves a test to the Review surface", () => {
    const list = phoneItems("decisions", atlas());
    expect(list.cards.flatMap((c) => c.items).every((i) => i.kind === "decision")).toBe(true);
  });

  it("asks nothing of a card that is Done, and then the clean says why it cannot run", () => {
    const list = phoneItems("decisions", atlas(status("session-store.md", "Done")));
    expect(list.cards).toEqual([]);
    expect(list.summary).toBeNull();
    expect(list.cleanBlocked).toBe("No card has an open decision");
    expect(NOTHING_OWED.decisions).toBe("No card in this workspace has a decision waiting on you.");
  });
});

describe("the Review surface", () => {
  it("lists the cards with a human test owed", () => {
    const list = phoneItems("tests", atlas());
    expect(list.cards.map((c) => [c.title, c.items.map((i) => i.kind)])).toEqual([["Invoice PDF rendering", ["test"]]]);
    expect(list.summary).toBe("1 test waiting on you");
    expect(list.cleanLabel).toBe("Clean stale tests");
    expect(list.cleanBlocked).toBeNull();
  });

  it("still lists a failed test, which the agent owes, but counts it as nobody's to run", () => {
    const list = phoneItems(
      "tests",
      atlas((tree) => {
        for (const ctx of tree.contexts) {
          for (const item of ctx.plans.flatMap((p) => p.humanItems ?? [])) if (item.kind === "test") item.state = "failed";
        }
      })
    );
    expect(list.cards).toHaveLength(1);
    expect(list.summary).toBeNull();
    // A failed test is still something a clean can close.
    expect(list.cleanBlocked).toBeNull();
  });
});

describe("what neither surface can know", () => {
  it("says an older daemon's silence is not an empty list, and the clean says so too", () => {
    const reason = "The Workstation's daemon is too old to list decisions";
    for (const kind of ["decisions", "tests"] as const) {
      const list = phoneItems(kind, atlas(undefined, { itemsBlockedReason: reason }));
      expect(list.cards).toEqual([]);
      expect(list.blocked).toBe(reason);
      expect(list.cleanBlocked).toBe(reason);
    }
  });

  it("will not start a clean in a workspace with no folder", () => {
    expect(phoneItems("tests", atlas(undefined, { hasRoot: false })).cleanBlocked).toMatch(/no root folder/);
  });

  it("is an empty list before the cards have arrived", () => {
    const list = phoneItems("decisions", { ...atlas(), tree: undefined, board: undefined });
    expect(list.cards).toEqual([]);
  });
});
