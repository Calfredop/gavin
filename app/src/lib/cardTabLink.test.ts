import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

// openLinkedCard is the only thing here that touches the app: it
// activates the workspace and flips its hub view. Mocked so the pure
// half stays testable without the store graph behind layoutState.
vi.mock("./layoutState", () => ({ switchWorkspace: vi.fn(), switchWorkspaceView: vi.fn() }));

import {
  cardPathForSession,
  cardIsOnARail,
  linkedCardFor,
  linkForCardPath,
  rowLinkedCard,
  openLinkedCard,
  requestedCardDetail,
  takeCardDetailRequest,
} from "./cardTabLink";
import { switchWorkspace, switchWorkspaceView } from "./layoutState";
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
  vi.mocked(switchWorkspace).mockClear();
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

describe("linkForCardPath", () => {
  // The card-pane half: a pane already knows which card it holds, so it
  // asks by path rather than through a session binding. Same answer, so
  // the pane's title and its "Show on the board" can never disagree with
  // the chip that opened it.
  it("names the card and picks the hub tab it belongs to", () => {
    expect(linkForCardPath(railed("/p/a.md"), tree("/p/a.md", "Wire the API"), "/p/a.md")).toEqual({
      path: "/p/a.md",
      title: "Wire the API",
      view: "orchestration",
    });
    expect(linkForCardPath(undefined, tree("/p/a.md", "Wire the API"), "/p/a.md").view).toBe("kanban");
  });

  it("is total: a path the tree has never heard of is still named, by its file", () => {
    // A pane whose card was just created -- or has just moved into
    // plans/done/ -- must keep a readable tab label rather than blanking.
    expect(linkForCardPath(undefined, undefined, "/p/a.md").title).toBe("a.md");
  });
});

describe("rowLinkedCard", () => {
  const b = board(["/p/a.md", "s-1"]);
  const t = tree("/p/a.md", "Wire the API");

  it("answers for a session row exactly as the tab bar's own lookup does", () => {
    expect(rowLinkedCard(b, undefined, t, { id: "s-1", kind: "session", status: "working" })).toEqual(
      linkedCardFor(b, undefined, t, "s-1")
    );
  });

  it("is null for a file or board row -- no agent runs behind those", () => {
    // Even when a card happens to be bound to that very id: the row's
    // kind is what decides, not the binding table.
    expect(rowLinkedCard(b, undefined, t, { id: "s-1", kind: "file", status: null })).toBeNull();
    expect(rowLinkedCard(b, undefined, t, { id: "s-1", kind: "board", status: null })).toBeNull();
  });

  it("is null for a session row bound to no card", () => {
    expect(rowLinkedCard(b, undefined, t, { id: "s-9", kind: "session", status: "idle" })).toBeNull();
  });
});

describe("the detail-modal deep link", () => {
  it("records the target view, activates the workspace, then switches to it", async () => {
    await openLinkedCard("ws-1", { path: "/p/a.md", title: "A", view: "orchestration" });
    expect(get(requestedCardDetail)).toEqual({
      workspaceId: "ws-1",
      path: "/p/a.md",
      view: "orchestration",
    });
    // Activating first is what makes the sidebar's link work at all: it
    // can name a workspace that is not the one on screen.
    expect(switchWorkspace).toHaveBeenCalledWith("ws-1");
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
