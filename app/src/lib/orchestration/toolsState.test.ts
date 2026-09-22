import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("$lib/core/backend", () => ({
  getTools: vi.fn(),
  saveTool: vi.fn(),
  deleteTool: vi.fn(),
}));

/// The push side, held by name so a test can fire what the daemon would.
const tauriEvents = { handlers: new Map<string, (event: { payload: unknown }) => void>() };
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    tauriEvents.handlers.set(name, handler);
    return () => tauriEvents.handlers.delete(name);
  },
}));

import * as backend from "$lib/core/backend";
import {
  toolRecords,
  libraryFor,
  renderLibraryFor,
  fetchTools,
  refreshTools,
  saveToolAction,
  deleteToolAction,
  initToolListeners,
  __resetForTesting,
} from "$lib/orchestration/toolsState";
import { BUILTIN_TOOLS, emptyTool, type Tool, type ToolRecord } from "$lib/orchestration/orchestrationTools";

function record(over: Partial<ToolRecord> = {}): ToolRecord {
  return {
    id: "u1",
    workspaceId: "ws-1",
    name: "Deploy",
    description: "",
    kind: "command",
    body: "./deploy.sh",
    params: [],
    position: 0,
    icon: null,
    cwd: null,
    ...over,
  };
}

beforeEach(() => {
  __resetForTesting();
  vi.clearAllMocks();
});

// The distinction the whole scheduler rests on: an unloaded library must
// not look like a library with nothing in it, or every tool step would
// stall on a cold start.
describe("libraryFor — loading is not empty", () => {
  it("is null before the fetch has landed", () => {
    expect(libraryFor({}, "ws-1")).toBeNull();
    expect(libraryFor({ "ws-1": null }, "ws-1")).toBeNull();
  });

  it("is the built-ins once an EMPTY result has landed", () => {
    expect(libraryFor({ "ws-1": [] }, "ws-1")).toHaveLength(BUILTIN_TOOLS.length);
  });

  it("adds the stored rows", () => {
    expect(libraryFor({ "ws-1": [record()] }, "ws-1")).toHaveLength(BUILTIN_TOOLS.length + 1);
  });

  // Rendering can't wait, and showing the ten tools we ship beats
  // showing an empty panel.
  it("renderLibraryFor falls back to the built-ins while loading", () => {
    expect(renderLibraryFor({}, "ws-1")).toHaveLength(BUILTIN_TOOLS.length);
  });
});

describe("fetchTools", () => {
  it("fetches once and caches", async () => {
    vi.mocked(backend.getTools).mockResolvedValue([record()]);
    await fetchTools("ws-1");
    await fetchTools("ws-1");
    expect(backend.getTools).toHaveBeenCalledTimes(1);
    expect(get(toolRecords)["ws-1"]).toHaveLength(1);
  });

  // A failed fetch must leave the entry UNSET, not empty: unset is
  // "unknown", and empty would stall every tool step.
  it("leaves the entry unset when the fetch fails", async () => {
    vi.mocked(backend.getTools).mockRejectedValue(new Error("daemon down"));
    await fetchTools("ws-1");
    expect(get(toolRecords)["ws-1"]).toBeUndefined();
    expect(libraryFor(get(toolRecords), "ws-1")).toBeNull();
  });

  it("refreshTools re-reads even when the entry is already loaded", async () => {
    vi.mocked(backend.getTools).mockResolvedValue([]);
    await fetchTools("ws-1");
    vi.mocked(backend.getTools).mockResolvedValue([record()]);
    await refreshTools("ws-1");
    expect(get(toolRecords)["ws-1"]).toHaveLength(1);
  });
});

