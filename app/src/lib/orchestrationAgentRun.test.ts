// The EFFECT half of the Orchestration tab's agent requests: Organize and
// a rail's Reorganize each spawn a dedicated session, record it in the
// workspace's one slot, and release that slot when the run is over. The
// decisions themselves are orchestrationAgent.test.ts's.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { get, writable, type Writable } from "svelte/store";

vi.mock("$lib/backend", () => ({
  createSession: vi.fn(),
  getOrchestration: vi.fn(),
  setOrchestration: vi.fn(),
  setRailRun: vi.fn(),
  setStepRun: vi.fn(),
  readFileForViewer: vi.fn(),
  setPlanFrontmatterField: vi.fn(),
  setSessionName: vi.fn(),
  getTools: vi.fn(),
  saveTool: vi.fn(),
  deleteTool: vi.fn(),
  gitStatus: vi.fn(),
  gitCheckout: vi.fn(),
  attachmentStatus: vi.fn(),
}));

// A REAL store: the slot lives on the workspace record, `sessionLiveness`
// walks the page trees out of it, and the sweep subscribes to it. Mocking
// `setOrchestrationAgent` to write back into it is what closes that loop
// -- without the write-back the sweep would have nothing to clear and the
// second-press refusal nothing to read.
type LayoutValue = {
  workspaces: Array<Record<string, unknown>>;
  activeWorkspaceId: string | null;
  sessionStatusById: Record<string, string>;
  interruptedSessionIds: Set<string>;
};
// Hand-rolled rather than svelte's `writable`: a `vi.mock` factory is
// hoisted above every import in this file, so anything it closes over has
// to be built without one.
const layoutStore = vi.hoisted(() => {
  let value: unknown = null;
  const subs = new Set<(v: unknown) => void>();
  const store = {
    subscribe(fn: (v: unknown) => void) {
      subs.add(fn);
      fn(value);
      return () => subs.delete(fn);
    },
    set(next: unknown) {
      value = next;
      for (const fn of subs) fn(value);
    },
    update(fn: (v: LayoutValue) => LayoutValue) {
      store.set(fn(value as LayoutValue));
    },
  };
  return store;
});
vi.mock("$lib/layoutState", () => ({
  layoutState: layoutStore,
  resolvedAgentFor: vi.fn(() => ({
    command: "claude",
    launchCommand: "claude",
    file: "CLAUDE.md",
    profile: "claude-code",
  })),
  createSessionOnPage: vi.fn(),
  createPage: vi.fn().mockResolvedValue(null),
  workspaceRootPath: vi.fn(() => "/ws"),
  handleAgentSessionSpawned: vi.fn(),
  setSessionName: vi.fn().mockResolvedValue(undefined),
  setOrchestrationAgent: vi.fn(async (workspaceId: string, record: unknown) => {
    layoutStore.update((s) => ({
      ...s,
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, orchestrationAgent: record ?? undefined } : w
      ),
    }));
  }),
  sessionExits: { subscribe: (fn: (v: unknown) => void) => (fn(new Map()), () => {}) },
}));
vi.mock("$lib/cardRunActions", () => ({
  resolveAttachmentsForRun: vi.fn(async () => ({ paths: [] })),
  revealSession: vi.fn(async () => true),
}));
vi.mock("$lib/board/kanbanState", () => ({
  kanbanState: writable<Record<string, unknown>>({}),
  linkCardSessionAction: vi.fn(),
}));
vi.mock("$lib/gavinState", () => ({
  gavinTrees: writable<Record<string, unknown>>({}),
  patchPlanField: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
}));
vi.mock("$lib/gitState", () => ({
  gitStore: writable<Record<string, unknown>>({}),
  ensureGitView: vi.fn(),
  refresh: vi.fn(),
}));

import * as backend from "$lib/backend";
import * as layoutStateModule from "$lib/layoutState";
import * as cardRunActions from "$lib/cardRunActions";
import {
  orchestrations,
  requestOrganize,
  requestRailReorganize,
  revealOrchestrationAgent,
  startOrchestrationAgentWatch,
  __resetForTesting,
} from "$lib/orchestrationState";
import { emptyOrchestration } from "$lib/orchestration";
import type { Rail } from "$lib/orchestration";

