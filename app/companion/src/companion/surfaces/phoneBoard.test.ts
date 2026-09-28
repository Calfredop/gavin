import { describe, expect, it } from "vitest";
import type { Board } from "$lib/board/kanban";
import { DEMO, sampleState } from "$companion/demo/sampleData";
import {
  cardAgent,
  columnAt,
  openingColumn,
  phoneBoard,
  scrollBehaviour,
  type AgentsInput,
} from "$companion/surfaces/phoneBoard";

const state = () => sampleState();
const atlas = () => phoneBoard(state().boards[DEMO.atlas], state().trees[DEMO.atlas]);

function path(fileName: string): string {
  for (const tree of Object.values(state().trees)) {
    for (const ctx of tree.contexts) {
      const plan = ctx.plans.find((p) => p.fileName === fileName);
      if (plan) return plan.path;
    }
  }
  throw new Error(`the demo has no card ${fileName}`);
}

describe("a board, one column at a time", () => {
  it("is nothing until the board has arrived", () => {
    expect(phoneBoard(undefined, state().trees[DEMO.atlas])).toBeNull();
  });

  it("has the board's columns in the board's order, then the statuses no column matches", () => {
    expect(atlas()!.columns.map((c) => [c.name, c.unmatched])).toEqual([
      ["To Do", false],
      ["In Progress", false],
      ["Review", false],
      ["Done", false],
      ["Blocked", true],
    ]);
  });

  it("gives every column a key of its own, stable across a redraw", () => {
    const keys = atlas()!.columns.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(atlas()!.columns.map((c) => c.key)).toEqual(keys);
  });

  it("colours a column the way the desk's sidebar counts it", () => {
    expect(atlas()!.columns.map((c) => c.tone)).toEqual(["todo", "progress", "progress", "done", "progress"]);
  });

  it("puts each card where its status says, in the desk's order", () => {
    const todo = atlas()!.columns[0];
    expect(todo.cards.map((c) => c.title)).toEqual([
      "Fix the flaky session-expiry test",
      "Rate-limit the login endpoint",
      "Ask design about the empty state",
      "Proration on plan change",
    ]);
  });

  it("keeps a plan's tasks inside the plan", () => {
    const plan = atlas()!.columns[1].cards.find((c) => c.title === "Token refresh rework")!;
    expect(plan.nestedChildren.map((c) => c.title)).toEqual([
      "Rotate refresh tokens on use",
      "Revoke the token family on reuse",
      "Migrate stored sessions",
    ]);
    const everyCard = atlas()!.columns.flatMap((c) => c.cards.map((card) => card.title));
    expect(everyCard).not.toContain("Rotate refresh tokens on use");
  });

  it("carries the board's labels, for the chips' colours", () => {
    expect(atlas()!.labels.map((l) => l.name)).toContain("backend");
  });

  it("draws the columns over no cards while the tree is still on its way", () => {
    const board = phoneBoard(state().boards[DEMO.atlas], undefined)!;
    expect(board.columns.map((c) => c.cards.length)).toEqual([0, 0, 0, 0]);
  });

  it("leaves archived cards off the board", () => {
    const s = state();
    const card = s.trees[DEMO.atlas].contexts[0].plans.find((p) => p.fileName === "audit-log-export.md")!;
    card.path = card.path.replace("/plans/done/", "/plans/archive/");
    const done = phoneBoard(s.boards[DEMO.atlas], s.trees[DEMO.atlas])!.columns[3];
    expect(done.cards).toEqual([]);
  });
});

describe("the column a board opens on", () => {
  it("is the first with work in flight: that is what a phone is picked up to check", () => {
    const board = atlas()!;
    expect(openingColumn(board.columns)).toBe(board.columns[1].key);
  });

  it("is the first with anything in it when nothing is in flight", () => {
    const s = state();
    for (const ctx of s.trees[DEMO.atlas].contexts) {
      ctx.plans = ctx.plans.filter((p) => p.status === "Done" || p.status === "To Do");
    }
    const board = phoneBoard(s.boards[DEMO.atlas], s.trees[DEMO.atlas])!;
    expect(openingColumn(board.columns)).toBe(board.columns[0].key);
  });

  it("is the first column on an empty board, and nothing on a board with no columns", () => {
    const board = phoneBoard(state().boards[DEMO.atlas], undefined)!;
    expect(openingColumn(board.columns)).toBe(board.columns[0].key);
    const none: Board = { columns: [], labels: [], cardSessions: [] };
    expect(openingColumn(phoneBoard(none, undefined)!.columns)).toBeNull();
  });
});

