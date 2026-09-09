import { describe, it, expect, vi, beforeEach } from "vitest";
import { writable } from "svelte/store";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("$lib/dialog", () => ({
  askConfirm: vi.fn().mockResolvedValue(true),
}));
vi.mock("$lib/backend", () => ({
  archiveCard: vi.fn(),
  unarchiveCard: vi.fn(),
  getBoard: vi.fn().mockResolvedValue({ columns: [], labels: [], cardSessions: [] }),
}));
vi.mock("$lib/layoutState", () => ({
  layoutState: writable({
    workspaces: [
      {
        id: "ws",
        name: "ws",
        pages: [
          {
            id: "pg-1",
            name: "Agents",
            layout: { type: "leaf", tabs: ["s-live", "s-live-2", "tab-file"], activeTabIndex: 0 },
          },
        ],
        activePageId: "pg-1",
      },
    ],
    activeWorkspaceId: "ws",
    fileTabsById: {},
    cardTabsById: {},
  }),
  closeSession: vi.fn().mockResolvedValue(undefined),
}));

import { get } from "svelte/store";
import { askConfirm } from "$lib/dialog";
import * as backend from "$lib/backend";
import { layoutState, closeSession } from "$lib/layoutState";
import { ARCHIVE_CANCELLED, executeArchive, executeUnarchive, isDoneColumn } from "$lib/files/archiveActions";
import { kanbanState } from "$lib/board/kanbanState";
import { gavinTrees } from "$lib/gavinState";
import type { CardView } from "$lib/planBoard";
import type { PlanFileInfo } from "$lib/gavin";

const PLANS = "/ws/.gavin-root/plans";

function view(fileName: string, extra: Partial<CardView> = {}): CardView {
  return {
    id: `${PLANS}/${fileName}`,
    title: fileName,
    status: "Done",
    priority: null,
    order: null,
    kind: "plan",
    parent: null,
    parentTitle: null,
    parentBroken: false,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    contextName: "root",
    contextFolder: "/ws",
    fileName,
    parseWarning: false,
    nestedChildren: [],
    ...extra,
  };
}

function plan(path: string, fileName: string): PlanFileInfo {
  return {
    path,
    fileName,
    title: fileName,
    status: "Done",
    priority: null,
    order: null,
    kind: "plan",
    parent: null,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
  };
}

function seedTree(paths: Array<[string, string]>): void {
  gavinTrees.set({
    ws: {
      rootPath: "/ws",
      rootMissing: false,
      contexts: [
        {
          folderPath: "/ws",
          kind: "root",
          name: "root",
          plans: paths.map(([path, file]) => plan(path, file)),
          docs: [],
          specs: [],
          hasPrd: false,
          configWarning: false,
        },
      ],
    },
  });
}

function pathsInTree(): string[] {
  const trees = get(gavinTrees);
  return trees.ws.contexts[0].plans.map((p) => p.path);
}

describe("isDoneColumn", () => {
  it("matches Done by slug, and nothing else", () => {
    expect(isDoneColumn("Done")).toBe(true);
    expect(isDoneColumn("done")).toBe(true);
    expect(isDoneColumn("  DONE  ")).toBe(true);
    expect(isDoneColumn("Shipped")).toBe(false);
    expect(isDoneColumn("Not Done")).toBe(false);
  });
});