const store = layoutStore as unknown as Writable<LayoutValue>;

/// A workspace with the run's session sitting on a page, which is what
/// `sessionLiveness` reads -- a record naming a session no page holds is
/// a finished run, so the tests that need one still going have to put it
/// somewhere findable.
function workspace(over: Record<string, unknown> = {}, sessionIds: string[] = []): Record<string, unknown> {
  return {
    id: "ws-1",
    name: "ws",
    rootPath: "/ws",
    activePageId: "p1",
    pages: [
      {
        id: "p1",
        name: "Agents",
        layout: { type: "leaf", tabs: sessionIds, activeTabIndex: 0 },
        focusedSessionId: null,
      },
    ],
    ...over,
  };
}

function rail(id: string, name: string): Rail {
  return { id, name, position: 0, worktreePath: null, pageId: null, stages: [] };
}

let stopWatch: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  __resetForTesting();
  stopWatch?.();
  stopWatch = null;
  store.set({
    workspaces: [workspace()],
    activeWorkspaceId: "ws-1",
    sessionStatusById: {},
    interruptedSessionIds: new Set(),
  });
  orchestrations.set({ "ws-1": { ...emptyOrchestration(), rails: [rail("r1", "backend")] } });
  vi.mocked(backend.createSession).mockResolvedValue("sess-1");
});

function slot(): Record<string, unknown> | undefined {
  return get(store).workspaces[0].orchestrationAgent as Record<string, unknown> | undefined;
}

describe("requestOrganize", () => {
  it("spawns its own agent in the workspace root and lands the human in it", async () => {
    expect(await requestOrganize("ws-1", [], [])).toBeNull();

    const [cwd, command] = vi.mocked(backend.createSession).mock.calls[0];
    expect(cwd).toBe("/ws");
    expect(command).toContain("claude ");
    expect(command).toContain("gavin-orchestrate");
    expect(vi.mocked(layoutStateModule.handleAgentSessionSpawned)).toHaveBeenCalledWith("ws-1", "sess-1");
    expect(vi.mocked(cardRunActions.revealSession)).toHaveBeenCalledWith("sess-1");
    expect(vi.mocked(layoutStateModule.setSessionName)).toHaveBeenCalledWith("sess-1", "Organize");
  });

  it("does not need the workspace's main agent to be running", async () => {
    // The workspace built above has no mainSessionId at all: the old
    // paste-only Organize refused outright here.
    expect(await requestOrganize("ws-1", [], [])).toBeNull();
  });

  it("records the run so a later window can tell one is going", async () => {
    await requestOrganize("ws-1", [], []);
    expect(slot()).toEqual({ sessionId: "sess-1", railId: null, label: "Organize" });
  });

  it("refuses a second run while the first is going, and says which", async () => {
    await requestOrganize("ws-1", [], []);
    vi.mocked(backend.createSession).mockClear();

    const error = await requestOrganize("ws-1", [], []);
    expect(error).toContain("Organize is already running");
    expect(vi.mocked(backend.createSession)).not.toHaveBeenCalled();
  });

  it("refuses without a root folder to start the agent in", async () => {
    store.update((s) => ({ ...s, workspaces: [workspace({ rootPath: null })] }));
    expect(await requestOrganize("ws-1", [], [])).toContain("no root folder");
    expect(vi.mocked(backend.createSession)).not.toHaveBeenCalled();
  });

  it("records nothing when the spawn itself fails", async () => {
    vi.mocked(backend.createSession).mockRejectedValue(new Error("no pty"));
    expect(await requestOrganize("ws-1", [], [])).toContain("no pty");
    expect(slot()).toBeUndefined();
  });
});

