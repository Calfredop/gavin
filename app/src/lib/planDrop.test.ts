import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("./backend", () => ({
  setPlanFrontmatterField: vi.fn(),
}));
vi.mock("./dialog", () => ({
  askConfirm: vi.fn(),
  askConfirmChecked: vi.fn(),
}));

import * as backend from "./backend";
import { askConfirmChecked } from "./dialog";
import { gavinTrees } from "./gavinState";
import { applyPlanDrop, placeCardAtColumnEnd, planCommitFromMerged } from "./planDrop";
import { dropHold } from "./kanbanDrag";
import type { GavinTree, PlanFileInfo } from "./gavin";
import type { CardView } from "./planBoard";

function planInfo(path: string, status: string | null, order: number | null): PlanFileInfo {
  const fileName = path.split("/").at(-1) ?? path;
  return {
    path,
    fileName,
    title: fileName,
    status,
    priority: null,
    order,
    kind: "plan",
    parent: null,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
  };
}

function seed(plans: PlanFileInfo[]): void {
  const t: GavinTree = {
    rootPath: "/p",
    rootMissing: false,
    contexts: [
      { folderPath: "/p", kind: "root", name: "p", plans, docs: [], specs: [], hasPrd: true, configWarning: false },
    ],
  };
  gavinTrees.set({ ws: t });
}

function planByPath(path: string): PlanFileInfo | undefined {
  return get(gavinTrees)["ws"].contexts[0].plans.find((p) => p.path === path);
}

beforeEach(() => {
  vi.clearAllMocks();
  gavinTrees.set({});
  dropHold.set(null);
});

