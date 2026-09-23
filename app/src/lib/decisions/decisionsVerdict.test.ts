import { describe, it, expect } from "vitest";
import {
  REASON_LABEL,
  attentionInbox,
  type AttentionInboxInput,
  type AttentionState,
  type VerdictsBySession,
} from "$lib/agents/attentionInbox";
import { REASON_WORD } from "$lib/agents/nextWaiting";
import {
  decisionsList,
  subjectAgentLine,
  subjectWaits,
  type DecisionCard,
  type DecisionsInput,
} from "$lib/decisions/decisions";
import type { TurnVerdictEntry } from "$lib/agents/turnVerdict";
import type { Board } from "$lib/board/kanban";
import type { GavinContext, GavinTree, PlanFileInfo } from "$lib/core/gavin";
import type { LayoutNode } from "$lib/panes/layout";
import type { Page, Workspace } from "$lib/core/workspace";
import type { StepAttention } from "$lib/orchestration/orchestration";
import { allSources } from "$lib/sources";

// The prose questions the TypeSafe turn verdict catches, as this tab
// lists them.
//
// Two readings, and the failure each one is here to prevent.
//
// `asking` is a question with NO BELL behind it -- the agent asked in a
// sentence and the daemon calls the session idle. `attentionInbox`
// already knows that, but only when it is handed `verdicts`; a tab that
// forgot to pass them would draw a confident, complete, empty list. That
// one is guarded by reading the view's source, because the bug is a
// missing argument at one call site and there is nothing else to assert.
//
// `blocked` is the agent saying it gave up. Today that becomes a rail
// STALL and nothing else, so an agent with no rail behind it -- a card
// run from the board, a terminal the human opened -- says "I cannot do
// this" into a screen nobody is watching. Here it is a row, and the row
// carries the agent's own line, because "stopped without finishing" is
// not something a human can act on and the sentence under it is.

const NOW = 1_000_000_000;
const MINUTE = 60_000;
const WS = "ws-1";
const CARD = "/ws/.gavin-root/plans/card.md";

function leaf(tabs: string[]): LayoutNode {
  return { type: "leaf", tabs, activeTabIndex: 0 };
}

function page(id: string, tabs: string[]): Page {
  return { id, name: id, layout: leaf(tabs), focusedSessionId: null };
}

function workspace(sessionIds: string[]): Workspace {
  const pages = [page("p1", sessionIds)];
  return { id: WS, name: "WS", pages, activePageId: "p1" };
}

function state(sessionIds: string[], overrides: Partial<AttentionState> = {}): AttentionState {
  return {
    workspaces: [workspace(sessionIds)],
    activeWorkspaceId: WS,
    // Idle is the whole point: a blocked agent has STOPPED, so the
    // daemon reports the same status it reports for a shell at its
    // prompt. Only the verdict tells the two apart.
    sessionStatusById: Object.fromEntries(sessionIds.map((id) => [id, "idle"])),
    fileTabsById: {},
    cardTabsById: {},
    boardTabsById: {},
    interruptedSessionIds: new Set(),
    sessionNames: {},
    cwdBySessionId: {},
    failureReasonById: {},
    statusSinceById: Object.fromEntries(
      sessionIds.map((id, n) => [id, { at: NOW - (n + 1) * 5 * MINUTE, watched: true }])
    ),
    ...overrides,
  };
}

function verdicts(entries: Record<string, TurnVerdictEntry>): VerdictsBySession {
  return new Map(Object.entries(entries));
}

function blocked(said: string): TurnVerdictEntry {
  return { state: "read", reading: { kind: "blocked", said } };
}

function asking(): TurnVerdictEntry {
  return { state: "read", reading: { kind: "asking" } };
}

function inboxInput(
  st: AttentionState,
  overrides: Partial<AttentionInboxInput> = {}
): AttentionInboxInput {
  return { state: st, boards: {}, trees: {}, orchestrations: {}, ...overrides };
}

