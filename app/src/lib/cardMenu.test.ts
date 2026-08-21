import { describe, it, expect, vi, beforeEach } from "vitest";
import { writable } from "svelte/store";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./backend", () => ({
  setPlanFrontmatterField: vi.fn(),
  getBoard: vi.fn(),
  createSession: vi.fn(),
  readFileForViewer: vi.fn(),
  linkCardSession: vi.fn(),
  unlinkCardSession: vi.fn(),
}));
vi.mock("./layoutState", () => ({
  layoutState: writable({ workspaces: [], sessionStatusById: {}, sessionNames: {}, cwdBySessionId: {} }),
  switchWorkspaceView: vi.fn().mockResolvedValue(undefined),
  switchToSessionInPage: vi.fn().mockResolvedValue(undefined),
  handleAgentSessionSpawned: vi.fn(),
  resolvedAgentFor: vi.fn(() => ({ profileId: "claude-code", file: "CLAUDE.md", command: "claude", mcpSupported: true })),
}));
vi.mock("./workspace", () => ({ findSessionLocation: vi.fn() }));

import { findSessionLocation } from "./workspace";
import { kanbanState } from "./kanbanState";
import { buildCardMenuEntries, type CardMenuHooks } from "./cardMenu";
import { isSeparator, type ContextMenuItem } from "./contextMenu";
import type { CardView } from "./planBoard";
import type { Board } from "./kanban";

function card(kind: "note" | "task" | "plan", status: string | null, extra: Partial<CardView> = {}): CardView {
  return {
    id: "/p/t.md",
    title: "T",
    status,
    priority: null,
    order: null,
    kind,
    parent: null,
    parentTitle: null,
    parentBroken: false,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    contextName: "p",
    contextFolder: "/p",
    fileName: "t.md",
    parseWarning: false,
    nestedChildren: [],
    ...extra,
  };
}

function hooks(): CardMenuHooks {
  return {
    workspaceId: "ws-1",
    columns: [
      { id: "c1", name: "To Do", position: 0 },
      { id: "c2", name: "Done", position: 1 },
    ],
    openDetail: vi.fn(),
    requestDelete: vi.fn(),
    run: vi.fn(),
    sendToAgent: vi.fn(),
    agentAvailable: false,
    reportError: vi.fn(),
  };
}

function labels(entries: ReturnType<typeof buildCardMenuEntries>): string[] {
  return entries.filter((e): e is ContextMenuItem => !isSeparator(e)).map((e) => e.label);
}

function board(cardSessions: Board["cardSessions"] = []): Board {
  return { columns: [], labels: [], cardSessions };
}

beforeEach(() => {
  vi.clearAllMocks();
  kanbanState.set({ "ws-1": board() });
  vi.mocked(findSessionLocation).mockReturnValue(null);
});

describe("buildCardMenuEntries", () => {
  it("a note gets open/move/delete but no run entry", () => {
    const l = labels(buildCardMenuEntries(card("note", "To Do"), hooks()));
    expect(l).toContain("Open");
    expect(l).toContain("Move to Done");
    expect(l).toContain("Delete…");
    expect(l.join()).not.toContain("Run");
    expect(l.join()).not.toContain("session");
  });

  it("an unbound task offers both run modes; the current column is disabled-active", () => {
    const entries = buildCardMenuEntries(card("task", "To Do"), hooks());
    const l = labels(entries);
    expect(l).toContain("Run in dedicated session");
    const send = entries.find(
      (e): e is ContextMenuItem => !isSeparator(e) && e.label === "Send to workspace agent"
    );
    expect(send?.disabled).toBe(true); // no main agent in these hooks
    const current = entries.find(
      (e): e is ContextMenuItem => !isSeparator(e) && e.label === "Move to To Do"
    );
    expect(current?.disabled).toBe(true);
    expect(current?.active).toBe(true);
  });

  it("a live binding offers Jump; a dead one offers Re-launch", () => {
    kanbanState.set({
      "ws-1": board([{ path: "/p/t.md", sessionId: "s-1", cwd: "/p", command: null }]),
    });
    vi.mocked(findSessionLocation).mockReturnValue({ workspaceId: "ws-1", pageId: "pg" });
    expect(labels(buildCardMenuEntries(card("plan", null), hooks()))).toContain("Jump to session");

    vi.mocked(findSessionLocation).mockReturnValue(null);
    expect(labels(buildCardMenuEntries(card("plan", null), hooks()))).toContain("Re-launch agent");
  });

  it("Un-parent appears only for parented tasks", () => {
    expect(labels(buildCardMenuEntries(card("task", null, { parent: "p.md" }), hooks()))).toContain("Un-parent");
    expect(labels(buildCardMenuEntries(card("task", null), hooks()))).not.toContain("Un-parent");
    expect(labels(buildCardMenuEntries(card("plan", "To Do"), hooks()))).not.toContain("Un-parent");
  });
});