describe("applyPlanDrop", () => {
  it("cross-column: writes status first, then order writes, patching each on success", async () => {
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    seed([planInfo("/p/a.md", "To Do", 1024), planInfo("/p/d.md", "To Do", null)]);
    const err = await applyPlanDrop({
      workspaceId: "ws",
      path: "/p/d.md",
      statusTarget: "In Progress",
      targetColumn: [{ path: "/p/a.md", order: 1024 }],
      targetIndex: 1,
    });
    expect(err).toBeNull();
    expect(vi.mocked(backend.setPlanFrontmatterField).mock.calls).toEqual([
      ["/p/d.md", "status", "In Progress"],
      ["/p/d.md", "order", "2048"],
    ]);
    expect(planByPath("/p/d.md")?.status).toBe("In Progress");
    expect(planByPath("/p/d.md")?.order).toBe(2048);
  });

  it("same-column: no status write", async () => {
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    seed([planInfo("/p/d.md", "To Do", null)]);
    const err = await applyPlanDrop({
      workspaceId: "ws",
      path: "/p/d.md",
      statusTarget: null,
      targetColumn: [],
      targetIndex: 0,
    });
    expect(err).toBeNull();
    expect(vi.mocked(backend.setPlanFrontmatterField).mock.calls).toEqual([["/p/d.md", "order", "1024"]]);
  });

  it("failure mid-batch stops, names the failing file, and skips its patch", async () => {
    vi.mocked(backend.setPlanFrontmatterField)
      .mockImplementationOnce(async (p) => p)
      .mockRejectedValueOnce(new Error("disk full"));
    seed([
      planInfo("/p/a.md", "To Do", null),
      planInfo("/p/b.md", "To Do", null),
      planInfo("/p/d.md", "To Do", null),
    ]);
    const err = await applyPlanDrop({
      workspaceId: "ws",
      path: "/p/d.md",
      statusTarget: null,
      // Unordered neighbors force a renumber: writes a.md, then d.md, then b.md.
      targetColumn: [
        { path: "/p/a.md", order: null },
        { path: "/p/b.md", order: null },
      ],
      targetIndex: 1,
    });
    expect(err).toContain("d.md");
    expect(err).toContain("disk full");
    expect(backend.setPlanFrontmatterField).toHaveBeenCalledTimes(2);
    expect(planByPath("/p/a.md")?.order).toBe(1024); // first write patched
    expect(planByPath("/p/d.md")?.order).toBeNull(); // failed write not patched
    expect(planByPath("/p/b.md")?.order).toBeNull(); // never attempted
  });

  it("planCommitFromMerged: drop on an auto column restatuses to the raw status", async () => {
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    seed([planInfo("/p/d.md", "To Do", null)]);
    const view = (path: string, order: number | null): CardView => ({
      id: path,
      title: path,
      status: "Blocked",
      priority: null,
      order,
      kind: "plan",
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
    });
    const err = await planCommitFromMerged(
      "ws",
      { id: "/p/d.md", sourceColumnId: "col1", target: { columnId: "auto:Blocked", index: 1 } },
      [{ id: "col1", name: "To Do", position: 0 }],
      {
        columns: [
          { column: { id: "col1", name: "To Do", position: 0 }, planCards: [view("/p/d.md", null)] },
        ],
        autoColumns: [{ status: "Blocked", planCards: [view("/p/q.md", 1024)] }],
      }
    );
    expect(err).toBeNull();
    expect(vi.mocked(backend.setPlanFrontmatterField).mock.calls).toEqual([
      ["/p/d.md", "status", "Blocked"],
      ["/p/d.md", "order", "2048"],
    ]);
  });

  it("planCommitFromMerged: same-column drop skips the status write and excludes the dragged card", async () => {
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    seed([planInfo("/p/d.md", "To Do", 1024)]);
    const view = (path: string, order: number | null): CardView => ({
      id: path,
      title: path,
      status: "To Do",
      priority: null,
      order,
      kind: "plan",
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
    });
    const err = await planCommitFromMerged(
      "ws",
      { id: "/p/d.md", sourceColumnId: "col1", target: { columnId: "col1", index: 0 } },
      [{ id: "col1", name: "To Do", position: 0 }],
      {
        columns: [
          {
            column: { id: "col1", name: "To Do", position: 0 },
            planCards: [view("/p/d.md", 1024), view("/p/a.md", 2048)],
          },
        ],
        autoColumns: [],
      }
    );
    expect(err).toBeNull();
    // d.md excluded from the block -> dropping at 0 means "before a.md" -> midpoint of (nothing, 2048).
    expect(vi.mocked(backend.setPlanFrontmatterField).mock.calls).toEqual([["/p/d.md", "order", "1024"]]);
  });

  // A plan dragged into Done takes its nested tasks with it, on disk and
  // on the board. The drag is one of the two gestures that used to do
  // that silently (cardCompletion.ts).
  describe("planCommitFromMerged: the completion cascade", () => {
    const COLS = [
      { id: "col1", name: "To Do", position: 0 },
      { id: "col2", name: "Done", position: 1 },
    ];
    function parentView(children: CardView[]): CardView {
      return {
        id: "/p/plan.md",
        title: "File explorer",
        status: "To Do",
        priority: null,
        order: 1024,
        kind: "plan",
        parent: null,
        parentTitle: null,
        parentBroken: false,
        labels: [],
        checklistDone: 0,
        checklistTotal: 0,
        contextName: "p",
        contextFolder: "/p",
        fileName: "plan.md",
        parseWarning: false,
        nestedChildren: children,
      };
    }
    const child: CardView = { ...parentView([]), id: "/p/lens.md", title: "Tree lens", kind: "task", status: null, fileName: "lens.md", parent: "plan.md", order: null };

    function drop(): Promise<string | null> {
      seed([planInfo("/p/plan.md", "To Do", 1024)]);
      return planCommitFromMerged(
        "ws",
        { id: "/p/plan.md", sourceColumnId: "col1", target: { columnId: "col2", index: 0 } },
        COLS,
        {
          columns: [
            { column: COLS[0], planCards: [parentView([child])] },
            { column: COLS[1], planCards: [] },
          ],
          autoColumns: [],
        }
      );
    }

    it("asks, and writes nothing at all, when the human cancels", async () => {
      vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
      vi.mocked(askConfirmChecked).mockResolvedValue({ confirmed: false, checked: false });
      expect(await drop()).toBeNull();
      expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
      // Nothing was written, so nothing may be held: the card has to be
      // back where the human grabbed it.
      expect(get(dropHold)).toBeNull();
    });

    it("breaks the child out first when the box is ticked, then files the plan", async () => {
      vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
      vi.mocked(askConfirmChecked).mockResolvedValue({ confirmed: true, checked: true });
      expect(await drop()).toBeNull();
      expect(vi.mocked(backend.setPlanFrontmatterField).mock.calls).toEqual([
        ["/p/lens.md", "status", "To Do"],
        ["/p/plan.md", "status", "Done"],
        ["/p/plan.md", "order", "1024"],
      ]);
    });

    it("says nothing when a plan is dragged anywhere but the done column", async () => {
      vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
      seed([planInfo("/p/plan.md", "Done", 1024)]);
      await planCommitFromMerged(
        "ws",
        { id: "/p/plan.md", sourceColumnId: "col2", target: { columnId: "col1", index: 0 } },
        COLS,
        {
          columns: [
            { column: COLS[0], planCards: [] },
            { column: COLS[1], planCards: [{ ...parentView([child]), status: "Done" }] },
          ],
          autoColumns: [],
        }
      );
      expect(askConfirmChecked).not.toHaveBeenCalled();
    });
  });

  it("planCommitFromMerged holds the drop visuals while writes are in flight, then releases", async () => {
    let resolveWrite!: () => void;
    vi.mocked(backend.setPlanFrontmatterField).mockImplementationOnce(
      (path) => new Promise<string>((resolve) => (resolveWrite = () => resolve(path)))
    );
    seed([planInfo("/p/d.md", "To Do", null)]);
    const pending = planCommitFromMerged(
      "ws",
      { id: "/p/d.md", sourceColumnId: "col1", target: { columnId: "col1", index: 0 } },
      [{ id: "col1", name: "To Do", position: 0 }],
      {
        columns: [
          {
            column: { id: "col1", name: "To Do", position: 0 },
            planCards: [
              {
                id: "/p/d.md", title: "d", status: "To Do", priority: null, order: null,
                kind: "plan" as const, parent: null, parentTitle: null, parentBroken: false,
                labels: [], checklistDone: 0, checklistTotal: 0,
                contextName: "p", contextFolder: "/p", fileName: "d.md", parseWarning: false,
                nestedChildren: [],
              },
              {
                id: "/p/a.md", title: "a", status: "To Do", priority: null, order: 1024,
                kind: "plan" as const, parent: null, parentTitle: null, parentBroken: false,
                labels: [], checklistDone: 0, checklistTotal: 0,
                contextName: "p", contextFolder: "/p", fileName: "a.md", parseWarning: false,
                nestedChildren: [],
              },
            ],
          },
        ],
        autoColumns: [],
      }
    );
    // In flight: the hold keeps the dragged card hidden + placeholder shown.
    expect(get(dropHold)).toEqual({
      kind: "plan",
      id: "/p/d.md",
      target: { columnId: "col1", index: 0 },
      size: undefined,
    });
    resolveWrite();
    const err = await pending;
    expect(err).toBeNull();
    expect(get(dropHold)).toBeNull();
  });

  it("planCommitFromMerged releases the hold on failure too", async () => {
    vi.mocked(backend.setPlanFrontmatterField).mockRejectedValue(new Error("nope"));
    seed([planInfo("/p/d.md", "To Do", null)]);
    const err = await planCommitFromMerged(
      "ws",
      { id: "/p/d.md", sourceColumnId: "col1", target: { columnId: "col2", index: 0 } },
      [
        { id: "col1", name: "To Do", position: 0 },
        { id: "col2", name: "Done", position: 1 },
      ],
      {
        columns: [
          {
            column: { id: "col1", name: "To Do", position: 0 },
            planCards: [
              {
                id: "/p/d.md", title: "d", status: "To Do", priority: null, order: null,
                kind: "plan" as const, parent: null, parentTitle: null, parentBroken: false,
                labels: [], checklistDone: 0, checklistTotal: 0,
                contextName: "p", contextFolder: "/p", fileName: "d.md", parseWarning: false,
                nestedChildren: [],
              },
            ],
          },
          { column: { id: "col2", name: "Done", position: 1 }, planCards: [] },
        ],
        autoColumns: [],
      }
    );
    expect(err).toContain("d.md");
    expect(get(dropHold)).toBeNull();
  });

  it("a failed status write skips the order writes entirely", async () => {
    vi.mocked(backend.setPlanFrontmatterField).mockRejectedValue(new Error("nope"));
    seed([planInfo("/p/d.md", "To Do", null)]);
    const err = await applyPlanDrop({
      workspaceId: "ws",
      path: "/p/d.md",
      statusTarget: "Done",
      targetColumn: [],
      targetIndex: 0,
    });
    expect(err).toContain("d.md");
    expect(backend.setPlanFrontmatterField).toHaveBeenCalledTimes(1);
    expect(planByPath("/p/d.md")?.status).toBe("To Do");
  });
});

