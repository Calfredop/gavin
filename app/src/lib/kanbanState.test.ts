import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("./backend", () => ({
  getBoard: vi.fn(),
  setBoard: vi.fn(),
  linkCardSession: vi.fn(),
  unlinkCardSession: vi.fn(),
}));

import * as backend from "./backend";
import {
  kanbanState,
  fetchBoard,
  refreshBoard,
  boardError,
  retryFetchBoard,
  addColumnAction,
  renameColumnAction,
  deleteColumnAction,
  linkCardSessionAction,
  unlinkCardSessionAction,
  cardSessionFor,
  saveErrors,
  dismissSaveError,
} from "./kanbanState";
import type { Board } from "./kanban";

function emptyBoard(): Board {
  return { columns: [{ id: "c1", name: "To Do", position: 0 }], labels: [], cardSessions: [] };
}

const newColumn = { id: "c2", name: "Doing", position: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  kanbanState.set({});
  saveErrors.set({});
});

describe("fetchBoard", () => {
  it("fetches and stores the board for a workspace", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());
    await fetchBoard("ws-1");
    expect(get(kanbanState)["ws-1"]).toEqual(emptyBoard());
  });

  it("is a no-op when the board is already cached", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());
    await fetchBoard("ws-1");
    await fetchBoard("ws-1");
    expect(backend.getBoard).toHaveBeenCalledTimes(1);
  });

  it("records a load error and retryFetchBoard clears it", async () => {
    vi.mocked(backend.getBoard).mockRejectedValueOnce(new Error("boom"));
    await fetchBoard("ws-1");
    expect(boardError("ws-1")).toContain("boom");
    vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());
    await retryFetchBoard("ws-1");
    expect(boardError("ws-1")).toBeNull();
    expect(get(kanbanState)["ws-1"]).toEqual(emptyBoard());
  });
});

describe("column actions", () => {
  it("addColumnAction mutates optimistically and persists via setBoard", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());
    await fetchBoard("ws-1");
    vi.mocked(backend.setBoard).mockResolvedValue(undefined);

    await addColumnAction("ws-1", newColumn);

    expect(get(kanbanState)["ws-1"].columns).toHaveLength(2);
    expect(backend.setBoard).toHaveBeenCalledWith("ws-1", get(kanbanState)["ws-1"].columns, []);
  });

  it("is a no-op when the workspace's board was never fetched", async () => {
    await addColumnAction("ws-1", newColumn);
    expect(get(kanbanState)["ws-1"]).toBeUndefined();
    expect(backend.setBoard).not.toHaveBeenCalled();
  });

  it("deleteColumnAction removes the column", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());
    await fetchBoard("ws-1");
    vi.mocked(backend.setBoard).mockResolvedValue(undefined);

    await deleteColumnAction("ws-1", "c1");

    expect(get(kanbanState)["ws-1"].columns).toEqual([]);
    expect(backend.setBoard).toHaveBeenCalledWith("ws-1", [], []);
  });
});

describe("save failures", () => {
  it("failed setBoard rolls the store back and records a save error", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());
    await fetchBoard("ws-1");
    vi.mocked(backend.setBoard).mockRejectedValue(new Error("daemon gone"));

    await addColumnAction("ws-1", newColumn);

    expect(get(kanbanState)["ws-1"]).toEqual(emptyBoard());
    expect(get(saveErrors)["ws-1"]).toContain("daemon gone");
  });

  it("a successful save clears the workspace's save error", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());
    await fetchBoard("ws-1");
    vi.mocked(backend.setBoard).mockRejectedValueOnce(new Error("daemon gone"));
    await addColumnAction("ws-1", newColumn);
    expect(get(saveErrors)["ws-1"]).toBeDefined();

    vi.mocked(backend.setBoard).mockResolvedValue(undefined);
    await addColumnAction("ws-1", newColumn);

    expect(get(saveErrors)["ws-1"]).toBeUndefined();
  });

  it("dismissSaveError clears the message", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());
    await fetchBoard("ws-1");
    vi.mocked(backend.setBoard).mockRejectedValue(new Error("x"));
    await addColumnAction("ws-1", newColumn);

    dismissSaveError("ws-1");

    expect(get(saveErrors)["ws-1"]).toBeUndefined();
  });

  it("rollback is skipped when a later mutation already changed the store", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());
    await fetchBoard("ws-1");

    let rejectA!: (e: Error) => void;
    vi.mocked(backend.setBoard).mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectA = reject))
    );
    const a = renameColumnAction("ws-1", "c1", "First rename");

    vi.mocked(backend.setBoard).mockResolvedValue(undefined);
    await renameColumnAction("ws-1", "c1", "Second rename");

    rejectA(new Error("late failure"));
    await a;

    expect(get(kanbanState)["ws-1"].columns[0].name).toBe("Second rename");
    expect(get(saveErrors)["ws-1"]).toContain("late failure");
  });
});

