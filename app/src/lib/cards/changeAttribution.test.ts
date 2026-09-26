import { describe, it, expect } from "vitest";
import {
  ATTRIBUTION_INSTRUCTIONS,
  ATTRIBUTION_MIN_CONFIDENCE,
  DESCRIPTION_MAX_CHARS,
  EXCERPT_MAX_CHANGED_LINES,
  EXCERPT_MAX_CHARS,
  MAX_CO_TENANTS,
  MAX_FILES_PER_RUN,
  NONE_CRITERION,
  UNATTRIBUTED,
  attributionPlan,
  attributionRequest,
  cardDescription,
  coTenants,
  diffExcerpt,
  excerptSkipReason,
  foreignFiles,
  foreignLine,
  parseAttributionAnswer,
  readAttribution,
  type AttributedRun,
  type RunAttribution,
} from "$lib/cards/changeAttribution";
import { TYPESAFE_MODEL } from "$lib/agents/turnVerdict";
import type { CardSession } from "$lib/board/kanban";
import type { FileDiff, FileEntry, Hunk } from "$lib/git/git";

const BASE = "1111111111111111111111111111111111111111";
const LATER = "2222222222222222222222222222222222222222";
const OLDER = "0000000000000000000000000000000000000000";

const SELF = "/ws/.gavin-root/plans/self.md";
const PEER_A = "/ws/.gavin-root/plans/peer-a.md";
const PEER_B = "/ws/.gavin-root/plans/peer-b.md";

function binding(path: string, over: Partial<CardSession> = {}): CardSession {
  return { path, sessionId: `s-${path}`, cwd: "/repo", command: null, launchCwd: "/repo", baseSha: BASE, ...over };
}

function run(over: Partial<AttributedRun> = {}): AttributedRun {
  return { cardPath: SELF, root: "/repo", baseSha: BASE, laterBaselines: [], ...over };
}

function hunk(lines: { kind: "add" | "del" | "context"; text: string }[], over: Partial<Hunk> = {}): Hunk {
  return { header: "@@ -1,3 +1,4 @@", oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines, ...over };
}

function diff(hunks: Hunk[], over: Partial<FileDiff> = {}): FileDiff {
  return { path: "a.ts", binary: false, tooLarge: false, hunks, ...over };
}

const identity = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const reversed = (n: number): number[] => identity(n).reverse();

describe("coTenants", () => {
  it("is every other card run in the same checkout, itself excluded", () => {
    const peers = coTenants(run(), [binding(SELF), binding(PEER_A), binding(PEER_B)]);
    expect(peers.map((p) => p.path)).toEqual([PEER_A, PEER_B]);
  });

  it("is empty for a lone run in its own worktree, so nothing is asked", () => {
    const peers = coTenants(run({ root: "/repo-wt" }), [
      binding(SELF, { launchCwd: "/repo-wt" }),
      binding(PEER_A, { launchCwd: "/repo" }),
    ]);
    expect(peers).toEqual([]);
  });

  it("matches a peer launched deeper in the same tree, and not one in a sibling folder", () => {
    const peers = coTenants(run(), [
      binding(PEER_A, { launchCwd: "/repo/app" }),
      binding(PEER_B, { launchCwd: "/repo-other" }),
    ]);
    expect(peers.map((p) => p.path)).toEqual([PEER_A]);
  });

  it("does not count a run in a nested .gavin-worktrees checkout as a tenant of this one", () => {
    // Deeper in the same TREE, but another checkout: gavin cuts its
    // worktrees inside the workspace, and their edits never reach this
    // checkout's diff.
    const peers = coTenants(run(), [
      binding(PEER_A, { launchCwd: "/repo/.gavin-worktrees/feat-x" }),
      binding(PEER_B, { launchCwd: "/repo/app/.gavin-worktrees/feat-y/src" }),
    ]);
    expect(peers).toEqual([]);
  });

  it("still sees the tenants of a nested worktree from a run rooted in it", () => {
    const peers = coTenants(run({ root: "/repo/.gavin-worktrees/feat-x" }), [
      binding(PEER_A, { launchCwd: "/repo/.gavin-worktrees/feat-x/app" }),
      binding(PEER_B, { launchCwd: "/repo" }),
    ]);
    expect(peers.map((p) => p.path)).toEqual([PEER_A]);
  });

  it("reads Windows paths the way git reports them", () => {
    const peers = coTenants(run({ root: "C:/Users/me/repo" }), [
      binding(PEER_A, { launchCwd: "C:\\Users\\me\\repo\\app" }),
      binding(PEER_B, { launchCwd: "c:\\users\\ME\\repo" }),
    ]);
    expect(peers.map((p) => p.path)).toEqual([PEER_A, PEER_B]);
  });

  it("falls back to cwd for a binding that predates launchCwd", () => {
    const peers = coTenants(run(), [binding(PEER_A, { launchCwd: undefined, cwd: "/repo" })]);
    expect(peers.map((p) => p.path)).toEqual([PEER_A]);
  });

  it("leaves out a run launched after this one's window was bounded", () => {
    // `laterBaselines` is what runchanges.rs found to descend from this
    // baseline: runs whose work a bounded window never contains. A peer
    // launched from the SAME commit, or an older one, is still mixed in.
    const peers = coTenants(run({ laterBaselines: [LATER] }), [
      binding(PEER_A, { baseSha: LATER }),
      binding(PEER_B, { baseSha: OLDER }),
    ]);
    expect(peers.map((p) => p.path)).toEqual([PEER_B]);
  });

  it("puts the peers launched from the same commit first and caps the list", () => {
    const many = Array.from({ length: MAX_CO_TENANTS + 3 }, (_, i) =>
      binding(`/ws/.gavin-root/plans/older-${i}.md`, { baseSha: OLDER })
    );
    const same = binding(PEER_A, { baseSha: BASE });
    const peers = coTenants(run(), [...many, same]);
    expect(peers).toHaveLength(MAX_CO_TENANTS);
    expect(peers[0].path).toBe(PEER_A);
  });

  it("ignores a binding with no baseline at all", () => {
    expect(coTenants(run(), [binding(PEER_A, { baseSha: null })])).toEqual([]);
  });
});

