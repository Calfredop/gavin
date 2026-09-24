import { describe, it, expect } from "vitest";
import {
  GATE_FALLBACK_LABEL,
  NOTHING_WAITING,
  NO_SESSION_REASON,
  answerOutcome,
  answerRefusal,
  answerText,
  decisionsList,
  decisionsSummary,
  decisionsWaiting,
  failAndCloseConfirm,
  failAndCloseOutcome,
  failOutcome,
  failRefusal,
  humanItemPending,
  humanItemWaiting,
  notifyMessage,
  notifySkipped,
  orderSubjects,
  passOutcome,
  pendingItems,
  resolveSelection,
  subjectDetail,
  subjectId,
  subjectTitle,
  subjectWaits,
  summaryLine,
  type CardSubject,
  type DecisionCard,
  type DecisionSubject,
  type DecisionsInput,
} from "$lib/decisions/decisions";
import type { AttentionRow } from "$lib/agents/attentionInbox";
import type { HumanItem, HumanItemState, PlanFileInfo } from "$lib/core/gavin";
import type { Rail, StepAttention } from "$lib/orchestration/orchestration";

// The Decisions tab's list, its ordering and its payloads.
//
// The failures worth pinning here are all about a row that should NOT
// exist, or a row that should be ONE row: a card and its asking agent
// listed twice is the whole shape of the tab getting away from us, and a
// card counted as waiting on the human when the only thing on it is a
// failure the AGENT owes puts a number on the tab that no amount of
// answering can bring down.

const MINUTE = 60_000;
const CARD = "/ws/.gavin-root/plans/card.md";
const OTHER = "/ws/.gavin-root/plans/other.md";

function item(overrides: Partial<HumanItem> = {}): HumanItem {
  const kind = overrides.kind ?? "decision";
  const text = overrides.text ?? "Which serializer?";
  return {
    kind,
    text,
    done: false,
    options: [],
    latest: null,
    state: "open",
    lineText: `${kind === "decision" ? "Decision" : "Human test"}: ${text}`,
    lineIndex: 12,
    ...overrides,
  };
}

function planCard(fileName: string, items: HumanItem[], overrides: Partial<PlanFileInfo> = {}): PlanFileInfo {
  return {
    path: `/ws/.gavin-root/plans/${fileName}`,
    fileName,
    title: fileName.replace(/\.md$/, ""),
    status: "In Progress",
    priority: null,
    order: null,
    kind: "task",
    parent: null,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
    humanItems: items,
    ...overrides,
  };
}

function cards(...plans: PlanFileInfo[]): Map<string, DecisionCard> {
  return new Map(plans.map((plan) => [plan.path, { plan, contextFolder: "/ws/.gavin-root" }]));
}

function row(overrides: Partial<AttentionRow> = {}): AttentionRow {
  return {
    sessionId: "s1",
    workspaceId: "ws-1",
    workspaceName: "WS",
    pageId: "p1",
    pageName: "Work",
    tabName: "claude",
    reason: "asking",
    cardTitle: null,
    cardPath: null,
    cardWorkspaceId: null,
    waitedMs: 5 * MINUTE,
    watched: true,
    failureReason: null,
    ...overrides,
  };
}

function railWith(steps: Array<{ id: string; cardPath?: string; toolId?: string }>): Rail {
  return {
    id: "r1",
    name: "backend",
    position: 0,
    worktreePath: null,
    pageId: null,
    stages: [
      {
        id: "g1",
        position: 0,
        steps: steps.map((s, position) => ({
          id: s.id,
          position,
          cardPath: s.cardPath ?? "",
          toolId: s.toolId ?? null,
        })),
      },
    ],
  };
}

function input(overrides: Partial<DecisionsInput> = {}): DecisionsInput {
  return {
    workspaceId: "ws-1",
    cards: new Map(),
    bindings: new Map(),
    inbox: [],
    rails: [],
    marks: new Map<string, StepAttention>(),
    ...overrides,
  };
}

