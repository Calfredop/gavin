import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("$lib/core/backend", () => ({
  deleteCardFile: vi.fn(),
  setPlanFrontmatterField: vi.fn(),
  getBoard: vi.fn().mockResolvedValue({ columns: [], labels: [], cardSessions: [] }),
}));

import * as backend from "$lib/core/backend";
import {
  deletionPlanFor,
  columnDeletionPlan,
  executeDeletion,
  executeMoveCards,
  cardDeleteLines,
} from "$lib/cards/cardDelete";
import { kanbanState } from "$lib/board/kanbanState";
import type { CardView } from "$lib/core/planBoard";

function view(path: string, kind: "note" | "task" | "plan", status: string | null, extra: Partial<CardView> = {}): CardView {
  return {
    id: path,
    title: path,
    status,
    priority: null,
    order: null,
    kind,
    parent: null,
    parentTitle: null,
    parentBroken: false,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    contextName: "p",
    contextFolder: "/p",
    fileName: path.split("/").at(-1) ?? path,
    parseWarning: false,
    nestedChildren: [],
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  kanbanState.set({});
});

describe("deletionPlanFor", () => {
  it("a note/task deletes just itself", () => {
    const plan = deletionPlanFor(view("/p/n.md", "note", "To Do"), []);
    expect(plan.files.map((f) => f.id)).toEqual(["/p/n.md"]);
    expect(plan.unparent).toEqual([]);
  });

  it("a plan cascades nested children and un-parents free ones", () => {
    const nested = view("/p/c1.md", "task", null, { parent: "big.md" });
    const free = view("/p/c2.md", "task", "In Progress", { parent: "big.md" });
    const otherCtx = view("/q/c3.md", "task", "In Progress", { parent: "big.md", contextFolder: "/q" });
    const plan = view("/p/big.md", "plan", "To Do", { nestedChildren: [nested] });
    const d = deletionPlanFor(plan, [plan, nested, free, otherCtx]);
    expect(d.files.map((f) => f.id)).toEqual(["/p/big.md", "/p/c1.md"]);
    expect(d.unparent.map((u) => u.id)).toEqual(["/p/c2.md"]); // other context untouched
  });
});

describe("columnDeletionPlan", () => {
  it("aggregates and dedupes; queued files never get un-parented", () => {
    const nested = view("/p/c1.md", "task", null, { parent: "big.md" });
    const freeInColumn = view("/p/c2.md", "task", "To Do", { parent: "big.md" });
    const plan = view("/p/big.md", "plan", "To Do", { nestedChildren: [nested] });
    const d = columnDeletionPlan([plan, freeInColumn], [plan, nested, freeInColumn]);
    // c2 is IN the column -> deleted, not un-parented.
    expect(d.files.map((f) => f.id)).toEqual(["/p/big.md", "/p/c1.md", "/p/c2.md"]);
    expect(d.unparent).toEqual([]);
  });
});

describe("executeDeletion", () => {
  it("deletes then un-parents, sequentially, patch-on-success", async () => {
    vi.mocked(backend.deleteCardFile).mockResolvedValue(undefined);
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    const err = await executeDeletion("ws", {
      files: [view("/p/a.md", "plan", "To Do"), view("/p/b.md", "task", null)],
      unparent: [view("/p/c.md", "task", "Done")],
    }, "grant");
    expect(err).toBeNull();
    expect(vi.mocked(backend.deleteCardFile).mock.calls.map((c) => c[0])).toEqual(["/p/a.md", "/p/b.md"]);
    expect(vi.mocked(backend.setPlanFrontmatterField).mock.calls).toEqual([["/p/c.md", "parent", ""]]);
  });

  it("stops on the first failure and names the file", async () => {
    vi.mocked(backend.deleteCardFile)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("locked"));
    const err = await executeDeletion("ws", {
      files: [view("/p/a.md", "note", null), view("/p/b.md", "note", null), view("/p/c.md", "note", null)],
      unparent: [],
    }, "grant");
    expect(err).toContain("b.md");
    expect(err).toContain("locked");
    expect(backend.deleteCardFile).toHaveBeenCalledTimes(2);
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
  });
});

describe("executeMoveCards", () => {
  it("writes each card's status to the destination, in order", async () => {
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    const err = await executeMoveCards(
      "ws",
      [view("/p/a.md", "plan", "Blocked"), view("/p/b.md", "note", "Blocked")],
      "In Progress"
    );
    expect(err).toBeNull();
    expect(vi.mocked(backend.setPlanFrontmatterField).mock.calls).toEqual([
      ["/p/a.md", "status", "In Progress"],
      ["/p/b.md", "status", "In Progress"],
    ]);
  });

  it("stops on the first failure and names the file", async () => {
    vi.mocked(backend.setPlanFrontmatterField)
      .mockImplementationOnce(async (p) => p)
      .mockRejectedValueOnce(new Error("read-only"));
    const err = await executeMoveCards(
      "ws",
      [view("/p/a.md", "note", "X"), view("/p/b.md", "note", "X"), view("/p/c.md", "note", "X")],
      "Done"
    );
    expect(err).toContain("b.md");
    expect(err).toContain("read-only");
    expect(backend.setPlanFrontmatterField).toHaveBeenCalledTimes(2);
  });
});

describe("cardDeleteLines", () => {
  const bare = { fileName: "card.md", files: 1, unparent: 0, boundSession: false };

  it("names the file and nothing else when the card stands alone", () => {
    expect(cardDeleteLines(bare)).toEqual(["Deletes card.md permanently."]);
  });

  // `files` counts the card itself, so a plan with two nested tasks is
  // three files -- the line has to say two.
  it("counts nested tasks without counting the card", () => {
    expect(cardDeleteLines({ ...bare, files: 3 })[1]).toBe("Also deletes 2 nested tasks.");
    expect(cardDeleteLines({ ...bare, files: 2 })[1]).toBe("Also deletes 1 nested task.");
  });

  // The free-standing children survive; the line has to read as a
  // consequence for THEM, not as more deletion.
  it("says free-standing children keep their column", () => {
    expect(cardDeleteLines({ ...bare, unparent: 1 })[1]).toBe(
      "1 free-standing task keeps their column (un-parented)."
    );
    expect(cardDeleteLines({ ...bare, unparent: 2 })[1]).toBe(
      "2 free-standing tasks keep their column (un-parented)."
    );
  });

  it("warns that a bound session outlives the file", () => {
    expect(cardDeleteLines({ ...bare, boundSession: true })[1]).toBe(
      "A bound agent session keeps running on the Agents page."
    );
  });

  // Certain first, conditional after: the file always goes, the rest
  // depends on what was hanging off it.
  it("orders the lines file, nested, un-parented, session", () => {
    expect(cardDeleteLines({ fileName: "p.md", files: 2, unparent: 1, boundSession: true })).toEqual([
      "Deletes p.md permanently.",
      "Also deletes 1 nested task.",
      "1 free-standing task keeps their column (un-parented).",
      "A bound agent session keeps running on the Agents page.",
    ]);
  });
});