describe("the agent on a card", () => {
  function input(): AgentsInput {
    const s = state();
    return {
      board: s.boards[DEMO.atlas],
      layout: {
        workspaces: s.workspaces.workspaces,
        activeWorkspaceId: null,
        interruptedSessionIds: new Set(),
        failureReasonById: {},
      },
      statusById: {
        "s-atlas-auth": "working",
        "s-atlas-store": "waiting_for_input",
        "s-atlas-billing": "idle",
      },
    };
  }

  it("is none for a card no session is bound to", () => {
    expect(cardAgent(input(), path("flaky-expiry-test.md"))).toBeNull();
  });

  it("says what the bound session is doing, in the desk's own badge", () => {
    expect(cardAgent(input(), path("token-refresh.md"))!.state).toBe("working");
    expect(cardAgent(input(), path("session-store.md"))!.state).toBe("waiting_for_input");
    expect(cardAgent(input(), path("invoice-pdf.md"))!.state).toBe("idle");
  });

  it("reads a session that has not reported yet as idle", () => {
    const i = input();
    i.statusById = {};
    expect(cardAgent(i, path("token-refresh.md"))!.state).toBe("idle");
  });

  it("says exited for a binding that outlived its session", () => {
    const i = input();
    i.layout.workspaces = i.layout.workspaces.map((w) => ({ ...w, pages: [], mainSessionId: undefined }));
    expect(cardAgent(i, path("token-refresh.md"))!.state).toBe("exited");
  });

  it("says interrupted before any status: the status describes the shell that replaced the agent", () => {
    const i = input();
    i.layout.interruptedSessionIds = new Set(["s-atlas-auth"]);
    expect(cardAgent(i, path("token-refresh.md"))!.state).toBe("interrupted");
  });

  it("says failed, with the agent's own sentence", () => {
    const i = input();
    i.statusById["s-atlas-auth"] = "failed";
    i.layout.failureReasonById = { "s-atlas-auth": "API Error: 529 Overloaded" };
    const badge = cardAgent(i, path("token-refresh.md"))!;
    expect(badge.state).toBe("failed");
    expect(badge.tip).toContain("API Error: 529 Overloaded");
  });

  it("is none while the board is still on its way", () => {
    const i = input();
    i.board = undefined;
    expect(cardAgent(i, path("token-refresh.md"))).toBeNull();
  });
});

describe("moving to a column that was tapped", () => {
  it("glides, on a page that is on screen", () => {
    expect(scrollBehaviour({ reducedMotion: false, visible: true })).toBe("smooth");
  });

  it("jumps for someone who asked for less motion", () => {
    expect(scrollBehaviour({ reducedMotion: true, visible: true })).toBe("auto");
  });

  it("jumps on a page that is not being drawn, where a glide would never start", () => {
    // An animated scroll is driven by frames, and a hidden page gets
    // none: the strip would say one column and the pager show another.
    expect(scrollBehaviour({ reducedMotion: false, visible: false })).toBe("auto");
  });
});

describe("which column a swipe has settled on", () => {
  const keys = ["a", "b", "c"];

  it("is the one most of the screen is showing", () => {
    expect(columnAt(keys, 0, 390)).toBe("a");
    expect(columnAt(keys, 190, 390)).toBe("a");
    expect(columnAt(keys, 200, 390)).toBe("b");
    expect(columnAt(keys, 780, 390)).toBe("c");
  });

  it("is the last column when the pager is pulled past its end", () => {
    expect(columnAt(keys, 900, 390)).toBe("c");
    expect(columnAt(keys, -40, 390)).toBe("a");
  });

  it("is none before the pager has a width, or a column", () => {
    expect(columnAt(keys, 0, 0)).toBeNull();
    expect(columnAt([], 0, 390)).toBeNull();
  });
});