describe("which items belong on a card's row", () => {
  it("lists an open one and a failed test, and drops everything settled", () => {
    expect(humanItemPending(item())).toBe(true);
    expect(humanItemPending(item({ kind: "test", state: "failed" }))).toBe(true);
    expect(humanItemPending(item({ state: "answered", done: true }))).toBe(false);
    expect(humanItemPending(item({ kind: "test", state: "passed", done: true }))).toBe(false);
  });

  // The checkbox is the one half a human can have changed by hand, so it
  // wins: an item ticked in the editor is settled whatever its last
  // result line says.
  it("takes a ticked box as settled even where the result line says open", () => {
    expect(humanItemPending(item({ done: true, state: "open" }))).toBe(false);
  });

  // The distinction the whole waiting count rests on.
  it("counts a failed test as owed by the agent and not as waiting on you", () => {
    const failed = item({ kind: "test", state: "failed" });
    expect(humanItemPending(failed)).toBe(true);
    expect(humanItemWaiting(failed)).toBe(false);
    expect(humanItemWaiting(item())).toBe(true);
  });

  it("keeps a card's items in file order rather than by state", () => {
    const plan = planCard("card.md", [
      item({ text: "second", lineIndex: 9 }),
      item({ text: "first", lineIndex: 4 }),
    ]);
    expect(pendingItems(plan).map((i) => i.text)).toEqual(["first", "second"]);
  });

  // The `attachments`/`modifiedAt` pattern: absent is UNKNOWN, and a
  // card whose daemon never parsed the lines must not read as a card
  // that asks nothing... which is exactly what it produces here, and
  // why the version gate below is the only thing that can tell them
  // apart.
  it("reads an absent humanItems as no items rather than throwing", () => {
    expect(pendingItems(planCard("card.md", [], { humanItems: undefined }))).toEqual([]);
    expect(pendingItems(planCard("card.md", [], { humanItems: null }))).toEqual([]);
  });
});