describe("nest drops", () => {
  const view = (
    path: string,
    kind: "note" | "task" | "plan",
    status: string | null,
    order: number | null,
    extra: Partial<CardView> = {}
  ): CardView => ({
    id: path,
    title: path,
    status,
    priority: null,
    order,
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
  });

  function mergedWith(cards: CardView[]) {
    return {
      columns: [{ column: { id: "col1", name: "To Do", position: 0 }, planCards: cards }],
      autoColumns: [],
    };
  }

  it("nest: writes parent, removes status, then orders among the children", async () => {
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    seed([planInfo("/p/t.md", "To Do", null)]);
    const child = view("/p/c1.md", "task", null, 1024, { parent: "plan.md" });
    const plan = view("/p/plan.md", "plan", "To Do", null, { nestedChildren: [child] });
    const task = view("/p/t.md", "task", "To Do", null);
    const err = await planCommitFromMerged(
      "ws",
      { id: "/p/t.md", sourceColumnId: "col1", target: { columnId: "col1", index: 1, nest: "/p/plan.md" } },
      [{ id: "col1", name: "To Do", position: 0 }],
      mergedWith([plan, task])
    );
    expect(err).toBeNull();
    expect(vi.mocked(backend.setPlanFrontmatterField).mock.calls).toEqual([
      ["/p/t.md", "parent", "plan.md"],
      ["/p/t.md", "status", ""],
      ["/p/t.md", "order", "2048"],
    ]);
  });

  it("nest: an unchanged parent skips the parent write", async () => {
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    seed([planInfo("/p/t.md", null, null)]);
    const child = view("/p/t.md", "task", null, 1024, { parent: "plan.md" });
    const other = view("/p/c2.md", "task", null, 2048, { parent: "plan.md" });
    const plan = view("/p/plan.md", "plan", "To Do", null, { nestedChildren: [child, other] });
    const err = await planCommitFromMerged(
      "ws",
      { id: "/p/t.md", sourceColumnId: "col1", target: { columnId: "col1", index: 1, nest: "/p/plan.md" } },
      [{ id: "col1", name: "To Do", position: 0 }],
      mergedWith([plan])
    );
    expect(err).toBeNull();
    // Only the order write: parent unchanged, status already absent.
    expect(vi.mocked(backend.setPlanFrontmatterField).mock.calls).toEqual([["/p/t.md", "order", "3072"]]);
  });

  it("freeing a nested child into its parent's own column writes the status", async () => {
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    seed([planInfo("/p/t.md", null, null)]);
    const child = view("/p/t.md", "task", null, null, { parent: "plan.md" });
    const plan = view("/p/plan.md", "plan", "To Do", 1024, { nestedChildren: [child] });
    const err = await planCommitFromMerged(
      "ws",
      { id: "/p/t.md", sourceColumnId: "col1", target: { columnId: "col1", index: 1 } },
      [{ id: "col1", name: "To Do", position: 0 }],
      mergedWith([plan])
    );
    expect(err).toBeNull();
    expect(vi.mocked(backend.setPlanFrontmatterField).mock.calls).toEqual([
      ["/p/t.md", "status", "To Do"],
      ["/p/t.md", "order", "2048"],
    ]);
  });

  it("guards: only tasks nest, only into same-context plans, with no writes", async () => {
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    const note = view("/p/n.md", "note", "To Do", null);
    const plan = view("/p/plan.md", "plan", "To Do", null);
    const otherCtx = view("/q/plan.md", "plan", "To Do", null, { contextFolder: "/q" });
    const task = view("/p/t.md", "task", "To Do", null);
    for (const [draggedId, cards] of [
      ["/p/n.md", [note, plan]],
      ["/p/t.md", [task, otherCtx]],
    ] as const) {
      const err = await planCommitFromMerged(
        "ws",
        { id: draggedId, sourceColumnId: "col1", target: { columnId: "col1", index: 0, nest: cards[1].id } },
        [{ id: "col1", name: "To Do", position: 0 }],
        mergedWith([...cards])
      );
      expect(err).toContain("Only a task can nest");
    }
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
    expect(get(dropHold)).toBeNull();
  });
});