function planCard(overrides: Partial<PlanFileInfo> = {}): PlanFileInfo {
  return {
    path: CARD,
    fileName: "card.md",
    title: "The card",
    status: "In Progress",
    priority: null,
    order: null,
    kind: "task",
    parent: null,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
    humanItems: [],
    ...overrides,
  };
}

function treeWith(plan: PlanFileInfo): GavinTree {
  const ctx: GavinContext = {
    folderPath: "/ws/.gavin-root",
    kind: "root",
    name: "ws",
    plans: [plan],
    docs: [],
    specs: [],
    hasPrd: false,
    configWarning: false,
  };
  return { rootPath: "/ws", rootMissing: false, contexts: [ctx] };
}

function boardWith(path: string, sessionId: string): Board {
  return {
    columns: [{ id: "c0", name: "In Progress", position: 0 }],
    labels: [],
    cardSessions: [{ path, sessionId, cwd: "/ws", command: null }],
  };
}

function cards(plan: PlanFileInfo): Map<string, DecisionCard> {
  return new Map([[plan.path, { plan, contextFolder: "/ws/.gavin-root" }]]);
}

function decisions(overrides: Partial<DecisionsInput> = {}): DecisionsInput {
  return {
    workspaceId: WS,
    cards: new Map(),
    bindings: new Map(),
    inbox: [],
    rails: [],
    marks: new Map<string, StepAttention>(),
    ...overrides,
  };
}

describe("a blocked agent with no rail behind it", () => {
  it("is a row in the inbox this tab builds, and is not one in the hub's", () => {
    const st = state(["s1"]);
    const v = verdicts({ s1: blocked("the migration needs a password I do not have") });

    const hub = attentionInbox(inboxInput(st, { verdicts: v }), NOW);
    expect(hub).toEqual([]);

    const tab = attentionInbox(inboxInput(st, { verdicts: v, includeBlocked: true }), NOW);
    expect(tab.map((r) => r.reason)).toEqual(["blocked"]);
  });

  it("carries the agent's own line, which is the half a human can act on", () => {
    const said = "the migration needs a password I do not have";
    const rows = attentionInbox(
      inboxInput(state(["s1"]), { verdicts: verdicts({ s1: blocked(said) }), includeBlocked: true }),
      NOW
    );
    expect(rows[0].failureReason).toBe(said);

    const list = decisionsList(decisions({ inbox: rows }));
    expect(list.subjects.map((s) => s.kind)).toEqual(["session"]);
    expect(subjectAgentLine(list.subjects[0])).toBe(said);
    // The label says what happened; the line says what to do about it.
    // A row that only had the label would be worth nothing here.
    expect(REASON_LABEL.blocked).not.toContain(said);
    expect(subjectWaits(list.subjects[0])).toBe(true);
  });

  // `agentLastLine` genuinely answers "" for a screen with no prose on
  // it, and the agent stopped either way -- so the row stays and only
  // its quotation goes.
  it("is still a row when gavin could not read a line off the screen", () => {
    const rows = attentionInbox(
      inboxInput(state(["s1"]), { verdicts: verdicts({ s1: blocked("  ") }), includeBlocked: true }),
      NOW
    );
    expect(rows.map((r) => r.reason)).toEqual(["blocked"]);
    expect(rows[0].failureReason).toBeNull();
    const list = decisionsList(decisions({ inbox: rows }));
    expect(subjectAgentLine(list.subjects[0])).toBeNull();
  });

  // The tab's whole shape: the subject is the CARD wherever there is
  // one. A blocked agent behind a card is that card's row, carrying the
  // reason -- not a second row beside it.
  it("folds into its card's row rather than standing beside it", () => {
    const plan = planCard();
    const rows = attentionInbox(
      inboxInput(state(["s1"]), {
        boards: { [WS]: boardWith(CARD, "s1") },
        trees: { [WS]: treeWith(plan) },
        verdicts: verdicts({ s1: blocked("the spec contradicts the card") }),
        includeBlocked: true,
      }),
      NOW
    );
    expect(rows[0].cardPath).toBe(CARD);

    const list = decisionsList(
      decisions({ cards: cards(plan), bindings: new Map([[CARD, "s1"]]), inbox: rows })
    );
    expect(list.subjects).toHaveLength(1);
    const subject = list.subjects[0];
    expect(subject.kind).toBe("card");
    if (subject.kind !== "card") throw new Error("expected a card subject");
    expect(subject.reason).toBe("blocked");
    expect(subjectAgentLine(subject)).toBe("the spec contradicts the card");
    expect(list.summary.waiting).toBe(1);
  });

  // Every other reading is somebody else's business: `finished` and
  // `working` are not waits at all, and `failed` already has a row of
  // its own off the session's status.
  it("is not produced for a verdict that is not blocked, nor for a busy session", () => {
    const quiet = attentionInbox(
      inboxInput(state(["s1"]), {
        verdicts: verdicts({ s1: { state: "read", reading: { kind: "finished" } } }),
        includeBlocked: true,
      }),
      NOW
    );
    expect(quiet).toEqual([]);

    const pending = attentionInbox(
      inboxInput(state(["s1"]), { verdicts: verdicts({ s1: { state: "pending" } }), includeBlocked: true }),
      NOW
    );
    expect(pending).toEqual([]);

    const working = attentionInbox(
      inboxInput(state(["s1"], { sessionStatusById: { s1: "working" } }), {
        verdicts: verdicts({ s1: blocked("gave up") }),
        includeBlocked: true,
      }),
      NOW
    );
    expect(working).toEqual([]);
  });

  // An interrupted session's status describes the bare shell that
  // replaced the agent, and its verdict is about a turn that is over.
  it("is not produced for an interrupted session", () => {
    const rows = attentionInbox(
      inboxInput(state(["s1"], { interruptedSessionIds: new Set(["s1"]) }), {
        verdicts: verdicts({ s1: blocked("gave up") }),
        includeBlocked: true,
      }),
      NOW
    );
    expect(rows).toEqual([]);
  });

  it("has a word of its own in every table keyed by reason", () => {
    expect(REASON_LABEL.blocked).toBeTruthy();
    expect(REASON_LABEL.blocked).not.toBe(REASON_LABEL.stale);
    expect(REASON_WORD.blocked).toBeTruthy();
    expect(REASON_WORD.blocked.length).toBeLessThan(REASON_LABEL.blocked.length);
  });
});