describe("the list", () => {
  it("puts a card with open items on it, with its items", () => {
    const list = decisionsList(input({ cards: cards(planCard("card.md", [item()])) }));
    expect(list.subjects).toHaveLength(1);
    const subject = list.subjects[0] as CardSubject;
    expect(subject.kind).toBe("card");
    expect(subject.id).toBe(subjectId("card", CARD));
    expect(subject.items.map((i) => i.text)).toEqual(["Which serializer?"]);
    expect(subject.reason).toBeNull();
  });

  it("leaves out a card whose items are all settled", () => {
    const list = decisionsList(
      input({ cards: cards(planCard("card.md", [item({ state: "answered", done: true })])) })
    );
    expect(list.subjects).toEqual([]);
  });

  // THE rule of the tab: the human's next move is the same move either
  // way -- read this card -- so a card and the agent asking about it are
  // one errand.
  it("is ONE row for a card with items whose session is also asking", () => {
    const list = decisionsList(
      input({
        cards: cards(planCard("card.md", [item()])),
        bindings: new Map([[CARD, "s1"]]),
        inbox: [row({ sessionId: "s1", cardPath: CARD, cardWorkspaceId: "ws-1" })],
      })
    );
    expect(list.subjects).toHaveLength(1);
    const subject = list.subjects[0] as CardSubject;
    expect(subject.reason).toBe("asking");
    expect(subject.sessionId).toBe("s1");
    expect(subject.waitedMs).toBe(5 * MINUTE);
  });

  // A card can be waiting without having written anything down: its
  // agent simply asked. The row is still the card's, because that is
  // what the human is being asked about.
  it("gives a waiting session's card a row even when the card asks nothing", () => {
    const list = decisionsList(
      input({
        cards: cards(planCard("card.md", [])),
        bindings: new Map([[CARD, "s1"]]),
        inbox: [row({ cardPath: CARD, cardWorkspaceId: "ws-1" })],
      })
    );
    expect(list.subjects).toHaveLength(1);
    expect(list.subjects[0].kind).toBe("card");
    expect(subjectDetail(list.subjects[0])).toBe("this card's agent");
  });

  it("lists a waiting session with no card as a session of its own", () => {
    const list = decisionsList(input({ inbox: [row({ sessionId: "s9" })] }));
    expect(list.subjects).toHaveLength(1);
    expect(list.subjects[0].kind).toBe("session");
    expect(list.subjects[0].id).toBe(subjectId("session", "s9"));
  });

  // nextWaiting.ts's narrowing, reused: the row belongs to the workspace
  // whose page holds the TAB, because that is where a click on it lands.
  it("drops a waiting session whose tab is in another workspace", () => {
    const list = decisionsList(input({ inbox: [row({ workspaceId: "ws-2" })] }));
    expect(list.subjects).toEqual([]);
  });

  // ...and the other half of that rule: a card filed HERE whose agent's
  // tab was dragged elsewhere still has to say its agent is asking, so
  // the reason is looked up in the unnarrowed inbox by session id.
  it("still reads the reason for a card whose agent's tab moved workspaces", () => {
    const list = decisionsList(
      input({
        cards: cards(planCard("card.md", [item()])),
        bindings: new Map([[CARD, "s1"]]),
        inbox: [row({ sessionId: "s1", workspaceId: "ws-2", cardPath: CARD, cardWorkspaceId: "ws-1" })],
      })
    );
    expect(list.subjects).toHaveLength(1);
    expect((list.subjects[0] as CardSubject).reason).toBe("asking");
  });

  // A session waiting on a card this workspace's tree does not hold is
  // not a card row here -- there is nothing to draw items for -- so it
  // stays a session row rather than vanishing.
  it("keeps a session row for a card outside this tree", () => {
    const list = decisionsList(input({ inbox: [row({ cardPath: "/elsewhere/x.md" })] }));
    expect(list.subjects.map((s) => s.kind)).toEqual(["session"]);
  });

  it("lists a rail review gate, named after its tool", () => {
    const list = decisionsList(
      input({
        rails: [railWith([{ id: "st1", toolId: "tool-review" }])],
        marks: new Map<string, StepAttention>([["st1", "review"]]),
        tools: [{ id: "tool-review", name: "Human review" }],
      })
    );
    expect(list.subjects).toHaveLength(1);
    expect(subjectTitle(list.subjects[0])).toBe("Human review");
    expect(subjectDetail(list.subjects[0])).toBe("backend · review gate");
  });

  it("falls back to a sentence when the tool library has not loaded", () => {
    const list = decisionsList(
      input({
        rails: [railWith([{ id: "st1", toolId: "tool-review" }])],
        marks: new Map<string, StepAttention>([["st1", "review"]]),
      })
    );
    expect(subjectTitle(list.subjects[0])).toBe(GATE_FALLBACK_LABEL);
  });

  it("lists an unreviewed step under its card's title", () => {
    const list = decisionsList(
      input({
        cards: cards(planCard("other.md", [])),
        rails: [railWith([{ id: "st2", cardPath: OTHER }])],
        marks: new Map<string, StepAttention>([["st2", "unreviewed"]]),
      })
    );
    expect(list.subjects.map((s) => s.kind)).toEqual(["unreviewed"]);
    expect(subjectTitle(list.subjects[0])).toBe("other");
    expect(list.subjects[0].id).toBe(subjectId("unreviewed", "st2"));
  });

  // Every other mark stepAttentions produces describes a SESSION, and
  // those reach this list through the inbox under their card. Reading
  // them here too would list the same wait twice.
  it("reads only review and unreviewed off the rail marks", () => {
    const list = decisionsList(
      input({
        rails: [railWith([{ id: "st1", cardPath: CARD }])],
        marks: new Map<string, StepAttention>([["st1", "turn-ended"]]),
      })
    );
    expect(list.subjects).toEqual([]);
  });
});

