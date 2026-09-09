import { describe, it, expect } from "vitest";
import { composeOrganizePrompt, composeRailPrompt } from "$lib/orchestration/orchestrationPrompts";
import { NAME_TAB_FIRST } from "$lib/cards/cardRun";
import type { CardEntry, Orchestration, Rail, ToolSummary } from "$lib/orchestration/orchestration";
import { emptyOrchestration } from "$lib/orchestration/orchestration";

function card(fileName: string, title: string, status: string | null = null): CardEntry {
  return {
    plan: {
      path: `/ws/.gavin-root/plans/${fileName}`,
      fileName,
      title,
      status,
      priority: null,
      order: null,
      kind: "task",
      parent: null,
      labels: [],
      checklistDone: 0,
      checklistTotal: 0,
      parseWarning: false,
    },
    contextFolder: "/ws/.gavin-root",
  };
}

function rail(id: string, name: string, stages: Array<Array<[string, string]>>): Rail {
  return {
    id,
    name,
    position: 0,
    worktreePath: null,
    pageId: null,
    stages: stages.map((steps, si) => ({
      id: `${id}-s${si}`,
      position: si,
      steps: steps.map(([stepId, cardPath], pi) => ({ id: stepId, position: pi, cardPath })),
    })),
  };
}

const CARDS = new Map<string, CardEntry>([
  ["/ws/.gavin-root/plans/a.md", card("a.md", "Fix login")],
  ["/ws/.gavin-root/plans/b.md", card("b.md", "Write tests")],
]);

const TOOLS: ToolSummary[] = [
  { id: "builtin:commit", name: "Commit changes", kind: "agent" },
];

function orchWith(rails: Rail[]): Orchestration {
  return { ...emptyOrchestration(), rails };
}

describe("composeOrganizePrompt", () => {
  const unplaced = [card("a.md", "Fix login", "To Do"), card("b.md", "Write tests")];

  it("names the skill and the job", () => {
    const p = composeOrganizePrompt(null, unplaced, []);
    expect(p).toContain("Use the gavin-orchestrate skill");
    expect(p).toContain("UNPLACED");
  });

  it("lists every unplaced card with its status and path", () => {
    const p = composeOrganizePrompt(null, unplaced, []);
    expect(p).toContain("2 cards nobody has placed yet:");
    expect(p).toContain("- Fix login (To Do) — /ws/.gavin-root/plans/a.md");
    // No status is said out loud rather than left blank.
    expect(p).toContain("- Write tests (no status) — /ws/.gavin-root/plans/b.md");
  });

  it("cuts a long backlog and says how many it cut", () => {
    const many = Array.from({ length: 34 }, (_, i) => card(`c${i}.md`, `Card ${i}`));
    const p = composeOrganizePrompt(null, many, []);
    expect(p).toContain("34 cards nobody has placed yet:");
    expect(p).toContain("- Card 29 (no status)");
    expect(p).not.toContain("- Card 30 (no status)");
    expect(p).toContain("- …and 4 more; the read payload lists them all.");
    // The instruction stays about EVERY unplaced card, not the listed ones.
    expect(p).toContain("Place every unplaced card the payload lists");
  });

  it("says so rather than inventing work when nothing is unplaced", () => {
    const p = composeOrganizePrompt(orchWith([rail("r1", "backend", [])]), [], []);
    expect(p).toContain("Nothing is unplaced right now");
  });

  it("summarises the rails the tab shows, with their bindings", () => {
    const r = { ...rail("r1", "backend", [[["t1", "/ws/.gavin-root/plans/a.md"]]]) };
    r.worktreePath = "/x/wt-a";
    r.branch = "feature/api";
    const p = composeOrganizePrompt(orchWith([r]), unplaced, []);
    expect(p).toContain("- backend (/x/wt-a, branch feature/api): 1 stage, 1 step");
  });

  it("tells the agent to create rails when there are none", () => {
    expect(composeOrganizePrompt(orchWith([]), unplaced, [])).toContain(
      "The tab has no rails yet — create them."
    );
    expect(composeOrganizePrompt(null, unplaced, [])).toContain("The tab has no rails yet");
  });

  it("carries gavin's own conflict lines, or says there are none", () => {
    expect(composeOrganizePrompt(null, unplaced, ["1. two steps share /x/wt-a"])).toContain(
      "Gavin currently flags:\n- 1. two steps share /x/wt-a"
    );
    expect(composeOrganizePrompt(null, unplaced, [])).toContain(
      "Gavin currently flags no conflicts."
    );
  });

  it("asks for the authoritative read and for tool fields to survive the rewrite", () => {
    const p = composeOrganizePrompt(null, unplaced, []);
    expect(p).toContain("Read gavin_get_orchestration");
    expect(p).toContain("toolId and toolParams");
  });

  // Pressing Organize IS the request to parallelize, so the prompt has to
  // say it: the skill's own parallelism rule leads with "when unsure,
  // serialize", and an agent reading only that half answers with one long
  // rail -- the arrangement the human already had.
  it("asks for parallelism, and for the isolation that makes it safe", () => {
    const p = composeOrganizePrompt(null, unplaced, []);
    expect(p).toContain("Organizing means parallelizing");
    expect(p).toContain("Prefer a new rail");
    // Named as work the agent DOES, not as a binding to leave the human:
    // an unbound rail is not isolation and a worktreePath nobody created
    // is a worktree-missing conflict.
    expect(p).toContain("create");
    expect(p).toContain("worktreePath and branch on the rail");
  });
});

