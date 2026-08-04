import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("./backend", () => ({
  getBoard: vi.fn(),
  setBoard: vi.fn(),
}));

import * as backend from "./backend";
import {
  kanbanState,
  fetchBoard,
  boardError,
  retryFetchBoard,
  addCardAction,
  deleteColumnCascadeAction,
  linkSessionAction,
  unlinkSessionAction,
  updateSessionLinkAction,
} from "./kanbanState";
import type { Board } from "./kanban";

function emptyBoard(): Board {
  return { columns: [{ id: "c1", name: "To Do", position: 0, cards: [] }], labels: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  kanbanState.set({});
});

describe("fetchBoard", () => {
  it("fetches and stores the board for a workspace", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());

    await fetchBoard("ws-1");

    expect(get(kanbanState)["ws-1"]).toEqual(emptyBoard());
  });

  it("does not re-fetch a workspace whose board is already loaded", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());
    await fetchBoard("ws-1");

    await fetchBoard("ws-1");

    expect(backend.getBoard).toHaveBeenCalledTimes(1);
  });

  it("records a per-workspace error on failure instead of throwing", async () => {
    vi.mocked(backend.getBoard).mockRejectedValue(new Error("daemon unreachable"));

    await fetchBoard("ws-1");

    expect(boardError("ws-1")).toBe("daemon unreachable");
    expect(get(kanbanState)["ws-1"]).toBeUndefined();
  });
});

describe("retryFetchBoard", () => {
  it("clears the error and re-fetches successfully", async () => {
    vi.mocked(backend.getBoard).mockRejectedValueOnce(new Error("daemon unreachable"));
    await fetchBoard("ws-1");
    expect(boardError("ws-1")).toBe("daemon unreachable");

    vi.mocked(backend.getBoard).mockResolvedValueOnce(emptyBoard());
    await retryFetchBoard("ws-1");

    expect(boardError("ws-1")).toBeNull();
    expect(get(kanbanState)["ws-1"]).toEqual(emptyBoard());
  });
});

describe("addCardAction", () => {
  it("mutates local state immediately and persists via setBoard", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());
    await fetchBoard("ws-1");

    await addCardAction("ws-1", "c1", { id: "card-1", title: "New", description: "", labelIds: [], priority: "none", position: 0 });

    expect(get(kanbanState)["ws-1"].columns[0].cards).toHaveLength(1);
    expect(backend.setBoard).toHaveBeenCalledWith("ws-1", get(kanbanState)["ws-1"].columns, []);
  });

  it("is a no-op when the workspace's board was never fetched", async () => {
    await addCardAction("ws-1", "c1", { id: "card-1", title: "New", description: "", labelIds: [], priority: "none", position: 0 });

    expect(get(kanbanState)["ws-1"]).toBeUndefined();
    expect(backend.setBoard).not.toHaveBeenCalled();
  });
});

describe("linkSessionAction", () => {
  it("mutates local state immediately and persists via setBoard", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue({
      columns: [
        {
          id: "c1",
          name: "To Do",
          position: 0,
          cards: [{ id: "card-1", title: "Card", description: "", labelIds: [], priority: "none", position: 0 }],
        },
      ],
      labels: [],
    });
    await fetchBoard("ws-1");

    await linkSessionAction("ws-1", "card-1", { sessionId: "s1", cwd: "/tmp", command: null });

    expect(get(kanbanState)["ws-1"].columns[0].cards[0].sessionLink).toEqual({
      sessionId: "s1",
      cwd: "/tmp",
      command: null,
    });
    expect(backend.setBoard).toHaveBeenCalledWith("ws-1", get(kanbanState)["ws-1"].columns, []);
  });
});

describe("unlinkSessionAction", () => {
  it("clears the card's sessionLink and persists", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue({
      columns: [
        {
          id: "c1",
          name: "To Do",
          position: 0,
          cards: [
            {
              id: "card-1",
              title: "Card",
              description: "",
              labelIds: [],
              priority: "none",
              position: 0,
              sessionLink: { sessionId: "s1", cwd: "/tmp", command: null },
            },
          ],
        },
      ],
      labels: [],
    });
    await fetchBoard("ws-1");

    await unlinkSessionAction("ws-1", "card-1");

    expect(get(kanbanState)["ws-1"].columns[0].cards[0].sessionLink).toBeUndefined();
  });
});

describe("updateSessionLinkAction", () => {
  it("replaces the linked sessionId and persists", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue({
      columns: [
        {
          id: "c1",
          name: "To Do",
          position: 0,
          cards: [
            {
              id: "card-1",
              title: "Card",
              description: "",
              labelIds: [],
              priority: "none",
              position: 0,
              sessionLink: { sessionId: "old", cwd: "/tmp", command: null },
            },
          ],
        },
      ],
      labels: [],
    });
    await fetchBoard("ws-1");

    await updateSessionLinkAction("ws-1", "card-1", "new");

    expect(get(kanbanState)["ws-1"].columns[0].cards[0].sessionLink?.sessionId).toBe("new");
  });
});

describe("deleteColumnCascadeAction", () => {
  it("mutates local state and persists", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());
    await fetchBoard("ws-1");

    await deleteColumnCascadeAction("ws-1", "c1");

    expect(get(kanbanState)["ws-1"].columns).toEqual([]);
    expect(backend.setBoard).toHaveBeenCalledWith("ws-1", [], []);
  });
});
