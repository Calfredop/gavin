import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("$lib/core/backend", () => ({
  // Resolved by default: watchRootedWorkspaces calls .catch() on this, so
  // a bare vi.fn() returning undefined would throw instead of exercising
  // the real best-effort path.
  watchGavinRoot: vi.fn().mockResolvedValue(undefined),
  unwatchGavinRoot: vi.fn().mockResolvedValue(undefined),
  getBoard: vi.fn().mockResolvedValue({ columns: [], labels: [], cardSessions: [] }),
  getGavinTree: vi.fn(),
}));

import { listen } from "@tauri-apps/api/event";
import * as backend from "$lib/core/backend";
import {
  gavinTrees,
  initGavinListeners,
  watchRootedWorkspaces,
  patchPlanField,
  patchPlanPath,
  refreshGavinTree,
  __resetForTesting,
} from "$lib/core/gavinState";
import type { GavinTree } from "$lib/core/gavin";
import type { Workspace } from "$lib/core/workspace";

function ws(id: string, rootPath?: string): Workspace {
  return { id, name: id, pages: [], activePageId: null, rootPath };
}

const tree: GavinTree = { rootPath: "/tmp/ws", rootMissing: false, contexts: [] };

describe("gavinState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTesting();
  });

  it("stores a pushed tree under its workspace id", async () => {
    await initGavinListeners();
    const handler = vi.mocked(listen).mock.calls[0][1] as (e: {
      payload: [string, GavinTree];
    }) => void;
    handler({ payload: ["ws-1", tree] });
    expect(get(gavinTrees)["ws-1"]).toEqual(tree);
  });

  it("re-reads the board on a tree push, for bindings the daemon made itself", async () => {
    // An agent claiming the card it just put In Progress writes a
    // card_sessions row nothing pushes. The card write that earned the
    // claim is what produced this event, so the refetch rides it.
    await initGavinListeners();
    const handler = vi.mocked(listen).mock.calls[0][1] as (e: {
      payload: [string, GavinTree];
    }) => void;
    handler({ payload: ["ws-1", tree] });
    expect(backend.getBoard).toHaveBeenCalledWith("ws-1");
  });

  it("watches only workspaces that have a rootPath", () => {
    watchRootedWorkspaces([ws("ws-1", "/tmp/a"), ws("ws-2"), ws("ws-3", "/tmp/c")]);
    expect(backend.watchGavinRoot).toHaveBeenCalledTimes(2);
    expect(backend.watchGavinRoot).toHaveBeenCalledWith("ws-1", "/tmp/a");
    expect(backend.watchGavinRoot).toHaveBeenCalledWith("ws-3", "/tmp/c");
  });

  it("watches at most once even if both ready paths fire", () => {
    watchRootedWorkspaces([ws("ws-1", "/tmp/a")]);
    watchRootedWorkspaces([ws("ws-1", "/tmp/a")]);
    expect(backend.watchGavinRoot).toHaveBeenCalledTimes(1);
  });

  it("patchPlanField updates only the targeted plan", async () => {
    await initGavinListeners();
    const handler = vi.mocked(listen).mock.calls[0][1] as (e: { payload: [string, GavinTree] }) => void;
    const t: GavinTree = {
      rootPath: "/ws",
      rootMissing: false,
      contexts: [
        {
          folderPath: "/ws",
          kind: "root",
          name: "root",
          plans: [
            { path: "/ws/a.md", fileName: "a.md", title: "a", status: "To Do", priority: null, order: null, kind: "plan" as const, parent: null, labels: [], checklistDone: 0, checklistTotal: 0, parseWarning: false },
            { path: "/ws/b.md", fileName: "b.md", title: "b", status: "To Do", priority: null, order: null, kind: "plan" as const, parent: null, labels: [], checklistDone: 0, checklistTotal: 0, parseWarning: false },
          ],
          docs: [],
          specs: [],
          hasPrd: true,
          configWarning: false,
        },
      ],
    };
    handler({ payload: ["ws-1", t] });
    patchPlanField("ws-1", "/ws/a.md", "status", "Done");
    patchPlanField("ws-1", "/ws/b.md", "priority", "HIGH");
    const after = get(gavinTrees)["ws-1"].contexts[0].plans;
    expect(after[0].status).toBe("Done");
    expect(after[0].priority).toBeNull();
    expect(after[1].status).toBe("To Do");
    expect(after[1].priority).toBe("high");
  });

  it("patchPlanField updates title", async () => {
    await initGavinListeners();
    const handler = vi.mocked(listen).mock.calls[0][1] as (e: { payload: [string, GavinTree] }) => void;
    handler({
      payload: [
        "ws-1",
        {
          rootPath: "/ws",
          rootMissing: false,
          contexts: [
            {
              folderPath: "/ws",
              kind: "root",
              name: "root",
              plans: [
                { path: "/ws/a.md", fileName: "a.md", title: "Old", status: "To Do", priority: null, order: null, kind: "plan" as const, parent: null, labels: [], checklistDone: 0, checklistTotal: 0, parseWarning: false },
              ],
              docs: [],
              specs: [],
              hasPrd: true,
              configWarning: false,
            },
          ],
        },
      ],
    });
    patchPlanField("ws-1", "/ws/a.md", "title", "New");
    expect(get(gavinTrees)["ws-1"].contexts[0].plans[0].title).toBe("New");
  });

  it("patchPlanField order stores a number and ignores garbage", async () => {
    await initGavinListeners();
    const handler = vi.mocked(listen).mock.calls[0][1] as (e: { payload: [string, GavinTree] }) => void;
    const t: GavinTree = {
      rootPath: "/ws",
      rootMissing: false,
      contexts: [
        {
          folderPath: "/ws",
          kind: "root",
          name: "root",
          plans: [
            { path: "/ws/a.md", fileName: "a.md", title: "a", status: "To Do", priority: null, order: null, kind: "plan" as const, parent: null, labels: [], checklistDone: 0, checklistTotal: 0, parseWarning: false },
          ],
          docs: [],
          specs: [],
          hasPrd: true,
          configWarning: false,
        },
      ],
    };
    handler({ payload: ["ws-1", t] });
    patchPlanField("ws-1", "/ws/a.md", "order", "2048");
    expect(get(gavinTrees)["ws-1"].contexts[0].plans[0].order).toBe(2048);
    patchPlanField("ws-1", "/ws/a.md", "order", "soon");
    expect(get(gavinTrees)["ws-1"].contexts[0].plans[0].order).toBe(2048);
  });
  it("patchPlanPath re-identifies a plan the daemon archived under its new path", async () => {
    await initGavinListeners();
    const handler = vi.mocked(listen).mock.calls[0][1] as (e: { payload: [string, GavinTree] }) => void;
    const t: GavinTree = {
      rootPath: "/ws",
      rootMissing: false,
      contexts: [
        {
          folderPath: "/ws",
          kind: "root",
          name: "root",
          plans: [
            { path: "/ws/a.md", fileName: "a.md", title: "a", status: "To Do", priority: null, order: null, kind: "plan" as const, parent: null, labels: [], checklistDone: 0, checklistTotal: 0, parseWarning: false },
            { path: "/ws/b.md", fileName: "b.md", title: "b", status: "To Do", priority: null, order: null, kind: "plan" as const, parent: null, labels: [], checklistDone: 0, checklistTotal: 0, parseWarning: false },
          ],
          docs: [],
          specs: [],
          hasPrd: true,
          configWarning: false,
        },
      ],
    };
    handler({ payload: ["ws-1", t] });
    patchPlanPath("ws-1", "/ws/a.md", "/ws/done/a.md");
    const after = get(gavinTrees)["ws-1"].contexts[0].plans;
    expect(after[0].path).toBe("/ws/done/a.md");
    expect(after[0].title).toBe("a");
    expect(after[1].path).toBe("/ws/b.md");
  });

  it("patchPlanPath leaves the tree alone for a path it doesn't hold", async () => {
    await initGavinListeners();
    const handler = vi.mocked(listen).mock.calls[0][1] as (e: { payload: [string, GavinTree] }) => void;
    const t: GavinTree = {
      rootPath: "/ws",
      rootMissing: false,
      contexts: [
        {
          folderPath: "/ws",
          kind: "root",
          name: "root",
          plans: [{ path: "/ws/a.md", fileName: "a.md", title: "a", status: "To Do", priority: null, order: null, kind: "plan" as const, parent: null, labels: [], checklistDone: 0, checklistTotal: 0, parseWarning: false }],
          docs: [],
          specs: [],
          hasPrd: true,
          configWarning: false,
        },
      ],
    };
    handler({ payload: ["ws-1", t] });
    const before = get(gavinTrees)["ws-1"];
    patchPlanPath("ws-1", "/ws/nope.md", "/ws/done/nope.md");
    expect(get(gavinTrees)["ws-1"]).toEqual(before);
  });
});