describe("cardDescription", () => {
  it("drops the frontmatter and clears the ticks", () => {
    const body = "---\ntitle: T\nstatus: Done\n---\nIntro.\n\n- [x] first\n- [X] second\n- [ ] third\n";
    expect(cardDescription(body)).toBe("Intro.\n\n- [ ] first\n- [ ] second\n- [ ] third");
  });

  it("cuts at the first after-the-fact heading", () => {
    const body = "Plan text.\n\n- [ ] step\n\n## What landed\n\nEverything, described after the fact.\n";
    expect(cardDescription(body)).toBe("Plan text.\n\n- [ ] step");
    expect(cardDescription("Intro\n\n### The fix\n\nleaked")).toBe("Intro");
    expect(cardDescription("Intro\n\n## Results\n\nleaked")).toBe("Intro");
  });

  it("keeps a heading that describes the plan rather than the outcome", () => {
    expect(cardDescription("## Goal\n\nShip it.")).toBe("## Goal\n\nShip it.");
  });

  it(`is at most ${DESCRIPTION_MAX_CHARS} characters`, () => {
    const long = "word ".repeat(400);
    expect(cardDescription(long).length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS);
    expect(cardDescription(long).startsWith("word word")).toBe(true);
  });
});

describe("excerptSkipReason", () => {
  it("skips lockfiles and images, in code, before any diff is read", () => {
    expect(excerptSkipReason("app/package-lock.json")).not.toBeNull();
    expect(excerptSkipReason("Cargo.lock")).not.toBeNull();
    expect(excerptSkipReason("yarn.lock")).not.toBeNull();
    expect(excerptSkipReason("pnpm-lock.yaml")).not.toBeNull();
    expect(excerptSkipReason("docs/shot.PNG")).not.toBeNull();
    expect(excerptSkipReason("app/static/icon.svg")).not.toBeNull();
  });

  it("asks about ordinary source, docs and cards", () => {
    expect(excerptSkipReason("app/src/lib/cards/runChanges.ts")).toBeNull();
    expect(excerptSkipReason("crates/daemon/src/server.rs")).toBeNull();
    expect(excerptSkipReason(".gavin-root/plans/x.md")).toBeNull();
    expect(excerptSkipReason("app/package.json")).toBeNull();
  });
});

describe("diffExcerpt", () => {
  it("renders hunks as a unified diff with no file headers", () => {
    const text = diffExcerpt(
      diff([
        hunk([
          { kind: "context", text: "a" },
          { kind: "del", text: "b" },
          { kind: "add", text: "B" },
          { kind: "add", text: "C" },
        ]),
      ])
    );
    expect(text).toBe("@@ -1,3 +1,4 @@\n a\n-b\n+B\n+C");
    expect(text).not.toContain("diff --git");
    expect(text).not.toContain("+++");
  });

  it("is null for a binary, an oversized and an empty diff", () => {
    expect(diffExcerpt(diff([], { binary: true }))).toBeNull();
    expect(diffExcerpt(diff([], { tooLarge: true }))).toBeNull();
    expect(diffExcerpt(diff([]))).toBeNull();
  });

  it(`stops after ${EXCERPT_MAX_CHANGED_LINES} changed lines, on a line boundary`, () => {
    const lines = Array.from({ length: 200 }, (_, i) => ({ kind: "add" as const, text: `line ${i}` }));
    const text = diffExcerpt(diff([hunk(lines)]))!;
    const changed = text.split("\n").filter((l) => l.startsWith("+") || l.startsWith("-"));
    expect(changed).toHaveLength(EXCERPT_MAX_CHANGED_LINES);
    expect(text.endsWith(`+line ${EXCERPT_MAX_CHANGED_LINES - 1}`)).toBe(true);
  });

  it(`stops at ${EXCERPT_MAX_CHARS} characters, on a line boundary`, () => {
    const lines = Array.from({ length: 60 }, (_, i) => ({ kind: "add" as const, text: `${i} ` + "x".repeat(100) }));
    const text = diffExcerpt(diff([hunk(lines)]))!;
    expect(text.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS);
    for (const line of text.split("\n").slice(1)) expect(line.endsWith("x")).toBe(true);
  });

  it("context lines do not count against the changed-line budget", () => {
    const lines = [
      ...Array.from({ length: 100 }, (_, i) => ({ kind: "context" as const, text: `c${i}` })),
      { kind: "add" as const, text: "the change" },
    ];
    expect(diffExcerpt(diff([hunk(lines)]))).toContain("+the change");
  });
});

