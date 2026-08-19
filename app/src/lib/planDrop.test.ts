import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("./backend", () => ({
  setPlanFrontmatterField: vi.fn(),
}));

import * as backend from "./backend";
import { gavinTrees } from "./gavinState";
import { applyPlanDrop } from "./planDrop";
import type { GavinTree, PlanFileInfo } from "./gavin";

function planInfo(path: string, status: string | null, order: number | null): PlanFileInfo {
  const fileName = path.split("/").at(-1) ?? path;
  return { path, fileName, title: fileName, status, priority: null, order, parseWarning: false };
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
});

describe("applyPlanDrop", () => {
  it("cross-column: writes status first, then order writes, patching each on success", async () => {
    vi.mocked(backend.setPlanFrontmatterField).mockResolvedValue(undefined);
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
    vi.mocked(backend.setPlanFrontmatterField).mockResolvedValue(undefined);
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
      .mockResolvedValueOnce(undefined)
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