describe("composeRailPrompt", () => {
  it("scopes the job to the one rail, by name", () => {
    const r = rail("r1", "backend", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const p = composeRailPrompt(orchWith([r]), r, CARDS, TOOLS, []);
    expect(p).toContain('reorganize the rail "backend" — that rail only');
    expect(p).toContain("send every OTHER rail back exactly as you read it");
  });

  it("lays out the stages in order, naming each step as the tab does", () => {
    const r = rail("r1", "backend", [
      [
        ["t1", "/ws/.gavin-root/plans/a.md"],
        ["t2", "/ws/.gavin-root/plans/b.md"],
      ],
      [["t3", ""]],
    ]);
    r.stages[1].steps[0].toolId = "builtin:commit";
    const p = composeRailPrompt(orchWith([r]), r, CARDS, TOOLS, []);
    expect(p).toContain("  stage 1 — Fix login, Write tests");
    expect(p).toContain("  stage 2 — Commit changes (tool)");
  });

  it("falls back to the raw identifier for a card or tool that is gone", () => {
    const r = rail("r1", "backend", [[["t1", "/ws/.gavin-root/plans/gone.md"]], [["t2", ""]]]);
    r.stages[1].steps[0].toolId = "deleted-tool";
    const p = composeRailPrompt(orchWith([r]), r, CARDS, TOOLS, []);
    expect(p).toContain("  stage 1 — /ws/.gavin-root/plans/gone.md");
    expect(p).toContain("  stage 2 — deleted-tool (tool)");
  });

  it("marks the steps that have run state, and only those", () => {
    const r = rail("r1", "backend", [
      [
        ["t1", "/ws/.gavin-root/plans/a.md"],
        ["t2", "/ws/.gavin-root/plans/b.md"],
      ],
    ]);
    const orch: Orchestration = {
      ...orchWith([r]),
      stepRuns: [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }],
    };
    const p = composeRailPrompt(orch, r, CARDS, TOOLS, []);
    expect(p).toContain("  stage 1 — Fix login [running], Write tests");
  });

  it("states the binding, worktree and branch alike", () => {
    const r = rail("r1", "backend", []);
    expect(composeRailPrompt(orchWith([r]), r, CARDS, TOOLS, [])).toContain(
      "It runs in no worktree and holds no steps yet"
    );
    r.worktreePath = "/x/wt-a";
    r.branch = "feature/api";
    expect(composeRailPrompt(orchWith([r]), r, CARDS, TOOLS, [])).toContain(
      "It runs in /x/wt-a, branch feature/api"
    );
  });

  it("carries only the conflicts it was handed, scoped to this rail", () => {
    const r = rail("r1", "backend", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    expect(composeRailPrompt(orchWith([r]), r, CARDS, TOOLS, ["2. r1 has no worktree"])).toContain(
      "Gavin currently flags on this rail:\n- 2. r1 has no worktree"
    );
    expect(composeRailPrompt(orchWith([r]), r, CARDS, TOOLS, [])).toContain(
      "Gavin currently flags no conflicts on this rail."
    );
  });
});

describe("both prompts", () => {
  it("open by telling the agent to name its own tab", () => {
    // They land in a session of their own now, so the tab is the human's
    // only handle on which of the two requests is in it.
    expect(composeOrganizePrompt(null, [], []).startsWith(NAME_TAB_FIRST)).toBe(true);
    expect(
      composeRailPrompt(emptyOrchestration(), rail("r1", "backend", []), new Map(), [], []).startsWith(
        NAME_TAB_FIRST
      )
    ).toBe(true);
  });
});