describe("executeArchive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gavinTrees.set({});
  });

  it("archives each card and re-points its path in the tree", async () => {
    seedTree([
      [`${PLANS}/a.md`, "a.md"],
      [`${PLANS}/b.md`, "b.md"],
    ]);
    vi.mocked(backend.archiveCard).mockImplementation(async (path: string) =>
      path.replace("/plans/", "/plans/archive/")
    );

    const err = await executeArchive("ws", [view("a.md"), view("b.md")]);

    expect(err).toBeNull();
    expect(backend.archiveCard).toHaveBeenCalledTimes(2);
    expect(pathsInTree()).toEqual([`${PLANS}/archive/a.md`, `${PLANS}/archive/b.md`]);
  });

  it("drags a plan's nested children onto the new folder too", async () => {
    // The daemon moved them; nothing tells the app their paths, so the
    // action derives them from where the parent actually landed.
    seedTree([
      [`${PLANS}/big.md`, "big.md"],
      [`${PLANS}/step.md`, "step.md"],
    ]);
    vi.mocked(backend.archiveCard).mockResolvedValue(`${PLANS}/archive/big.md`);

    await executeArchive("ws", [
      view("big.md", { nestedChildren: [view("step.md", { kind: "task", status: null })] }),
    ]);

    expect(pathsInTree()).toEqual([`${PLANS}/archive/big.md`, `${PLANS}/archive/step.md`]);
  });

  it("follows where the card ACTUALLY landed, not where we asked", async () => {
    // A taken destination name leaves the card put; the tree must not
    // start claiming a path that names no file.
    seedTree([[`${PLANS}/a.md`, "a.md"]]);
    vi.mocked(backend.archiveCard).mockResolvedValue(`${PLANS}/a.md`);

    await executeArchive("ws", [view("a.md")]);

    expect(pathsInTree()).toEqual([`${PLANS}/a.md`]);
  });

  it("stops at the first failure and names the file", async () => {
    seedTree([
      [`${PLANS}/a.md`, "a.md"],
      [`${PLANS}/b.md`, "b.md"],
    ]);
    vi.mocked(backend.archiveCard)
      .mockResolvedValueOnce(`${PLANS}/archive/a.md`)
      .mockRejectedValueOnce(new Error("disk is full"));

    const err = await executeArchive("ws", [view("a.md"), view("b.md")]);

    expect(err).toBe("Couldn't archive b.md: disk is full");
    // The one that DID land is still re-pointed -- the write happened.
    expect(pathsInTree()).toEqual([`${PLANS}/archive/a.md`, `${PLANS}/b.md`]);
  });

  it("an empty list is a no-op, not a failure", async () => {
    expect(await executeArchive("ws", [])).toBeNull();
    expect(backend.archiveCard).not.toHaveBeenCalled();
  });
});