describe("saveToolAction", () => {
  const tool: Tool = { ...emptyTool("u1"), name: "Deploy", body: "./deploy.sh" };

  beforeEach(() => {
    vi.mocked(backend.getTools).mockResolvedValue([]);
    vi.mocked(backend.saveTool).mockResolvedValue(undefined);
  });

  it("saves a workspace tool with this workspace's id", async () => {
    expect(await saveToolAction("ws-1", tool)).toBeNull();
    expect(backend.saveTool).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u1", workspaceId: "ws-1", name: "Deploy" })
    );
  });

  it("saves a global tool with a null workspace id", async () => {
    await saveToolAction("ws-1", { ...tool, scope: "global" });
    expect(backend.saveTool).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: null }));
  });

  it("refuses a built-in without reaching the daemon", async () => {
    expect(await saveToolAction("ws-1", BUILTIN_TOOLS[0])).toMatch(/Built-in/);
    expect(backend.saveTool).not.toHaveBeenCalled();
  });

  it("returns the daemon's message rather than throwing", async () => {
    vi.mocked(backend.saveTool).mockRejectedValue(new Error("a tool needs a kind"));
    expect(await saveToolAction("ws-1", tool)).toBe("a tool needs a kind");
  });

  // A GLOBAL tool belongs to every workspace, and there is no push for
  // tool writes, so each loaded workspace has to re-read.
  it("refreshes every loaded workspace after a save", async () => {
    toolRecords.set({ "ws-1": [], "ws-2": [] });
    await saveToolAction("ws-1", { ...tool, scope: "global" });
    expect(backend.getTools).toHaveBeenCalledWith("ws-1");
    expect(backend.getTools).toHaveBeenCalledWith("ws-2");
  });

  // Editing an existing tool must not shuffle it to the end of the list.
  it("keeps an existing tool's position on edit", async () => {
    toolRecords.set({ "ws-1": [record({ id: "u1", position: 7 })] });
    await saveToolAction("ws-1", tool);
    expect(backend.saveTool).toHaveBeenCalledWith(expect.objectContaining({ position: 7 }));
  });

  it("appends a new tool at the end", async () => {
    toolRecords.set({ "ws-1": [record({ id: "other" }), record({ id: "other2" })] });
    await saveToolAction("ws-1", tool);
    expect(backend.saveTool).toHaveBeenCalledWith(expect.objectContaining({ position: 2 }));
  });
});

describe("deleteToolAction", () => {
  beforeEach(() => {
    vi.mocked(backend.getTools).mockResolvedValue([]);
    vi.mocked(backend.deleteTool).mockResolvedValue(undefined);
  });

  it("deletes and refreshes", async () => {
    toolRecords.set({ "ws-1": [record()] });
    expect(await deleteToolAction("ws-1", "u1")).toBeNull();
    expect(backend.deleteTool).toHaveBeenCalledWith("u1", "ws-1");
    expect(backend.getTools).toHaveBeenCalledWith("ws-1");
  });

  it("refuses a built-in", async () => {
    expect(await deleteToolAction("ws-1", "builtin:push")).toMatch(/Built-in/);
    expect(backend.deleteTool).not.toHaveBeenCalled();
  });

  it("returns the daemon's message rather than throwing", async () => {
    vi.mocked(backend.deleteTool).mockRejectedValue(new Error("nope"));
    expect(await deleteToolAction("ws-1", "u1")).toBe("nope");
  });
});

// An agent authoring a tool over gavin-mcp is the one tool write this
// app does not make itself, and `fetchTools` is a load-once -- so
// without the push the Tools tab draws a library missing the tool the
// agent just made until the whole workspace reloads.
describe("tools-changed — an agent's write reaches the open app", () => {
  it("replaces the workspace's rows with the pushed library", async () => {
    toolRecords.set({ "ws-1": [record()], "ws-2": [record({ id: "other", workspaceId: "ws-2" })] });
    const unlisten = await initToolListeners();

    const authored = record({ id: "agent-made", name: "Run e2e" });
    tauriEvents.handlers.get("tools-changed")?.({ payload: ["ws-1", [record(), authored]] });

    expect(get(toolRecords)["ws-1"]?.map((r) => r.id)).toEqual(["u1", "agent-made"]);
    // Scoped to the workspace the push named; every other one is left alone.
    expect(get(toolRecords)["ws-2"]?.map((r) => r.id)).toEqual(["other"]);
    unlisten();
  });

  it("carries a DELETE through, not just an addition", async () => {
    toolRecords.set({ "ws-1": [record(), record({ id: "u2" })] });
    const unlisten = await initToolListeners();

    tauriEvents.handlers.get("tools-changed")?.({ payload: ["ws-1", [record({ id: "u2" })]] });

    // The whole library, never a delta: a row absent from the push is a
    // row that is gone.
    expect(get(toolRecords)["ws-1"]?.map((r) => r.id)).toEqual(["u2"]);
    unlisten();
  });

  it("lands a library for a workspace that had never fetched one", async () => {
    const unlisten = await initToolListeners();
    tauriEvents.handlers.get("tools-changed")?.({ payload: ["ws-3", [record({ workspaceId: "ws-3" })]] });
    // Not null any more -- which is what the scheduler reads as
    // "loaded", so a tool step no longer stalls waiting for a fetch.
    expect(libraryFor(get(toolRecords), "ws-3")).not.toBeNull();
    unlisten();
  });
});
