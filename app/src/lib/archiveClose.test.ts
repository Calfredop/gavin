import { describe, it, expect } from "vitest";
import {
  closablesForArchive,
  liveSessionTotal,
  archiveClosePrompt,
  type ClosableState,
} from "./archiveClose";
import type { Board, CardSession } from "./kanban";
import type { CardView } from "./planBoard";

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

/// Every id listed here is a tab that EXISTS -- findSessionLocation only
/// finds a session that is still in some page's tree, which is exactly
/// the app's definition of "still running".
function state(liveTabs: string[], fileTabs: Record<string, string> = {}): ClosableState {
  const fileTabsById: Record<string, { path: string }> = {};
  for (const [id, path] of Object.entries(fileTabs)) fileTabsById[id] = { path };
  return {
    activeWorkspaceId: "ws",
    workspaces: [
      {
        id: "ws",
        name: "ws",
        pages: [
          {
            id: "pg-1",
            name: "Agents",
            layout: { type: "leaf", tabs: liveTabs, activeTabIndex: 0 },
            focusedSessionId: null,
          },
        ],
        activePageId: "pg-1",
      },
    ],
    fileTabsById,
  };
}

function board(cardSessions: CardSession[]): Board {
  return { columns: [], labels: [], cardSessions };
}

function binding(path: string, sessionId: string): CardSession {
  return { path, sessionId, cwd: "/ws", command: null };
}

describe("closablesForArchive", () => {
  it("finds the card's live session and every tab showing its file", () => {
    const [a] = closablesForArchive(
      state(["s-1"], { "t-1": `${PLANS}/a.md`, "t-2": `${PLANS}/a.md` }),
      board([binding(`${PLANS}/a.md`, "s-1")]),
      [view("a.md")]
    );
    expect(a.sessionIds).toEqual(["s-1"]);
    // Two panes can show the same file; both tabs go.
    expect(a.fileTabIds).toEqual(["t-1", "t-2"]);
  });

  it("ignores a binding whose session already exited", () => {
    const [a] = closablesForArchive(state(["s-other"]), board([binding(`${PLANS}/a.md`, "s-1")]), [
      view("a.md"),
    ]);
    expect(a.sessionIds).toEqual([]);
  });

  it("takes a plan's nested children down with it", () => {
    // The children move with their parent on disk, so their sessions and
    // tabs are the parent's to close.
    const child = view("step.md", { kind: "task", status: null });
    const [big] = closablesForArchive(
      state(["s-parent", "s-child"], { "t-child": `${PLANS}/step.md` }),
      board([
        binding(`${PLANS}/big.md`, "s-parent"),
        binding(`${PLANS}/step.md`, "s-child"),
      ]),
      [view("big.md", { nestedChildren: [child] })]
    );
    expect(big.sessionIds).toEqual(["s-parent", "s-child"]);
    expect(big.fileTabIds).toEqual(["t-child"]);
  });

  it("leaves another card's session alone", () => {
    const [a, b] = closablesForArchive(
      state(["s-a", "s-b"]),
      board([binding(`${PLANS}/a.md`, "s-a"), binding(`${PLANS}/b.md`, "s-b")]),
      [view("a.md"), view("b.md")]
    );
    expect(a.sessionIds).toEqual(["s-a"]);
    expect(b.sessionIds).toEqual(["s-b"]);
  });

  it("claims a shared id once, so it is killed once and counted once", () => {
    // Two cards can name the same session -- a re-launch that landed on
    // both -- and the second must not try to close an id already gone.
    const closables = closablesForArchive(
      state(["s-1"], { "t-1": `${PLANS}/a.md` }),
      board([binding(`${PLANS}/a.md`, "s-1"), binding(`${PLANS}/b.md`, "s-1")]),
      [view("a.md"), view("b.md")]
    );
    expect(closables[0].sessionIds).toEqual(["s-1"]);
    expect(closables[1].sessionIds).toEqual([]);
    expect(liveSessionTotal(closables)).toBe(1);
  });

  it("a board that was never fetched closes nothing", () => {
    const [a] = closablesForArchive(state(["s-1"]), undefined, [view("a.md")]);
    expect(a).toEqual({ sessionIds: [], fileTabIds: [] });
  });
});

describe("archiveClosePrompt", () => {
  it("names the card count and the sessions it costs", () => {
    expect(archiveClosePrompt(1, 1)).toEqual({
      title: "Archive this card?",
      lines: ["1 running agent session will end."],
    });
    expect(archiveClosePrompt(3, 2)).toEqual({
      title: "Archive these 3 cards?",
      lines: ["2 running agent sessions will end."],
    });
  });
});
