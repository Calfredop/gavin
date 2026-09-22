import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("$lib/core/backend", () => ({
  getGroupTemplates: vi.fn(),
  saveGroupTemplate: vi.fn(),
  deleteGroupTemplate: vi.fn(),
}));

import * as backend from "$lib/core/backend";
import {
  groupTemplateRecords,
  libraryFor,
  fetchGroupTemplates,
  refreshGroupTemplates,
  saveGroupTemplateAction,
  deleteGroupTemplateAction,
  __resetForTesting,
} from "$lib/orchestration/groupTemplatesState";
import type { GroupTemplate, GroupTemplateRecord } from "$lib/orchestration/orchestrationGroups";

function record(over: Partial<GroupTemplateRecord> = {}): GroupTemplateRecord {
  return {
    id: "g1",
    workspaceId: "ws-1",
    name: "Merge and push",
    description: "",
    mode: "sequence",
    steps: [{ toolId: "builtin:push", toolParams: { remote: "origin" } }],
    position: 0,
    ...over,
  };
}

beforeEach(() => {
  __resetForTesting();
  vi.clearAllMocks();
});

// The distinction the drawer rests on: an unloaded library must not look
// like a library with nothing in it. Unlike the tool library there is no
// built-in fallback, so this is the ONLY signal Task 12 has.
describe("libraryFor — loading is not empty", () => {
  it("is null before the fetch has landed", () => {
    expect(libraryFor({}, "ws-1")).toBeNull();
    expect(libraryFor({ "ws-1": null }, "ws-1")).toBeNull();
  });

  it("is an empty array once an EMPTY result has landed", () => {
    expect(libraryFor({ "ws-1": [] }, "ws-1")).toEqual([]);
  });

  it("adds the stored rows", () => {
    expect(libraryFor({ "ws-1": [record()] }, "ws-1")).toHaveLength(1);
  });
});

describe("fetchGroupTemplates", () => {
  it("fetches once and caches", async () => {
    vi.mocked(backend.getGroupTemplates).mockResolvedValue([record()]);
    await fetchGroupTemplates("ws-1");
    await fetchGroupTemplates("ws-1");
    expect(backend.getGroupTemplates).toHaveBeenCalledTimes(1);
    expect(get(groupTemplateRecords)["ws-1"]).toHaveLength(1);
  });

  // A failed fetch must leave the entry UNSET, not empty: unset is
  // "unknown", and empty would render as "no templates" rather than
  // "still loading".
  it("leaves the entry unset when the fetch fails", async () => {
    vi.mocked(backend.getGroupTemplates).mockRejectedValue(new Error("daemon down"));
    await fetchGroupTemplates("ws-1");
    expect(get(groupTemplateRecords)["ws-1"]).toBeUndefined();
    expect(libraryFor(get(groupTemplateRecords), "ws-1")).toBeNull();
  });

  it("refreshGroupTemplates re-reads even when the entry is already loaded", async () => {
    vi.mocked(backend.getGroupTemplates).mockResolvedValue([]);
    await fetchGroupTemplates("ws-1");
    vi.mocked(backend.getGroupTemplates).mockResolvedValue([record()]);
    await refreshGroupTemplates("ws-1");
    expect(get(groupTemplateRecords)["ws-1"]).toHaveLength(1);
  });
});

describe("saveGroupTemplateAction", () => {
  const template: GroupTemplate = {
    id: "g1",
    name: "Merge and push",
    description: "",
    mode: "sequence",
    steps: [{ toolId: "builtin:push", toolParams: {} }],
    scope: "workspace",
  };

  beforeEach(() => {
    vi.mocked(backend.getGroupTemplates).mockResolvedValue([]);
    vi.mocked(backend.saveGroupTemplate).mockResolvedValue(undefined);
  });

  it("saves a workspace template with this workspace's id", async () => {
    expect(await saveGroupTemplateAction("ws-1", template)).toBeNull();
    expect(backend.saveGroupTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "g1", workspaceId: "ws-1", name: "Merge and push" })
    );
  });

  it("saves a global template with a null workspace id", async () => {
    await saveGroupTemplateAction("ws-1", { ...template, scope: "global" });
    expect(backend.saveGroupTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: null })
    );
  });

  it("returns the daemon's message rather than throwing", async () => {
    vi.mocked(backend.saveGroupTemplate).mockRejectedValue(new Error("unknown tool id nope"));
    expect(await saveGroupTemplateAction("ws-1", template)).toBe("unknown tool id nope");
  });

  // A GLOBAL template belongs to every workspace, and there is no push
  // for template writes, so each loaded workspace has to re-read.
  it("refreshes every loaded workspace after a save", async () => {
    groupTemplateRecords.set({ "ws-1": [], "ws-2": [] });
    await saveGroupTemplateAction("ws-1", { ...template, scope: "global" });
    expect(backend.getGroupTemplates).toHaveBeenCalledWith("ws-1");
    expect(backend.getGroupTemplates).toHaveBeenCalledWith("ws-2");
  });

  // Editing an existing template must not shuffle it to the end of the
  // list.
  it("keeps an existing template's position on edit", async () => {
    groupTemplateRecords.set({ "ws-1": [record({ id: "g1", position: 7 })] });
    await saveGroupTemplateAction("ws-1", template);
    expect(backend.saveGroupTemplate).toHaveBeenCalledWith(expect.objectContaining({ position: 7 }));
  });

  it("appends a new template at the end", async () => {
    groupTemplateRecords.set({
      "ws-1": [record({ id: "other" }), record({ id: "other2" })],
    });
    await saveGroupTemplateAction("ws-1", template);
    expect(backend.saveGroupTemplate).toHaveBeenCalledWith(expect.objectContaining({ position: 2 }));
  });
});

describe("deleteGroupTemplateAction", () => {
  beforeEach(() => {
    vi.mocked(backend.getGroupTemplates).mockResolvedValue([]);
    vi.mocked(backend.deleteGroupTemplate).mockResolvedValue(undefined);
  });

  it("deletes and refreshes", async () => {
    groupTemplateRecords.set({ "ws-1": [record()] });
    expect(await deleteGroupTemplateAction("ws-1", "g1")).toBeNull();
    expect(backend.deleteGroupTemplate).toHaveBeenCalledWith("g1", "ws-1");
    expect(backend.getGroupTemplates).toHaveBeenCalledWith("ws-1");
  });

  it("returns the daemon's message rather than throwing", async () => {
    vi.mocked(backend.deleteGroupTemplate).mockRejectedValue(new Error("nope"));
    expect(await deleteGroupTemplateAction("ws-1", "g1")).toBe("nope");
  });
});