describe("executeArchive — closing what the card was using", () => {
  function bind(path: string, sessionId: string): void {
    kanbanState.set({
      ws: {
        columns: [],
        labels: [],
        cardSessions: [{ path, sessionId, cwd: "/ws", command: "claude" }],
      },
    });
  }

  function openFileTab(tabId: string, path: string): void {
    layoutState.update((st) => ({ ...st, fileTabsById: { ...st.fileTabsById, [tabId]: { path } } }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(askConfirm).mockResolvedValue(true);
    gavinTrees.set({});
    kanbanState.set({});
    layoutState.update((st) => ({ ...st, fileTabsById: {} }));
  });

  it("asks once for the batch, then ends the live session and closes the file tab", async () => {
    seedTree([[`${PLANS}/a.md`, "a.md"]]);
    bind(`${PLANS}/a.md`, "s-live");
    openFileTab("tab-file", `${PLANS}/a.md`);
    vi.mocked(backend.archiveCard).mockResolvedValue(`${PLANS}/archive/a.md`);

    const err = await executeArchive("ws", [view("a.md")]);

    expect(err).toBeNull();
    expect(askConfirm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(askConfirm).mock.calls[0][0]).toMatchObject({
      title: "Archive this card?",
      lines: ["1 running agent session will end."],
      confirmLabel: "Archive card",
      danger: true,
    });
    expect(vi.mocked(closeSession).mock.calls.map((c) => c[0])).toEqual(["s-live", "tab-file"]);
  });

  it("cancelling archives nothing and closes nothing", async () => {
    seedTree([[`${PLANS}/a.md`, "a.md"]]);
    bind(`${PLANS}/a.md`, "s-live");
    vi.mocked(askConfirm).mockResolvedValue(false);

    const err = await executeArchive("ws", [view("a.md")]);

    // Distinguishable from success, but still falsy: an `if (err)` call
    // site reports nothing, and the card detail modal stays open.
    expect(err).toBe(ARCHIVE_CANCELLED);
    expect(err).not.toBeNull();
    expect(err).toBeFalsy();
    expect(backend.archiveCard).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
    expect(pathsInTree()).toEqual([`${PLANS}/a.md`]);
  });

  it("a file tab alone closes silently -- it ends no process", async () => {
    seedTree([[`${PLANS}/a.md`, "a.md"]]);
    openFileTab("tab-file", `${PLANS}/a.md`);
    vi.mocked(backend.archiveCard).mockResolvedValue(`${PLANS}/archive/a.md`);

    await executeArchive("ws", [view("a.md")]);

    expect(askConfirm).not.toHaveBeenCalled();
    expect(vi.mocked(closeSession).mock.calls.map((c) => c[0])).toEqual(["tab-file"]);
  });

  it("a binding whose session already exited is a memory, not a close", async () => {
    seedTree([[`${PLANS}/a.md`, "a.md"]]);
    bind(`${PLANS}/a.md`, "s-gone");
    vi.mocked(backend.archiveCard).mockResolvedValue(`${PLANS}/archive/a.md`);

    await executeArchive("ws", [view("a.md")]);

    expect(askConfirm).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("a card that never moved keeps its session", async () => {
    seedTree([
      [`${PLANS}/a.md`, "a.md"],
      [`${PLANS}/b.md`, "b.md"],
    ]);
    kanbanState.set({
      ws: {
        columns: [],
        labels: [],
        cardSessions: [
          { path: `${PLANS}/a.md`, sessionId: "s-live", cwd: "/ws", command: null },
          { path: `${PLANS}/b.md`, sessionId: "s-live-2", cwd: "/ws", command: null },
        ],
      },
    });
    vi.mocked(backend.archiveCard)
      .mockResolvedValueOnce(`${PLANS}/archive/a.md`)
      .mockRejectedValueOnce(new Error("disk is full"));

    const err = await executeArchive("ws", [view("a.md"), view("b.md")]);

    expect(err).toBe("Couldn't archive b.md: disk is full");
    // b.md's session outlives the failed move; only a.md's was ended.
    expect(vi.mocked(closeSession).mock.calls.map((c) => c[0])).toEqual(["s-live"]);
  });

  it("restoring a card closes nothing -- it is not a launch", async () => {
    seedTree([[`${PLANS}/archive/a.md`, "a.md"]]);
    bind(`${PLANS}/archive/a.md`, "s-live");
    vi.mocked(backend.unarchiveCard).mockResolvedValue(`${PLANS}/done/a.md`);

    await executeUnarchive("ws", [view("a.md", { id: `${PLANS}/archive/a.md` })]);

    expect(askConfirm).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
  });
});

describe("executeUnarchive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gavinTrees.set({});
  });

  it("files the card back where its status put it", async () => {
    seedTree([[`${PLANS}/archive/a.md`, "a.md"]]);
    vi.mocked(backend.unarchiveCard).mockResolvedValue(`${PLANS}/done/a.md`);

    const err = await executeUnarchive("ws", [
      view("a.md", { id: `${PLANS}/archive/a.md` }),
    ]);

    expect(err).toBeNull();
    expect(pathsInTree()).toEqual([`${PLANS}/done/a.md`]);
  });

  it("names the file when the restore fails", async () => {
    seedTree([[`${PLANS}/archive/a.md`, "a.md"]]);
    vi.mocked(backend.unarchiveCard).mockRejectedValue(new Error("nope"));

    expect(
      await executeUnarchive("ws", [view("a.md", { id: `${PLANS}/archive/a.md` })])
    ).toBe("Couldn't restore a.md: nope");
  });
});
