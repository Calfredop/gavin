import { describe, it, expect } from "vitest";
import {
  ATTENTION_API_VERSION,
  buildAttentionAnswer,
  humanTestsOnPlan,
  stoppedRailsIn,
} from "$lib/companion/attentionAnswer";
import type { AttentionRow } from "$lib/agents/attentionInbox";
import type { PlanFileInfo } from "$lib/core/gavin";
import type { Orchestration, Rail } from "$lib/orchestration/orchestration";

function row(overrides: Partial<AttentionRow> & Pick<AttentionRow, "sessionId" | "reason">): AttentionRow {
  return {
    workspaceId: "ws-1",
    workspaceName: "WS",
    pageId: "p1",
    pageName: "Agents",
    tabName: "agent",
    cardTitle: null,
    cardPath: null,
    cardWorkspaceId: null,
    waitedMs: 60_000,
    watched: true,
    failureReason: null,
    ...overrides,
  };
}

describe("buildAttentionAnswer", () => {
  it("is empty when nothing is waiting", () => {
    expect(buildAttentionAnswer({ inbox: [] })).toEqual({
      version: ATTENTION_API_VERSION,
      items: [],
    });
  });

  it("maps an asking inbox row to a waiting item targeting the session", () => {
    const answer = buildAttentionAnswer({
      inbox: [row({ sessionId: "s1", reason: "asking", tabName: "login" })],
    });
    expect(answer.items).toEqual([
      {
        id: "waiting:s1",
        workspace: "ws-1",
        kind: "waiting",
        text: "login — Waiting for you",
        target: { kind: "session", id: "s1" },
      },
    ]);
  });

  it("maps a failed inbox row to a failed item, preferring the card target", () => {
    const answer = buildAttentionAnswer({
      inbox: [
        row({
          sessionId: "s2",
          reason: "failed",
          cardTitle: "Wire the API",
          cardPath: "/ws/.gavin-root/plans/wire.md",
          failureReason: "exited 1",
        }),
      ],
    });
    expect(answer.items[0]).toMatchObject({
      id: "failed:s2",
      kind: "failed",
      text: "Wire the API",
      target: { kind: "card", path: "/ws/.gavin-root/plans/wire.md" },
    });
  });

  it("folds a quiet verdict asking into waiting via the inbox row", () => {
    // The verdict is already folded by attentionInbox into reason
    // "asking"; this module must not re-derive it — only carry it.
    const answer = buildAttentionAnswer({
      inbox: [row({ sessionId: "s3", reason: "asking", tabName: "verdict-ask" })],
    });
    expect(answer.items[0].kind).toBe("waiting");
    expect(answer.items[0].id).toBe("waiting:s3");
  });

  it("adds open human tests as their own kind", () => {
    const answer = buildAttentionAnswer({
      inbox: [],
      humanTests: [
        {
          workspaceId: "ws-1",
          cardPath: "/ws/.gavin-root/plans/a.md",
          lineIndex: 12,
          text: "tap the QR on a real phone",
        },
      ],
    });
    expect(answer.items).toEqual([
      {
        id: "human-test:/ws/.gavin-root/plans/a.md:12",
        workspace: "ws-1",
        kind: "human-test",
        text: "tap the QR on a real phone",
        target: { kind: "card", path: "/ws/.gavin-root/plans/a.md" },
      },
    ]);
  });

  it("adds interrupted agents the inbox skipped", () => {
    const answer = buildAttentionAnswer({
      inbox: [],
      interrupted: [{ workspaceId: "ws-1", sessionId: "s9", text: "Auth rewrite" }],
    });
    expect(answer.items[0]).toEqual({
      id: "interrupted:s9",
      workspace: "ws-1",
      kind: "interrupted",
      text: "Auth rewrite",
      target: { kind: "session", id: "s9" },
    });
  });

  it("adds a stopped rail with the target the caller supplies", () => {
    const answer = buildAttentionAnswer({
      inbox: [],
      stoppedRails: [
        {
          workspaceId: "ws-1",
          railId: "r1",
          name: "Ship it",
          target: { kind: "card", path: "/ws/.gavin-root/plans/ship.md" },
        },
      ],
    });
    expect(answer.items[0]).toEqual({
      id: "rail-stopped:r1",
      workspace: "ws-1",
      kind: "rail-stopped",
      text: "Ship it",
      target: { kind: "card", path: "/ws/.gavin-root/plans/ship.md" },
    });
  });
});

describe("humanTestsOnPlan", () => {
  it("keeps only open Human test items", () => {
    const plan: PlanFileInfo = {
      path: "/ws/.gavin-root/plans/a.md",
      fileName: "a.md",
      title: "A",
      status: "In Progress",
      priority: null,
      order: null,
      kind: "plan",
      parent: null,
      labels: [],
      checklistDone: 0,
      checklistTotal: 2,
      parseWarning: false,
      humanItems: [
        {
          kind: "test",
          text: "check the QR",
          done: false,
          options: [],
          latest: null,
          state: "open",
          lineText: "Human test: check the QR",
          lineIndex: 4,
        },
        {
          kind: "decision",
          text: "which approach?",
          done: false,
          options: ["A", "B"],
          latest: null,
          state: "open",
          lineText: "Decision: which approach?",
          lineIndex: 6,
        },
        {
          kind: "test",
          text: "already passed",
          done: true,
          options: [],
          latest: "Result: passed",
          state: "passed",
          lineText: "Human test: already passed",
          lineIndex: 8,
        },
      ],
    };
    expect(humanTestsOnPlan("ws-1", plan)).toEqual([
      {
        workspaceId: "ws-1",
        cardPath: "/ws/.gavin-root/plans/a.md",
        lineIndex: 4,
        text: "check the QR",
      },
    ]);
  });
});

describe("stoppedRailsIn", () => {
  it("lists paused rails and skips ones with no target", () => {
    const rail = (id: string, name: string): Rail =>
      ({
        id,
        name,
        position: 0,
        worktreePath: null,
        pageId: null,
        stages: [],
      }) as unknown as Rail;
    const orch: Orchestration = {
      rails: [rail("r1", "Paused"), rail("r2", "Running"), rail("r3", "No target")],
      conflictNotes: [],
      railRuns: [
        { railId: "r1", state: "paused", currentStageId: null },
        { railId: "r2", state: "running", currentStageId: "st" },
      ],
      stepRuns: [],
    };
    const got = stoppedRailsIn("ws-1", orch, (r) =>
      r.id === "r3" ? null : { kind: "card", path: `/plans/${r.id}.md` }
    );
    expect(got).toEqual([
      {
        workspaceId: "ws-1",
        railId: "r1",
        name: "Paused",
        target: { kind: "card", path: "/plans/r1.md" },
      },
    ]);
  });
});