describe("a prose question with no bell behind it", () => {
  it("is a row here exactly as it is in the hub, off the verdict alone", () => {
    const st = state(["s1"]);
    const v = verdicts({ s1: asking() });
    // Without the verdicts the session is idle and nothing else: this is
    // the empty list a tab that forgot to pass them would draw.
    expect(attentionInbox(inboxInput(st), NOW)).toEqual([]);
    const rows = attentionInbox(inboxInput(st, { verdicts: v, includeBlocked: true }), NOW);
    expect(rows.map((r) => r.reason)).toEqual(["asking"]);
    const list = decisionsList(decisions({ inbox: rows }));
    expect(list.summary.waiting).toBe(1);
  });
});

describe("the tab's own call", () => {
  const VIEW = allSources()["DecisionsHubView.svelte"];

  it("hands attentionInbox the verdicts, the way AppHubView does", () => {
    expect(VIEW).toBeTruthy();
    expect(VIEW).toContain("verdicts: verdictsOf($turnVerdictById)");
    expect(allSources()["AppHubView.svelte"]).toContain("verdicts: verdictsOf($turnVerdictById)");
  });

  // The statuses carry no verdict at all, so a call that read them
  // instead would be the silent version of passing nothing.
  it("does not read the raw session statuses for it", () => {
    expect(VIEW).not.toContain("sessionStatusById");
  });

  it("asks for the blocked rows, which no other surface does", () => {
    expect(VIEW).toContain("includeBlocked: true");
    expect(allSources()["AppHubView.svelte"]).not.toContain("includeBlocked");
    expect(allSources()["nextWaiting.ts"]).not.toContain("includeBlocked");
  });

  it("draws the agent's line under the label rather than leaving it in a tooltip", () => {
    expect(VIEW).toContain("subjectAgentLine(subject)");
  });
});
