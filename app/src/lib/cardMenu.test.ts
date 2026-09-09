import { describe, it, expect, vi, beforeEach } from "vitest";
import { get, writable } from "svelte/store";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("$lib/dialog", () => ({
  askConfirm: vi.fn(),
  askConfirmChecked: vi.fn(),
}));
vi.mock("$lib/backend", () => ({
  setPlanFrontmatterField: vi.fn(),
  getBoard: vi.fn(),
  createSession: vi.fn(),
  readFileForViewer: vi.fn(),
  linkCardSession: vi.fn(),
  unlinkCardSession: vi.fn(),
  getOrchestration: vi.fn(),
  setOrchestration: vi.fn().mockResolvedValue(undefined),
  openPathExternally: vi.fn().mockResolvedValue(undefined),
}));
/// Hoisted so the `vi.mock` factory below (which is hoisted above every
/// import) can close over it, and so `resolvedAgentFor` and
/// `agentForCard` can be the same function object.
const agentMock = vi.hoisted(() =>
  vi.fn(() => ({
    profileId: "claude-code",
    label: "Claude Code",
    file: "CLAUDE.md",
    command: "claude",
    launchCommand: "claude",
    mcpSupported: true,
    failurePatterns: ["API Error:"],
    failureCauses: [
      { pattern: "/login", cause: "auth" },
      { pattern: "Connection dropped", cause: "network" },
    ],
    sessionIdArgs: "--session-id",
    resumeArgs: "--resume",
    promptArgs: "",
  }))
);
vi.mock("$lib/layoutState", () => ({
  layoutState: writable({
    workspaces: [],
    sessionStatusById: {},
    sessionNames: {},
    cwdBySessionId: {},
    interruptedSessionIds: new Set<string>(),
    failureReasonById: {},
  }),
  setDevelopingCards: vi.fn().mockResolvedValue(undefined),
  // null = "not connected yet", which featureBlockedReason reads as "do
  // not pre-emptively grey anything out" -- so the archive entry is live
  // in these tests without pinning a daemon version.
  daemonCompat: writable(null),
  switchWorkspaceView: vi.fn().mockResolvedValue(undefined),
  switchToSessionInPage: vi.fn().mockResolvedValue(undefined),
  handleAgentSessionSpawned: vi.fn(),
  setSessionName: vi.fn().mockResolvedValue(undefined),
  resolvedAgentFor: agentMock,
  // The SAME function object, deliberately: no fixture in here carries a
  // level or an `agent:`/`model:` line, so the card's own resolver lands
  // on the workspace's agent exactly as the workspace resolver does.
  // Owed by this file because the menu LAUNCHES -- Run and Develop both
  // resolve through `agentForCard` -- and a missing export here is an
  // unmocked-import throw at the click, not a wrong agent.
  agentForCard: agentMock,
  armFailureDetection: vi.fn().mockResolvedValue(undefined),
  // null = no conversation id, which is what a daemon too old to persist
  // one gives every launch. These tests are about which menu entries
  // appear, so the resume they exercise is the written-reconstruction
  // fallback rather than a reopened conversation.
  conversationIdForLaunch: vi.fn(() => null),
}));
// The review flow owns its own suite; here it only has to be reachable
// from the menu, so the request function is the seam.
vi.mock("$lib/codeReviewActions", () => ({
  requestCardReview: vi.fn().mockResolvedValue(null),
}));
// The first-Run review's interactive half owns its own suite too; Develop
// only needs it reachable, not driven, so it is pre-approved here.
vi.mock("$lib/cardReviewActions", () => ({
  ensureCardReviewed: vi.fn().mockResolvedValue(true),
}));
vi.mock("$lib/workspace", () => {
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

import * as backend from "$lib/backend";
import { askConfirmChecked } from "$lib/dialog";
import { findSessionLocation } from "$lib/workspace";
import { requestCardReview } from "$lib/codeReviewActions";
import { layoutState } from "$lib/layoutState";
import { kanbanState } from "$lib/kanbanState";
import { orchestrations } from "$lib/orchestrationState";
import { emptyOrchestration, addRail, addStage, addStep } from "$lib/orchestration";
import { buildCardMenuEntries, type CardMenuHooks } from "$lib/cardMenu";
import { bestOfNRequest, bestOfNRuns } from "$lib/bestOfNState";
import { isMenuItem, type ContextMenuItem } from "$lib/contextMenu";
import type { CardView } from "$lib/planBoard";
import type { Board } from "$lib/kanban";

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

function hooks(over: Partial<CardMenuHooks> = {}): CardMenuHooks {
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
    ...over,
  };
}

function labels(entries: ReturnType<typeof buildCardMenuEntries>): string[] {
  return entries.filter(isMenuItem).map((e) => e.label);
}

function board(cardSessions: Board["cardSessions"] = []): Board {
  return { columns: [], labels: [], cardSessions };
}

function item(entries: ReturnType<typeof buildCardMenuEntries>, label: string): ContextMenuItem | undefined {
  return entries.find((e): e is ContextMenuItem => isMenuItem(e) && e.label === label);
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
  bestOfNRuns.set({});
  bestOfNRequest.set(null);
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
  // The menu's "Move to Done" is the same write the board's drag makes,
  // so it owes the human the same warning (cardCompletion.ts).
  describe("Move to, on a plan carrying nested tasks", () => {
    const withChild = () =>
      card("plan", "To Do", {
        nestedChildren: [card("task", null, { id: "/p/lens.md", title: "Tree lens", fileName: "lens.md", parent: "t.md" })],
      });
    function pick(entries: ReturnType<typeof buildCardMenuEntries>, label: string): void {
      const entry = entries.find((e): e is ContextMenuItem => isMenuItem(e) && e.label === label);
      entry?.onPick?.();
    }

    beforeEach(() => {
      vi.mocked(askConfirmChecked).mockReset();
      vi.mocked(backend.setPlanFrontmatterField).mockReset();
      vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p: string) => p);
    });

    it("asks first, and does not file the plan when the human cancels", async () => {
      vi.mocked(askConfirmChecked).mockResolvedValue({ confirmed: false, checked: false });
      pick(buildCardMenuEntries(withChild(), hooks()), "Move to Done");
      await vi.waitFor(() => expect(askConfirmChecked).toHaveBeenCalled());
      expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
    });

    it("asks nothing on a move that is not into the done column", async () => {
      pick(buildCardMenuEntries(card("plan", "Done", { nestedChildren: withChild().nestedChildren }), hooks()), "Move to To Do");
      await vi.waitFor(() =>
        expect(backend.setPlanFrontmatterField).toHaveBeenCalledWith("/p/t.md", "status", "To Do")
      );
      expect(askConfirmChecked).not.toHaveBeenCalled();
    });
  });

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
      (e): e is ContextMenuItem => isMenuItem(e) && e.label === "Send to workspace agent"
    );
    expect(send?.disabled).toBe(true); // no main agent in these hooks
    const current = entries.find(
      (e): e is ContextMenuItem => isMenuItem(e) && e.label === "Move to To Do"
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

  it("offers Review with agent on runnable cards, never on a note", () => {
    for (const kind of ["task", "plan"] as const) {
      expect(labels(buildCardMenuEntries(card(kind, "To Do"), hooks()))).toContain(
        "Review with agent…"
      );
    }
    expect(labels(buildCardMenuEntries(card("note", "To Do"), hooks()))).not.toContain(
      "Review with agent…"
    );
  });

  // A card is worth reviewing BECAUSE work happened on it, so the entry
  // has to survive the states that replace the run entries with a jump.
  it("offers Review with agent whatever the binding state", () => {
    kanbanState.set({
      "ws-1": board([{ path: "/p/t.md", sessionId: "s-1", cwd: "/p", command: null }]),
    });
    vi.mocked(findSessionLocation).mockReturnValue({ workspaceId: "ws-1", pageId: "pg" });
    const live = labels(buildCardMenuEntries(card("task", "In Progress"), hooks()));
    expect(live).toContain("Jump to session");
    expect(live).toContain("Review with agent…");
    vi.mocked(findSessionLocation).mockReturnValue(null);
    const exited = labels(buildCardMenuEntries(card("task", "In Progress"), hooks()));
    expect(exited).toContain("Re-launch agent");
    expect(exited).toContain("Review with agent…");
  });

  it("picking Review hands the card to the review flow and reports a refusal", async () => {
    vi.mocked(requestCardReview).mockResolvedValue("nope");
    const errors: string[] = [];
    const c = card("plan", "Done");
    const entries = buildCardMenuEntries(c, hooks({ reportError: (m) => errors.push(m) }));
    item(entries, "Review with agent…")?.onPick?.();
    await vi.waitFor(() => expect(errors).toEqual(["nope"]));
    expect(requestCardReview).toHaveBeenCalledWith("ws-1", c);
  });

  it("picking Develop spawns the skill's agent and leaves the card's status alone", async () => {
    vi.mocked(backend.createSession).mockResolvedValue("s-9");
    // Develop's review sheet reads the card file now (sec-fix-develop-run-
    // review); this suite is about menu entries, not that gate, so it is
    // handed a plain file rather than driven.
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\nkind: task\ntitle: T\nstatus: To Do\n---\nDevelop this.\n",
      truncated: false,
      exists: true,
    });
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

describe("best-of-N entries", () => {
  it("offers a run on several agents beside the ordinary Run", () => {
    const l = labels(buildCardMenuEntries(card("task", "To Do"), hooks()));
    expect(l).toContain("Run on several agents…");
    expect(l.indexOf("Run on several agents…")).toBe(l.indexOf("Run in dedicated session") + 1);
  });

  it("asks the app-level dialog for it rather than running anything itself", () => {
    // Three surfaces build this menu; the dialog is mounted once, in
    // +page.svelte, and this store is how they reach it.
    const c = card("task", "To Do");
    const entries = buildCardMenuEntries(c, hooks());
    item(entries, "Run on several agents…")?.onPick();
    expect(get(bestOfNRequest)).toEqual({ workspaceId: "ws-1", card: c });
  });

  it("never offers it for a note", () => {
    expect(labels(buildCardMenuEntries(card("note", "To Do"), hooks())).join()).not.toContain("several agents");
  });

  it("replaces every run action with a pick while a run is in flight", () => {
    // The candidates are not bound to the card, so without this the menu
    // would offer to start a SECOND run over the top of the first.
    bestOfNRuns.set({
      "ws-1": [
        {
          cardPath: "/p/t.md",
          cardTitle: "T",
          pageId: "pg",
          startedAt: 0,
          candidates: [
            { sessionId: "a", label: "A", profileId: "claude-code", model: "", branch: "b1", worktreePath: "/w1", command: "", conversationId: null },
            { sessionId: "b", label: "B", profileId: "codex", model: "", branch: "b2", worktreePath: "/w2", command: "", conversationId: null },
          ],
        },
      ],
    });
    const l = labels(buildCardMenuEntries(card("plan", "In Progress"), hooks()));
    expect(l).toContain("Best of 2 — pick a candidate…");
    expect(l).not.toContain("Run in dedicated session");
    expect(l).not.toContain("Run on several agents…");
  });

  it("sends the pick to the card detail, where the run's panel lives", () => {
    bestOfNRuns.set({
      "ws-1": [
        {
          cardPath: "/p/t.md",
          cardTitle: "T",
          pageId: "pg",
          startedAt: 0,
          candidates: [
            { sessionId: "a", label: "A", profileId: "claude-code", model: "", branch: "b1", worktreePath: "/w1", command: "", conversationId: null },
          ],
        },
      ],
    });
    const h = hooks();
    const entries = buildCardMenuEntries(card("plan", "In Progress"), h);
    item(entries, "Best of 1 — pick a candidate…")?.onPick();
    expect(h.openDetail).toHaveBeenCalledWith("/p/t.md");
  });
});