describe("placeCardAtColumnEnd", () => {
  function view(path: string, status: string, order: number | null): CardView {
    return {
      id: path,
      title: path,
      status,
      priority: null,
      order,
      kind: "task",
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
    };
  }
  function todo(cards: CardView[]) {
    return {
      columns: [{ column: { id: "col1", name: "To Do", position: 0 }, planCards: cards }],
      autoColumns: [],
    };
  }

  it("writes one order past the column's last card", async () => {
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    seed([planInfo("/p/a.md", "To Do", 1024), planInfo("/p/new.md", "To Do", null)]);
    const err = await placeCardAtColumnEnd(
      "ws",
      "/p/new.md",
      "To Do",
      todo([view("/p/a.md", "To Do", 1024), view("/p/new.md", "To Do", null)])
    );
    expect(err).toBeNull();
    expect(vi.mocked(backend.setPlanFrontmatterField).mock.calls).toEqual([["/p/new.md", "order", "2048"]]);
    expect(planByPath("/p/new.md")?.order).toBe(2048);
  });

  // The board's sort key puts unordered cards in an alphabetical tail,
  // so "last" is unreachable until the block has real orders -- which is
  // exactly what a drop at the foot of the column materializes.
  it("materializes an all-unordered column so the new card can be last", async () => {
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    seed([planInfo("/p/b.md", "To Do", null), planInfo("/p/z.md", "To Do", null), planInfo("/p/a.md", "To Do", null)]);
    const err = await placeCardAtColumnEnd(
      "ws",
      "/p/a.md",
      "To Do",
      todo([view("/p/b.md", "To Do", null), view("/p/z.md", "To Do", null), view("/p/a.md", "To Do", null)])
    );
    expect(err).toBeNull();
    expect(vi.mocked(backend.setPlanFrontmatterField).mock.calls).toEqual([
      ["/p/b.md", "order", "1024"],
      ["/p/z.md", "order", "2048"],
      ["/p/a.md", "order", "3072"],
    ]);
  });

  it("is a no-op with no board projection and with a status no column carries", async () => {
    expect(await placeCardAtColumnEnd("ws", "/p/new.md", "To Do", null)).toBeNull();
    expect(await placeCardAtColumnEnd("ws", "/p/new.md", "Shipped", todo([]))).toBeNull();
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
  });

  it("reports a failed write without pretending the card moved", async () => {
    vi.mocked(backend.setPlanFrontmatterField).mockRejectedValue(new Error("disk full"));
    seed([planInfo("/p/a.md", "To Do", 1024), planInfo("/p/new.md", "To Do", null)]);
    const err = await placeCardAtColumnEnd(
      "ws",
      "/p/new.md",
      "To Do",
      todo([view("/p/a.md", "To Do", 1024), view("/p/new.md", "To Do", null)])
    );
    expect(err).toContain("new.md");
    expect(err).toContain("disk full");
    expect(planByPath("/p/new.md")?.order).toBeNull();
  });
});
