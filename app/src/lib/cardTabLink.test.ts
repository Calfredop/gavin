import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

// openLinkedCard is the only thing here that touches the app: it flips
// the hub view. Mocked so the pure half stays testable without the store
// graph behind layoutState.
vi.mock("./layoutState", () => ({ switchWorkspaceView: vi.fn() }));

import {
  cardPathForSession,
  cardIsOnARail,
  linkedCardFor,
  openLinkedCard,
  requestedCardDetail,
  takeCardDetailRequest,
} from "./cardTabLink";
import { switchWorkspaceView } from "./layoutState";
import type { Board } from "./kanban";
import type { GavinTree } from "./gavin";
import type { Orchestration } from "./orchestration";

const board = (...pairs: [string, string][]): Board => ({
  columns: [],
  labels: [],
  cardSessions: pairs.map(([path, sessionId]) => ({ path, sessionId, cwd: "/ws", command: null })),
});

const tree = (path: string, title: string): GavinTree => ({
  rootPath: "/ws",
  rootMissing: false,
  contexts: [
    {
      folderPath: "/ws/.gavin-root",
      kind: "root",
      name: "ws",
      plans: [
        {
          path,
          fileName: path.split("/").at(-1) ?? path,
          title,
          status: "In Progress",
          priority: null,
          order: null,
          kind: "task",
          parent: null,
          labels: [],
          checklistDone: 0,
          checklistTotal: 0,
          parseWarning: false,
        },
      ],
      docs: [],
      specs: [],
      hasPrd: true,
      configWarning: false,
      agent: null,
      outside: false,
    },
  ],
});

const railed = (cardPath: string): Orchestration => ({
  rails: [
    {
      id: "r1",
      name: "backend",
      position: 0,
      worktreePath: null,
      pageId: null,
      stages: [{ id: "st1", position: 0, steps: [{ id: "s1", position: 0, cardPath }] }],
    },
  ],
  conflictNotes: [],
  railRuns: [],
  stepRuns: [],
});

beforeEach(() => {
  requestedCardDetail.set(null);
  vi.mocked(switchWorkspaceView).mockClear();
});

describe("cardPathForSession", () => {
  it("reverses the card_sessions binding, and answers null for a plain terminal", () => {
    const b = board(["/ws/.gavin-root/plans/a.md", "s-1"], ["/ws/.gavin-root/plans/b.md", "s-2"]);
    expect(cardPathForSession(b, "s-2")).toBe("/ws/.gavin-root/plans/b.md");
    expect(cardPathForSession(b, "s-3")).toBeNull();
    expect(cardPathForSession(undefined, "s-1")).toBeNull();
  });
});

describe("cardIsOnARail", () => {
  it("looks through every rail's stages and steps", () => {
    expect(cardIsOnARail(railed("/p/a.md"), "/p/a.md")).toBe(true);
    expect(cardIsOnARail(railed("/p/a.md"), "/p/b.md")).toBe(false);
    expect(cardIsOnARail(undefined, "/p/a.md")).toBe(false);
  });
});

describe("linkedCardFor", () => {
  it("sends a railed card to the Orchestration tab and every other card to the board", () => {
    const b = board(["/p/a.md", "s-1"]);
    expect(linkedCardFor(b, railed("/p/a.md"), tree("/p/a.md", "Wire the API"), "s-1")).toEqual({
      path: "/p/a.md",
      title: "Wire the API",
      view: "orchestration",
    });
    expect(linkedCardFor(b, undefined, tree("/p/a.md", "Wire the API"), "s-1")?.view).toBe("kanban");
  });

  it("falls back to the file name when the tree has not caught up with the card", () => {
    const link = linkedCardFor(board(["/p/a.md", "s-1"]), undefined, undefined, "s-1");
    expect(link?.title).toBe("a.md");
  });

  it("is null for a session bound to nothing -- most tabs are not agents", () => {
    expect(linkedCardFor(board(["/p/a.md", "s-1"]), undefined, undefined, "s-9")).toBeNull();
  });
});

describe("the detail-modal deep link", () => {
  it("records the target view, then switches to it", async () => {
    await openLinkedCard("ws-1", { path: "/p/a.md", title: "A", view: "orchestration" });
    expect(get(requestedCardDetail)).toEqual({
      workspaceId: "ws-1",
      path: "/p/a.md",
      view: "orchestration",
    });
    expect(switchWorkspaceView).toHaveBeenCalledWith("ws-1", "orchestration");
  });

  it("is answered once, by the workspace and the view it names", () => {
    const req = { workspaceId: "ws-1", path: "/p/a.md", view: "kanban" as const };
    requestedCardDetail.set(req);
    // The tab being left must not swallow a request meant for the one
    // being arrived at, nor another workspace's board.
    expect(takeCardDetailRequest(req, "ws-1", "orchestration")).toBeNull();
    expect(takeCardDetailRequest(req, "ws-2", "kanban")).toBeNull();
    expect(get(requestedCardDetail)).toEqual(req);

    expect(takeCardDetailRequest(req, "ws-1", "kanban")).toBe("/p/a.md");
    expect(get(requestedCardDetail)).toBeNull();
    expect(takeCardDetailRequest(null, "ws-1", "kanban")).toBeNull();
  });
});