describe("attributionRequest", () => {
  const options = [
    { path: SELF, title: "Self card", description: "what self does" },
    { path: PEER_A, title: "Peer A", description: "" },
    { path: PEER_B, title: "Peer B", description: "b's plan" },
  ];

  it("is the E4 question, verbatim, over one change", () => {
    const { request } = attributionRequest({ path: "a.ts", diff: "+x" }, options, identity);
    expect(request.model).toBe(TYPESAFE_MODEL);
    expect(request.model).toBe("jev-1.13.0");
    expect(request.state).toEqual({ change: { path: "a.ts", diff: "+x" } });
    expect(request.questions.owner.type).toBe("choice");
    expect(request.questions.owner.instructions).toBe(ATTRIBUTION_INSTRUCTIONS);
    expect(ATTRIBUTION_INSTRUCTIONS).toBe(
      "`change` is one modified file from a git working tree in which several tasks are being worked on at the same time. Each option describes one of those tasks. Which task is this change part of?"
    );
    expect(request.questions.owner.criteria.none).toBe(NONE_CRITERION);
    expect(NONE_CRITERION).toBe("The change is not part of any of these tasks.");
  });

  it("names the options neutrally and carries a description only where the card has one", () => {
    const { request, cardByKey } = attributionRequest({ path: "a.ts", diff: "+x" }, options, identity);
    expect(request.questions.owner.criteria).toEqual({
      task_a: { title: "Self card", description: "what self does" },
      task_b: { title: "Peer A" },
      task_c: { title: "Peer B", description: "b's plan" },
      none: NONE_CRITERION,
    });
    expect(cardByKey).toEqual({ task_a: SELF, task_b: PEER_A, task_c: PEER_B });
    // Nothing that would let the model read the card's file name or the
    // run's identity off the key.
    expect(Object.keys(request.questions.owner.criteria).join(" ")).not.toContain("self");
  });

  it("shuffles which key each card gets, per request", () => {
    const { request, cardByKey } = attributionRequest({ path: "a.ts", diff: "+x" }, options, reversed);
    expect(cardByKey).toEqual({ task_a: PEER_B, task_b: PEER_A, task_c: SELF });
    expect(request.questions.owner.criteria.task_a).toEqual({ title: "Peer B", description: "b's plan" });
  });

  it("shuffles by default", () => {
    // Over many draws the identity order cannot be the only one seen.
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      seen.add(JSON.stringify(attributionRequest({ path: "a.ts", diff: "+x" }, options).cardByKey));
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("parseAttributionAnswer", () => {
  const cardByKey = { task_a: SELF, task_b: PEER_A };

  it("maps the chosen key back to its card", () => {
    const answer = parseAttributionAnswer(
      { answers: { owner: { choice: "task_b", confidence: 0.91 } } },
      cardByKey
    );
    expect(answer).toEqual({ card: PEER_A, confidence: 0.91 });
  });

  it("reads none as nobody's, with its confidence kept", () => {
    expect(
      parseAttributionAnswer({ answers: { owner: { choice: "none", confidence: 0.8 } } }, cardByKey)
    ).toEqual({ card: null, confidence: 0.8 });
  });

  it("refuses a key it never issued, a missing confidence and a body it cannot read", () => {
    expect(
      parseAttributionAnswer({ answers: { owner: { choice: "task_z", confidence: 0.9 } } }, cardByKey)
    ).toBeNull();
    expect(parseAttributionAnswer({ answers: { owner: { choice: "task_a" } } }, cardByKey)).toBeNull();
    expect(parseAttributionAnswer({ answers: {} }, cardByKey)).toBeNull();
    expect(parseAttributionAnswer(null, cardByKey)).toBeNull();
    expect(parseAttributionAnswer("nope", cardByKey)).toBeNull();
  });
});

describe("readAttribution", () => {
  const titles = new Map([
    [SELF, "Self card"],
    [PEER_A, "Peer A"],
  ]);

  it("names the card at or above the floor", () => {
    expect(readAttribution({ card: PEER_A, confidence: ATTRIBUTION_MIN_CONFIDENCE }, titles)).toEqual({
      kind: "card",
      card: PEER_A,
      title: "Peer A",
      confidence: ATTRIBUTION_MIN_CONFIDENCE,
    });
    expect(ATTRIBUTION_MIN_CONFIDENCE).toBe(0.75);
  });

  it("leaves a low-confidence verdict unattributed -- today's answer", () => {
    expect(readAttribution({ card: PEER_A, confidence: 0.74 }, titles)).toEqual(UNATTRIBUTED);
  });

  it("leaves a foreign file -- none -- unattributed, however sure", () => {
    expect(readAttribution({ card: null, confidence: 0.99 }, titles)).toEqual(UNATTRIBUTED);
  });

  it("leaves a failed or unreadable answer unattributed", () => {
    expect(readAttribution(null, titles)).toEqual(UNATTRIBUTED);
  });

  it("leaves a card whose title it no longer knows unattributed", () => {
    expect(readAttribution({ card: PEER_B, confidence: 0.9 }, titles)).toEqual(UNATTRIBUTED);
  });
});

describe("attributionPlan", () => {
  const files: FileEntry[] = [
    { path: "a.ts", status: "M" },
    { path: "package-lock.json", status: "M" },
    { path: "new.ts", status: "?" },
  ];

  it("asks nothing for a run with no co-tenant", () => {
    const plan = attributionPlan(run(), [binding(SELF)], files);
    expect(plan.ask).toBe(false);
    expect(!plan.ask && plan.reason).toMatch(/no other card/i);
  });

  it("asks about every file it can excerpt, skips the rest in code", () => {
    const plan = attributionPlan(run(), [binding(SELF), binding(PEER_A)], files);
    expect(plan.ask).toBe(true);
    if (!plan.ask) return;
    expect(plan.peers.map((p) => p.path)).toEqual([PEER_A]);
    expect(plan.files.map((f) => f.path)).toEqual(["a.ts", "new.ts"]);
  });

  it(`asks about at most ${MAX_FILES_PER_RUN} files`, () => {
    const many = Array.from({ length: MAX_FILES_PER_RUN + 20 }, (_, i) => ({
      path: `f${i}.ts`,
      status: "M" as const,
    }));
    const plan = attributionPlan(run(), [binding(SELF), binding(PEER_A)], many);
    expect(plan.ask && plan.files).toHaveLength(MAX_FILES_PER_RUN);
  });

  it("asks nothing when no file survives the skip list", () => {
    const plan = attributionPlan(run(), [binding(SELF), binding(PEER_A)], [{ path: "Cargo.lock", status: "M" }]);
    expect(plan.ask).toBe(false);
  });
});

describe("foreignFiles", () => {
  const attribution: RunAttribution = {
    "a.ts": { kind: "card", card: PEER_A, title: "Peer A", confidence: 0.9 },
    "b.ts": { kind: "card", card: PEER_A, title: "Peer A", confidence: 0.8 },
    "c.ts": { kind: "card", card: PEER_B, title: "Peer B", confidence: 0.8 },
    "mine.ts": { kind: "card", card: SELF, title: "Self card", confidence: 0.95 },
    "loose.ts": UNATTRIBUTED,
  };

  it("groups the files that look like another card's by that card, biggest first", () => {
    expect(foreignFiles(attribution, SELF)).toEqual([
      { card: PEER_A, title: "Peer A", paths: ["a.ts", "b.ts"] },
      { card: PEER_B, title: "Peer B", paths: ["c.ts"] },
    ]);
  });

  it("is empty with no attribution at all", () => {
    expect(foreignFiles(null, SELF)).toEqual([]);
    expect(foreignFiles(undefined, SELF)).toEqual([]);
  });

  it("writes the discard prompt's line for one card", () => {
    expect(foreignLine({ card: PEER_A, title: "Peer A", paths: ["a.ts", "b.ts", "c.ts"] })).toBe(
      "3 of these look like Peer A's work: a.ts, b.ts, c.ts"
    );
    expect(foreignLine({ card: PEER_A, title: "Peer A", paths: ["a.ts"] })).toBe(
      "1 of these looks like Peer A's work: a.ts"
    );
  });

  it("names at most eight files and counts the rest", () => {
    const paths = Array.from({ length: 11 }, (_, i) => `f${i}.ts`);
    const line = foreignLine({ card: PEER_A, title: "Peer A", paths });
    expect(line).toContain("f7.ts, and 3 more");
    expect(line).not.toContain("f8.ts");
  });
});
