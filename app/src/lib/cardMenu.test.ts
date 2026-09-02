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
  layoutState: writable({
    workspaces: [],
    sessionStatusById: {},
    sessionNames: {},
    cwdBySessionId: {},
    interruptedSessionIds: new Set<string>(),
    failureReasonById: {},
  }),
  // null = "not connected yet", which featureBlockedReason reads as "do
  // not pre-emptively grey anything out" -- so the archive entry is live
  // in these tests without pinning a daemon version.
  daemonCompat: writable(null),
  switchWorkspaceView: vi.fn().mockResolvedValue(undefined),
  switchToSessionInPage: vi.fn().mockResolvedValue(undefined),
  handleAgentSessionSpawned: vi.fn(),
  setSessionName: vi.fn().mockResolvedValue(undefined),
  resolvedAgentFor: vi.fn(() => ({
    profileId: "claude-code",
    file: "CLAUDE.md",
    command: "claude",
    launchCommand: "claude",
    mcpSupported: true,
    failurePatterns: ["API Error:"],
    sessionIdArgs: "--session-id",
    resumeArgs: "--resume",
  })),
  armFailureDetection: vi.fn().mockResolvedValue(undefined),
  // null = no conversation id, which is what a daemon too old to persist
  // one gives every launch. These tests are about which menu entries
  // appear, so the resume they exercise is the written-reconstruction
  // fallback rather than a reopened conversation.
  conversationIdForLaunch: vi.fn(() => null),
}));
vi.mock("./workspace", () => {
  const findSessionLocation = vi.fn();
  return {
    findSessionLocation,
    // Built on the SAME mock the tests drive, so "in a layout tree" and
    // "live" can never disagree about one session id in here.
    sessionLiveness: (
      state: {
        interruptedSessionIds?: ReadonlySet<string>;
        failureReasonById?: Record<string, string>;
      },
      sessionId: string
    ) => {
      const location = findSessionLocation(state, sessionId);
      if (!location) return "gone";
      // Same precedence as the real one: a failure is the newer fact and
      // the one with a resumable conversation behind it.
      if (state.failureReasonById?.[sessionId] !== undefined) return "failed";
      return state.interruptedSessionIds?.has(sessionId) ? "interrupted" : "live";
    },
  };
});

import * as backend from "./backend";
import { findSessionLocation } from "./workspace";
import { layoutState } from "./layoutState";
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
    o = addStep(addStage(o, railId, "s1"), "s1", "step-1", "/p/t.md", 0);
  }
  orchestrations.set({ "ws-1": o });
}

beforeEach(() => {
  vi.clearAllMocks();
  kanbanState.set({ "ws-1": board() });
  orchestrations.set({ "ws-1": emptyOrchestration() });
  layoutState.update((s) => ({
    ...s,
    interruptedSessionIds: new Set<string>(),
    failureReasonById: {},
  }));
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


  it("an unbound To Do card offers Develop, right above the two run entries", () => {
    const l = labels(buildCardMenuEntries(card("task", "To Do"), hooks()));
    expect(l).toContain("Develop into a plan…");
    // Reading order is the argument: develop the card, then run it.
    expect(l.indexOf("Develop into a plan…")).toBe(l.indexOf("Run in dedicated session") - 1);
  });

  it("Develop is To Do only — a started, finished or nested card is past developing", () => {
    for (const status of ["In Progress", "Done", "Shipped", null]) {
      const l = labels(buildCardMenuEntries(card("task", status), hooks()));
      expect(l.join(), `status ${status}`).not.toContain("Develop");
    }
    expect(labels(buildCardMenuEntries(card("note", "To Do"), hooks())).join()).not.toContain(
      "Develop"
    );
  });

  it("no Develop entry once a session is bound — live or exited", () => {
    kanbanState.set({
      "ws-1": board([{ path: "/p/t.md", sessionId: "s-1", cwd: "/p", command: null }]),
    });
    vi.mocked(findSessionLocation).mockReturnValue({ workspaceId: "ws-1", pageId: "pg" });
    expect(labels(buildCardMenuEntries(card("task", "To Do"), hooks())).join()).not.toContain(
      "Develop"
    );
    vi.mocked(findSessionLocation).mockReturnValue(null);
    expect(labels(buildCardMenuEntries(card("task", "To Do"), hooks())).join()).not.toContain(
      "Develop"
    );
  });

  it("picking Develop spawns the skill's agent and leaves the card's status alone", async () => {
    vi.mocked(backend.createSession).mockResolvedValue("s-9");
    const entries = buildCardMenuEntries(card("task", "To Do"), hooks());
    item(entries, "Develop into a plan…")?.onPick?.();
    await vi.waitFor(() => expect(backend.createSession).toHaveBeenCalled());

    const [cwd, command] = vi.mocked(backend.createSession).mock.calls[0];
    expect(cwd).toBe("/p");
    expect(command).toContain("Use the gavin-develop skill on the card at /p/t.md");
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
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

  // An interrupted binding is neither: the tab is there, so "Jump to
  // session" would land the human in a shell; and the run is dead, so
  // "Re-launch" would replay the original command from scratch.
  it("an interrupted binding offers Resume instead of Jump or Re-launch", () => {
    kanbanState.set({
      "ws-1": board([{ path: "/p/t.md", sessionId: "s-1", cwd: "/p", command: null }]),
    });
    vi.mocked(findSessionLocation).mockReturnValue({ workspaceId: "ws-1", pageId: "pg" });
    layoutState.update((s) => ({ ...s, interruptedSessionIds: new Set(["s-1"]) }));

    const entries = labels(buildCardMenuEntries(card("plan", null), hooks()));
    expect(entries).toContain("Resume — the agent was interrupted");
    expect(entries).not.toContain("Jump to session");
    expect(entries).not.toContain("Re-launch agent");
  });

  // The other way a bound session stops being somewhere worth jumping
  // to. Unlike an interrupted one the agent is still sitting at its
  // prompt, so "Jump to session" would present a broken run as work in
  // progress -- and unlike an interrupted one there is a conversation on
  // disk to reopen.
  it("a failed binding offers Resume instead of Jump or Re-launch", () => {
    kanbanState.set({
      "ws-1": board([{ path: "/p/t.md", sessionId: "s-1", cwd: "/p", command: null }]),
    });
    vi.mocked(findSessionLocation).mockReturnValue({ workspaceId: "ws-1", pageId: "pg" });
    layoutState.update((s) => ({
      ...s,
      failureReasonById: { "s-1": "API Error: 529 Overloaded." },
    }));

    const entries = labels(buildCardMenuEntries(card("plan", null), hooks()));
    expect(entries).toContain("Resume — the agent stopped because something broke");
    expect(entries).not.toContain("Jump to session");
    expect(entries).not.toContain("Re-launch agent");
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

  it("a board card offers Archive; an archived one offers the way back", () => {
    expect(labels(buildCardMenuEntries(card("plan", "Done"), hooks()))).toContain("Archive");
    const archived = card("task", "Done", { id: "/p/.gavin-root/plans/archive/t.md" });
    const l = labels(buildCardMenuEntries(archived, hooks()));
    expect(l).toContain("Restore from archive");
    expect(l).not.toContain("Archive");
  });

  it("Un-parent appears only for parented tasks", () => {
    expect(labels(buildCardMenuEntries(card("task", null, { parent: "p.md" }), hooks()))).toContain("Un-parent");
    expect(labels(buildCardMenuEntries(card("task", null), hooks()))).not.toContain("Un-parent");
    expect(labels(buildCardMenuEntries(card("plan", "To Do"), hooks()))).not.toContain("Un-parent");
  });
});