// The tree read is answered off the main thread, behind whatever else the
// daemon's reads lane is doing -- so it can land after the watcher's newer
// push, or after a later refresh's answer.
describe("refreshGavinTree", () => {
  const older: GavinTree = { rootPath: "/older", rootMissing: false, contexts: [] };
  const newer: GavinTree = { rootPath: "/newer", rootMissing: false, contexts: [] };

  function deferredTree(): (t: GavinTree) => void {
    let answer!: (t: GavinTree) => void;
    vi.mocked(backend.getGavinTree).mockImplementationOnce(() => new Promise((r) => (answer = r)));
    return (t) => answer(t);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTesting();
  });

  it("applies its answer when nothing newer arrived", async () => {
    vi.mocked(backend.getGavinTree).mockResolvedValueOnce(newer);
    await refreshGavinTree("ws-1");
    expect(get(gavinTrees)["ws-1"]).toEqual(newer);
  });

  it("does not put an older tree back over a push that landed while it waited", async () => {
    await initGavinListeners();
    const push = vi.mocked(listen).mock.calls[0][1] as (e: { payload: [string, GavinTree] }) => void;
    const answer = deferredTree();
    const refreshing = refreshGavinTree("ws-1");
    push({ payload: ["ws-1", newer] });
    answer(older);
    await refreshing;
    expect(get(gavinTrees)["ws-1"]).toEqual(newer);
  });

  it("drops an earlier refresh whose answer arrives after a later one's", async () => {
    const first = deferredTree();
    const firstDone = refreshGavinTree("ws-1");
    const second = deferredTree();
    const secondDone = refreshGavinTree("ws-1");
    second(newer);
    await secondDone;
    first(older);
    await firstDone;
    expect(get(gavinTrees)["ws-1"]).toEqual(newer);
  });

  it("keeps each workspace's refresh to itself", async () => {
    const one = deferredTree();
    const oneDone = refreshGavinTree("ws-1");
    vi.mocked(backend.getGavinTree).mockResolvedValueOnce(newer);
    await refreshGavinTree("ws-2");
    one(older);
    await oneDone;
    expect(get(gavinTrees)["ws-1"]).toEqual(older);
    expect(get(gavinTrees)["ws-2"]).toEqual(newer);
  });
});