describe("the version gate", () => {
  // The failure this exists to prevent: a v41 daemon never PARSED the
  // item lines, and reading that silence as "no card asks anything"
  // would report an empty workspace with a dozen open decisions in it.
  it("shows no card rows at all, and carries the reason out", () => {
    const list = decisionsList(
      input({
        cards: cards(planCard("card.md", [item()])),
        itemsBlockedReason: "Needs daemon v42; the running daemon is v41.",
      })
    );
    expect(list.subjects).toEqual([]);
    expect(list.itemsBlockedReason).toBe("Needs daemon v42; the running daemon is v41.");
  });

  it("still lists the sessions and gates an older daemon can see", () => {
    const list = decisionsList(
      input({
        cards: cards(planCard("card.md", [item()])),
        inbox: [row({ sessionId: "s9" })],
        rails: [railWith([{ id: "st1", toolId: "t" }])],
        marks: new Map<string, StepAttention>([["st1", "review"]]),
        itemsBlockedReason: "Needs daemon v42.",
      })
    );
    expect(list.subjects.map((s) => s.kind)).toEqual(["session", "gate"]);
  });

  // A card whose AGENT is waiting is still a card row, and its items are
  // empty rather than unknown-and-drawn: the row exists because of the
  // session, which an older daemon reports perfectly well.
  it("keeps a waiting card row with no items when the gate is on", () => {
    const list = decisionsList(
      input({
        cards: cards(planCard("card.md", [item()])),
        bindings: new Map([[CARD, "s1"]]),
        inbox: [row({ cardPath: CARD, cardWorkspaceId: "ws-1" })],
        itemsBlockedReason: "Needs daemon v42.",
      })
    );
    expect(list.subjects.map((s) => s.kind)).toEqual(["card"]);
    expect((list.subjects[0] as CardSubject).items).toEqual([]);
  });
});

describe("the order", () => {
  function subject(id: string, waitedMs: number | null): DecisionSubject {
    return {
      kind: "session",
      id,
      row: row({ sessionId: id, waitedMs }),
      waitedMs,
      watched: true,
    };
  }

  it("is longest wait first", () => {
    const ordered = orderSubjects([subject("a", MINUTE), subject("b", 9 * MINUTE)]);
    expect(ordered.map((s) => s.id)).toEqual(["b", "a"]);
  });

  // attentionInbox's own rule, and it matters more here: two of the four
  // kinds can never have a wait at all, so giving "no number" the top
  // would put the rows this list knows least about above every question
  // an agent actually asked.
  it("sorts an unmeasured wait last rather than as a fresh one", () => {
    const ordered = orderSubjects([subject("none", null), subject("fresh", 1)]);
    expect(ordered.map((s) => s.id)).toEqual(["fresh", "none"]);
  });

  it("breaks a tie by kind and then by title, so the list does not shuffle", () => {
    const list = decisionsList(
      input({
        cards: cards(planCard("card.md", [item()])),
        rails: [railWith([{ id: "st1", toolId: "t" }])],
        marks: new Map<string, StepAttention>([["st1", "review"]]),
        inbox: [row({ sessionId: "s9", waitedMs: null })],
      })
    );
    // The card has no measured wait either, so all three are tied on the
    // number and KIND_RANK decides: card, session, gate.
    expect(list.subjects.map((s) => s.kind)).toEqual(["card", "session", "gate"]);
  });
});