describe("requestRailReorganize", () => {
  it("records the rail it is about, under the name the human reads", async () => {
    expect(await requestRailReorganize("ws-1", "r1", new Map(), [], [])).toBeNull();
    expect(slot()).toEqual({
      sessionId: "sess-1",
      railId: "r1",
      label: "Reorganize “backend”",
    });
  });

  it("holds the SAME slot Organize holds", async () => {
    // Both requests rewrite the whole plan, so the second one to finish
    // would silently undo the first.
    await requestRailReorganize("ws-1", "r1", new Map(), [], []);
    expect(await requestOrganize("ws-1", [], [])).toContain("Reorganize “backend” is already running");
  });

  it("is refused for a rail that is gone, before anything is spawned", async () => {
    expect(await requestRailReorganize("ws-1", "r-gone", new Map(), [], [])).toBe("That rail is gone");
    expect(vi.mocked(backend.createSession)).not.toHaveBeenCalled();
  });
});

describe("revealOrchestrationAgent", () => {
  it("puts the human in front of the run holding the slot", async () => {
    await requestOrganize("ws-1", [], []);
    vi.mocked(cardRunActions.revealSession).mockClear();

    await revealOrchestrationAgent("ws-1");
    expect(vi.mocked(cardRunActions.revealSession)).toHaveBeenCalledWith("sess-1");
  });

  it("does nothing at all with an empty slot", async () => {
    await revealOrchestrationAgent("ws-1");
    expect(vi.mocked(cardRunActions.revealSession)).not.toHaveBeenCalled();
  });
});

describe("the slot sweep", () => {
  /// The record as a window that did NOT start the run finds it: loaded
  /// from config.json, with the session wherever the layout put it.
  function adopted(over: { sessions?: string[]; status?: string; interrupted?: boolean } = {}): void {
    store.set({
      workspaces: [
        workspace(
          { orchestrationAgent: { sessionId: "sess-1", railId: null, label: "Organize" } },
          over.sessions ?? ["sess-1"]
        ),
      ],
      activeWorkspaceId: "ws-1",
      sessionStatusById: over.status ? { "sess-1": over.status } : {},
      interruptedSessionIds: new Set(over.interrupted ? ["sess-1"] : []),
    });
  }

  async function sweep(): Promise<void> {
    stopWatch = startOrchestrationAgentWatch();
    await Promise.resolve();
    await Promise.resolve();
  }

  it("keeps a run whose agent is still working", async () => {
    adopted({ status: "working" });
    await sweep();
    expect(slot()).toBeDefined();
  });

  it("keeps a run the daemon has said nothing about yet", async () => {
    // The launch race: a new session is idle inside the daemon and only
    // reported on a CHANGE, so an absent status must not end the run in
    // the tick it started.
    adopted();
    await sweep();
    expect(slot()).toBeDefined();
  });

  it("frees the slot once the agent stops talking", async () => {
    adopted({ status: "idle" });
    await sweep();
    expect(slot()).toBeUndefined();
  });

  it("frees the slot when the session is gone from the layout", async () => {
    adopted({ sessions: [], status: "working" });
    await sweep();
    expect(slot()).toBeUndefined();
  });

  it("frees the slot when a daemon restart left a bare shell in its place", async () => {
    adopted({ status: "working", interrupted: true });
    await sweep();
    expect(slot()).toBeUndefined();
  });

  it("re-checks on every layout change, not only at startup", async () => {
    // The baselines that carry status and interruption land AFTER
    // bootstrap, so the first pass can legitimately read a dead run as
    // live. A one-shot adoption would leave the button locked forever.
    adopted({ status: "working" });
    await sweep();
    expect(slot()).toBeDefined();

    store.update((s) => ({ ...s, sessionStatusById: { "sess-1": "idle" } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(slot()).toBeUndefined();
  });

  it("frees the slot a launch just filled once that run ends", async () => {
    await sweep();
    store.update((s) => ({ ...s, workspaces: [workspace({}, ["sess-1"])] }));
    await requestOrganize("ws-1", [], []);
    expect(slot()).toBeDefined();

    store.update((s) => ({ ...s, sessionStatusById: { "sess-1": "idle" } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(slot()).toBeUndefined();
  });
});
