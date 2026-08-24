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
  getOrchestration: vi.fn(),
  setOrchestration: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./layoutState", () => ({
  layoutState: writable({ workspaces: [], sessionStatusById: {}, sessionNames: {}, cwdBySessionId: {} }),
  switchWorkspaceView: vi.fn().mockResolvedValue(undefined),
  switchToSessionInPage: vi.fn().mockResolvedValue(undefined),
  handleAgentSessionSpawned: vi.fn(),
  resolvedAgentFor: vi.fn(() => ({ profileId: "claude-code", file: "CLAUDE.md", command: "claude", mcpSupported: true })),
}));
vi.mock("./workspace", () => ({ findSessionLocation: vi.fn() }));

import * as backend from "./backend";
import { findSessionLocation } from "./workspace";
import { kanbanState } from "./kanbanState";
import { orchestrations } from "./orchestrationState";
import { emptyOrchestration, addRail, addStage, addStep } from "./orchestration";
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

function item(entries: ReturnType<typeof buildCardMenuEntries>, label: string): ContextMenuItem | undefined {
  return entries.find((e): e is ContextMenuItem => !isSeparator(e) && e.label === label);
}

/// Two rails, "backend" and "ui"; `on` optionally puts the card on one of
/// them as a single-step stage.
function rails(on?: "backend" | "ui"): void {
  let o = addRail(addRail(emptyOrchestration(), "r1", "backend"), "r2", "ui");
  if (on) {
    const railId = on === "backend" ? "r1" : "r2";
    o = addStep(addStage(o, railId, "s1"), "s1", "step-1", "/p/t.md");
  }
  orchestrations.set({ "ws-1": o });
}

beforeEach(() => {
  vi.clearAllMocks();
  kanbanState.set({ "ws-1": board() });
  orchestrations.set({ "ws-1": emptyOrchestration() });
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

  it("no rail block at all in a workspace with no rails", () => {
    expect(labels(buildCardMenuEntries(card("task", "To Do"), hooks())).join()).not.toContain("rail");
  });

  it("offers one entry per rail, in board order", () => {
    rails();
    const l = labels(buildCardMenuEntries(card("plan", "To Do"), hooks()));
    expect(l.filter((x) => x.startsWith("Send to rail"))).toEqual([
      "Send to rail “backend”",
      "Send to rail “ui”",
    ]);
  });

  it("marks the rail the card is already on, and offers to take it off", () => {
    rails("backend");
    const entries = buildCardMenuEntries(card("task", "To Do"), hooks());
    const here = item(entries, "Send to rail “backend”");
    expect(here?.active).toBe(true);
    expect(here?.disabled).toBe(true);
    expect(item(entries, "Send to rail “ui”")?.disabled).toBe(false);
    expect(item(entries, "Take off rail “backend”")).toBeDefined();
  });

  it("no rail entries for a note — notes are not runnable", () => {
    rails();
    expect(labels(buildCardMenuEntries(card("note", "To Do"), hooks())).join()).not.toContain("rail");
  });

  it("picking a rail persists the whole plan with the card on it", async () => {
    rails();
    const entries = buildCardMenuEntries(card("task", "To Do"), hooks());
    item(entries, "Send to rail “ui”")?.onPick();
    await vi.waitFor(() => expect(backend.setOrchestration).toHaveBeenCalled());
    const [wsId, saved] = vi.mocked(backend.setOrchestration).mock.calls[0];
    expect(wsId).toBe("ws-1");
    expect(saved.find((r) => r.id === "r2")?.stages[0].steps[0].cardPath).toBe("/p/t.md");
  });

  it("Un-parent appears only for parented tasks", () => {
    expect(labels(buildCardMenuEntries(card("task", null, { parent: "p.md" }), hooks()))).toContain("Un-parent");
    expect(labels(buildCardMenuEntries(card("task", null), hooks()))).not.toContain("Un-parent");
    expect(labels(buildCardMenuEntries(card("plan", "To Do"), hooks()))).not.toContain("Un-parent");
  });
});