describe("the two counts", () => {
  it("counts a card with an open item as waiting on you", () => {
    const list = decisionsList(input({ cards: cards(planCard("card.md", [item()])) }));
    expect(list.summary).toEqual({ waiting: 1, failedTests: 0 });
    expect(decisionsWaiting(list.summary)).toBe(true);
  });

  // The whole reason the two counts are kept apart: a failed test is
  // owed by the AGENT, and counting it as waiting on you would put a
  // number on the tab that answering cannot bring down.
  it("counts a card whose only item is a failed test apart, and does not light the tab", () => {
    const list = decisionsList(
      input({ cards: cards(planCard("card.md", [item({ kind: "test", state: "failed" })])) })
    );
    expect(list.summary).toEqual({ waiting: 0, failedTests: 1 });
    expect(decisionsWaiting(list.summary)).toBe(false);
    expect(subjectWaits(list.subjects[0])).toBe(false);
  });

  it("counts a card with both as waiting, and still names the failure", () => {
    const list = decisionsList(
      input({
        cards: cards(
          planCard("card.md", [item(), item({ kind: "test", state: "failed", lineIndex: 14 })])
        ),
      })
    );
    expect(list.summary).toEqual({ waiting: 1, failedTests: 1 });
  });

  // A card row with no items at all is one whose agent is waiting, which
  // IS the human's move.
  it("counts a card whose agent is waiting even with no items", () => {
    const list = decisionsList(
      input({
        cards: cards(planCard("card.md", [])),
        bindings: new Map([[CARD, "s1"]]),
        inbox: [row({ cardPath: CARD, cardWorkspaceId: "ws-1" })],
      })
    );
    expect(list.summary.waiting).toBe(1);
  });

  it("counts every gate, session and unreviewed card as waiting", () => {
    const subjects: DecisionSubject[] = [
      { kind: "session", id: "s", row: row(), waitedMs: 1, watched: true },
      {
        kind: "gate",
        id: "g",
        railId: "r1",
        railName: "backend",
        stepId: "st1",
        label: "Review",
        waitedMs: null,
        watched: false,
      },
      {
        kind: "unreviewed",
        id: "u",
        railId: "r1",
        railName: "backend",
        stepId: "st2",
        cardPath: OTHER,
        title: "other",
        waitedMs: null,
        watched: false,
      },
    ];
    expect(decisionsSummary(subjects)).toEqual({ waiting: 3, failedTests: 0 });
  });

  it("says both halves in one line, and nothing at all for an empty list", () => {
    expect(summaryLine({ waiting: 2, failedTests: 1 })).toBe(
      "2 waiting on you · 1 failed test, with the agent"
    );
    expect(summaryLine({ waiting: 1, failedTests: 0 })).toBe("1 waiting on you");
    expect(summaryLine({ waiting: 0, failedTests: 0 })).toBeNull();
    expect(NOTHING_WAITING).toMatch(/Nothing/);
  });
});

describe("the selection", () => {
  const subjects: DecisionSubject[] = [
    { kind: "session", id: "a", row: row({ sessionId: "a" }), waitedMs: 2, watched: true },
    { kind: "session", id: "b", row: row({ sessionId: "b" }), waitedMs: 1, watched: true },
  ];

  it("keeps a selection the list still holds", () => {
    expect(resolveSelection(subjects, "b")).toBe("b");
  });

  // Rows leave as they are answered, so a stored id routinely points at
  // nothing -- and an empty pane beside a list with plenty in it is the
  // failure this prevents.
  it("falls back to the longest wait when the selection has gone", () => {
    expect(resolveSelection(subjects, "gone")).toBe("a");
    expect(resolveSelection(subjects, null)).toBe("a");
  });

  it("answers null for an empty list", () => {
    expect(resolveSelection([], "a")).toBeNull();
  });
});