describe("refreshBoard", () => {
  it("refetches and replaces the cached board", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());
    await fetchBoard("ws-1");
    const richer: Board = { ...emptyBoard(), labels: [{ id: "l", name: "L", color: "#fff" }] };
    vi.mocked(backend.getBoard).mockResolvedValue(richer);

    await refreshBoard("ws-1");

    expect(get(kanbanState)["ws-1"]).toEqual(richer);
  });

  it("is skipped while a save is in flight", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());
    await fetchBoard("ws-1");

    let resolveSave!: () => void;
    vi.mocked(backend.setBoard).mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveSave = resolve))
    );
    const pending = addColumnAction("ws-1", newColumn);

    vi.mocked(backend.getBoard).mockClear();
    await refreshBoard("ws-1");
    expect(backend.getBoard).not.toHaveBeenCalled();

    resolveSave();
    await pending;
  });

  it("a failed refresh keeps the board we have", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());
    await fetchBoard("ws-1");
    vi.mocked(backend.getBoard).mockRejectedValue(new Error("offline"));

    await refreshBoard("ws-1");

    expect(get(kanbanState)["ws-1"]).toEqual(emptyBoard());
    expect(boardError("ws-1")).toBeNull();
  });
});

describe("card session bindings", () => {
  const binding = { path: "/p/t.md", sessionId: "s-1", cwd: "/p", command: "claude 'x'" };

  it("link upserts optimistically and persists", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());
    await fetchBoard("ws-1");
    vi.mocked(backend.linkCardSession).mockResolvedValue(undefined);

    await linkCardSessionAction("ws-1", binding);

    expect(get(kanbanState)["ws-1"].cardSessions).toEqual([binding]);
    // The last four are the conversation this run IS, where it was
    // launched, how many times gavin has resumed it by itself, and the
    // commit it started on -- null on a binding that predates them, and
    // explicitly passed rather than omitted so a daemon that HAS the
    // columns clears them instead of keeping a previous run's.
    expect(backend.linkCardSession).toHaveBeenCalledWith(
      "ws-1",
      "/p/t.md",
      "s-1",
      "/p",
      "claude 'x'",
      null,
      null,
      null,
      null
    );
    expect(cardSessionFor(get(kanbanState)["ws-1"], "/p/t.md")).toEqual(binding);

    // Upsert replaces:
    await linkCardSessionAction("ws-1", { ...binding, sessionId: "s-2" });
    expect(get(kanbanState)["ws-1"].cardSessions).toHaveLength(1);
    expect(get(kanbanState)["ws-1"].cardSessions[0].sessionId).toBe("s-2");
  });

  it("unlink removes optimistically and persists", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue({ ...emptyBoard(), cardSessions: [binding] });
    await fetchBoard("ws-1");
    vi.mocked(backend.unlinkCardSession).mockResolvedValue(undefined);

    await unlinkCardSessionAction("ws-1", "/p/t.md");

    expect(get(kanbanState)["ws-1"].cardSessions).toEqual([]);
    expect(backend.unlinkCardSession).toHaveBeenCalledWith("ws-1", "/p/t.md");
  });

  it("a failed link rolls back and records a save error", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());
    await fetchBoard("ws-1");
    vi.mocked(backend.linkCardSession).mockRejectedValue(new Error("daemon gone"));

    await linkCardSessionAction("ws-1", binding);

    expect(get(kanbanState)["ws-1"].cardSessions).toEqual([]);
    expect(get(saveErrors)["ws-1"]).toContain("daemon gone");
  });
});
