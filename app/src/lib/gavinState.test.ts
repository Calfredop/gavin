import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("./backend", () => ({
  // Resolved by default: watchRootedWorkspaces calls .catch() on this, so
  // a bare vi.fn() returning undefined would throw instead of exercising
  // the real best-effort path.
  watchGavinRoot: vi.fn().mockResolvedValue(undefined),
  unwatchGavinRoot: vi.fn().mockResolvedValue(undefined),
}));

import { listen } from "@tauri-apps/api/event";
import * as backend from "./backend";
import { gavinTrees, initGavinListeners, watchRootedWorkspaces, __resetForTesting } from "./gavinState";
import type { GavinTree } from "./gavin";
import type { Workspace } from "./workspace";

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
});