describe("what an answer sends", () => {
  it("refuses an answer with neither an option nor a note", () => {
    expect(answerRefusal(null, "   ")).toMatch(/Pick an option or write an answer/);
    expect(answerRefusal("serde", "")).toBeNull();
    expect(answerRefusal(null, "serde")).toBeNull();
  });

  // Both halves, when there are both: the option is the choice and the
  // note is the why, and a card recording only one of them loses the
  // half the next agent needs.
  it("writes the option and the note together", () => {
    expect(answerText("serde", "one dep, already in")).toBe("serde — one dep, already in");
    expect(answerText("serde", "")).toBe("serde");
    expect(answerText(null, "  roll our own  ")).toBe("roll our own");
  });

  it("builds the four outcomes the wire takes", () => {
    expect(answerOutcome("serde", "")).toEqual({ kind: "answer", text: "serde" });
    expect(passOutcome()).toEqual({ kind: "pass" });
    expect(failOutcome("  the installer hung  ")).toEqual({
      kind: "fail",
      note: "the installer hung",
    });
    expect(failAndCloseOutcome("not worth it")).toEqual({
      kind: "failAndClose",
      note: "not worth it",
    });
  });

  // A note is required to fail and not to pass, because a failure is a
  // handover: the agent's only instruction is this line.
  it("requires a note to fail", () => {
    expect(failRefusal("  ")).toMatch(/Say what went wrong/);
    expect(failRefusal("the installer hung")).toBeNull();
  });

  // "Fail and close" is the one action in the tab that ENDS something,
  // and it is asked through the app's own prompt -- there are no native
  // dialogs here.
  it("asks before closing a test for good, keeping focus off the confirm", () => {
    const ask = failAndCloseConfirm(item({ kind: "test", text: "the installer runs" }));
    expect(ask.title).toContain("the installer runs");
    expect(ask.confirmLabel).toBe("Fail and close");
    expect(ask.cancelLabel).not.toBe("OK");
    expect(ask.danger).toBe(true);
    expect(ask.lines.join(" ")).toMatch(/re-arm/);
  });
});

describe("what the agent is told", () => {
  const decision = item({ text: "Which serializer?" });
  const test = item({ kind: "test", text: "the installer runs" });

  it("names the card and points at the line rather than standing in for it", () => {
    const message = notifyMessage(CARD, decision, answerOutcome("serde", ""));
    expect(message).toContain(CARD);
    expect(message).toContain("Which serializer?");
    expect(message).toContain("serde");
    expect(message).toMatch(/Read the item's line on the card/);
  });

  it("names the next move for a plain failure and refuses one for a closed test", () => {
    const failed = notifyMessage(CARD, test, failOutcome("the installer hung"));
    expect(failed).toMatch(/back with you/);
    expect(failed).toContain("gavin_request_human");
    const closed = notifyMessage(CARD, test, failAndCloseOutcome("not worth it"));
    expect(closed).toMatch(/Do not re-file/);
    expect(closed).not.toContain("gavin_request_human");
  });

  it("says nothing about a next move for a pass", () => {
    expect(notifyMessage(CARD, test, passOutcome())).toContain("It passed.");
  });

  // The human pressed a button expecting the agent to hear it, so a
  // message that was never sent has to be said out loud rather than
  // silently not happening.
  it("says why nothing was queued", () => {
    expect(notifySkipped(NO_SESSION_REASON)).toMatch(/^Answered on the card\./);
    expect(notifySkipped(NO_SESSION_REASON)).toContain("nothing has run this card");
  });
});

describe("what a row calls itself", () => {
  it("counts a card's decisions and tests apart", () => {
    const list = decisionsList(
      input({
        cards: cards(
          planCard("card.md", [
            item(),
            item({ text: "or this?", lineIndex: 13 }),
            item({ kind: "test", text: "the installer runs", lineIndex: 15 }),
          ])
        ),
      })
    );
    expect(subjectDetail(list.subjects[0])).toBe("2 decisions · 1 human test");
  });

  it("falls back to a card's file name when its title is blank", () => {
    const list = decisionsList(
      input({ cards: cards(planCard("card.md", [item()], { title: "   " })) })
    );
    expect(subjectTitle(list.subjects[0])).toBe("card.md");
  });

  it("prefixes every id by kind, so a step id cannot collide with a path", () => {
    expect(subjectId("card", CARD)).toBe(`card:${CARD}`);
    expect(subjectId("gate", "st1")).toBe("gate:st1");
  });
});

describe("every HumanItemState is accounted for", () => {
  // A new state on the wire must not fall through into "pending" by
  // accident: the tab would draw answer controls for something already
  // settled.
  const STATES: HumanItemState[] = ["open", "answered", "passed", "failed"];
  it("treats exactly open and failed as still owed", () => {
    const owed = STATES.filter((state) => humanItemPending(item({ state })));
    expect(owed).toEqual(["open", "failed"]);
  });
});
