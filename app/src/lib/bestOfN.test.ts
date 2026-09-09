import { describe, it, expect } from "vitest";
import {
  abandonConfirm,
  candidateAgentConfig,
  candidateLabel,
  candidateSlug,
  candidatesError,
  forkBase,
  composeCandidatePrompt,
  discardBranchesLabel,
  losersOf,
  pickConfirm,
  planCandidates,
  runPageName,
  seedCandidates,
  type BestOfNRun,
  type RunCandidate,
} from "$lib/bestOfN";

const LABELS = new Map([
  ["claude-code", "Claude Code"],
  ["codex", "Codex CLI"],
]);

function runCandidate(over: Partial<RunCandidate> = {}): RunCandidate {
  return {
    sessionId: "s1",
    label: "Claude Code",
    profileId: "claude-code",
    model: "",
    branch: "auth-claude-code",
    worktreePath: "/repos/gavin-auth-claude-code",
    command: "claude 'do it'",
    conversationId: null,
    ...over,
  };
}

describe("naming a candidate", () => {
  it("shows profile and model together, since a run varies one or the other", () => {
    expect(candidateLabel("Claude Code", "sonnet")).toBe("Claude Code · sonnet");
    expect(candidateLabel("Claude Code", "  ")).toBe("Claude Code");
  });

  it("slugs a model alias into something git will accept as a ref", () => {
    // A dot-and-slash alias is the case that would otherwise produce a
    // branch git refuses -- or worse, one it accepts and nobody meant.
    expect(candidateSlug({ profileId: "codex", model: "gpt-5.1" })).toBe("codex-gpt-5-1");
    expect(candidateSlug({ profileId: "claude-code", model: "" })).toBe("claude-code");
  });
});

describe("the config a candidate resolves through", () => {
  const base = {
    profile: "claude-code",
    file: "CLAUDE.md",
    command: "/opt/wrappers/claude",
    mcpFile: ".mcp.json",
    model: "opus",
  };

  it("keeps the workspace's own pinned command when the profile is unchanged", () => {
    // Same binary, different model: a workspace that pins a wrapper
    // script must keep running it, or a best-of-N run would silently
    // stop using the agent the workspace actually runs.
    expect(candidateAgentConfig(base, { profileId: "claude-code", model: "sonnet" })).toEqual({
      profile: "claude-code",
      file: "CLAUDE.md",
      command: "/opt/wrappers/claude",
      mcpFile: ".mcp.json",
      model: "sonnet",
    });
  });

  it("drops the pinned command, file and MCP path when the profile differs", () => {
    // The whole reason this function exists: claude-code's wrapper on
    // codex's command line is garbage in codex's argv, and .mcp.json is
    // not where codex reads MCP config.
    expect(candidateAgentConfig(base, { profileId: "codex", model: "gpt-5.1" })).toEqual({
      profile: "codex",
      file: null,
      command: null,
      mcpFile: null,
      model: "gpt-5.1",
    });
  });

  it("reads an empty model as inherit, not as an empty model", () => {
    // "" would resolve as a deliberate empty model and lose the profile's
    // app-wide default; null is what resolveAgentConfig treats as absent.
    expect(candidateAgentConfig(base, { profileId: "claude-code", model: "  " }).model).toBeNull();
  });
});

describe("planning the git objects", () => {
  it("names a branch and a sibling folder per candidate, off the card title", () => {
    const plans = planCandidates(
      "Auth rework",
      [
        { profileId: "claude-code", model: "sonnet" },
        { profileId: "codex", model: "" },
      ],
      LABELS,
      "/repos/gavin",
      []
    );
    expect(plans.map((p) => p.branch)).toEqual(["auth-rework-claude-code-sonnet", "auth-rework-codex"]);
    expect(plans[1].worktreePath).toBe("/repos/gavin-auth-rework-codex");
    expect(plans[0].label).toBe("Claude Code · sonnet");
  });

  it("skips past branches the repo already has", () => {
    const plans = planCandidates(
      "Auth rework",
      [{ profileId: "codex", model: "" }],
      LABELS,
      "/repos/gavin",
      ["auth-rework-codex"]
    );
    expect(plans[0].branch).toBe("auth-rework-codex-2");
  });

  it("dedupes two candidates that slug the same, not just against the repo", () => {
    // Same profile, no model, twice -- a legal thing to ask for (the same
    // agent run twice) and the case where a naive namer hands git the
    // same branch on the second `worktree add` and the run dies half made.
    const plans = planCandidates(
      "Auth",
      [
        { profileId: "codex", model: "" },
        { profileId: "codex", model: "" },
      ],
      LABELS,
      "/repos/gavin",
      []
    );
    expect(plans.map((p) => p.branch)).toEqual(["auth-codex", "auth-codex-2"]);
  });

  it("falls back to a usable slug when the title has nothing legal in it", () => {
    const plans = planCandidates("???", [{ profileId: "codex", model: "" }], LABELS, "/repos/gavin", []);
    expect(plans[0].branch).toBe("run-codex");
  });

  it("labels a profile the table has never heard of by its id", () => {
    // The profile table arrives asynchronously and its failure is
    // swallowed, so an empty map is a state the app really reaches.
    const plans = planCandidates("Auth", [{ profileId: "codex", model: "" }], new Map(), "/repos/gavin", []);
    expect(plans[0].label).toBe("codex");
  });
});

describe("refusing a set that is not a run", () => {
  it("refuses one candidate, because that is just Run", () => {
    expect(candidatesError([{ profileId: "codex", model: "" }])).toMatch(/at least two/);
  });

  it("refuses two identical candidates", () => {
    expect(
      candidatesError([
        { profileId: "codex", model: "gpt-5.1" },
        { profileId: "codex", model: "gpt-5.1" },
      ])
    ).toMatch(/same agent and model/);
  });

  it("allows the same profile at two models, which is the commonest run", () => {
    expect(
      candidatesError([
        { profileId: "claude-code", model: "opus" },
        { profileId: "claude-code", model: "sonnet" },
      ])
    ).toBeNull();
  });
});

describe("what the candidates fork from", () => {
  it("names the main checkout's branch, not whatever the Git tab is pointed at", () => {
    // `worktree add` with no start point forks from the HEAD of the
    // checkout the command runs in. A human reading one fork's diff and
    // then starting a run from the board would otherwise get three
    // candidates branched off that fork's WIP.
    const worktrees = [
      { isMain: true, branch: "main", head: "aaaa111" },
      { isMain: false, branch: "wip", head: "bbbb222" },
    ];
    expect(forkBase(worktrees)).toEqual({ ref: "main", label: "main" });
  });

  it("falls back to the sha when the main checkout is detached", () => {
    expect(forkBase([{ isMain: true, branch: null, head: "abc1234def" }])).toEqual({
      ref: "abc1234def",
      label: "abc1234 (detached)",
    });
  });

  it("leaves it to git when there is no main checkout to name", () => {
    expect(forkBase([])).toEqual({ ref: null, label: "the current HEAD" });
  });
});

describe("the pair the dialog opens with", () => {
  const claude = { id: "claude-code", models: ["opus", "sonnet"], promptArgs: "" };
  const codex = { id: "codex", models: ["gpt-5.1"], promptArgs: "" };
  const cursor = { id: "cursor", models: [], promptArgs: null };

  it("prefers one agent at two models — the comparison this is for", () => {
    expect(seedCandidates([claude, codex], "claude-code", "")).toEqual([
      { profileId: "claude-code", model: "opus" },
      { profileId: "claude-code", model: "sonnet" },
    ]);
  });

  it("leads with the workspace's own model when it has one", () => {
    expect(seedCandidates([claude, codex], "claude-code", "sonnet")[0].model).toBe("sonnet");
    expect(seedCandidates([claude, codex], "claude-code", "sonnet")[1].model).toBe("opus");
  });

  it("reaches for a second profile only when there is no second model", () => {
    const single = { id: "opencode", models: [], promptArgs: "--prompt=" };
    expect(seedCandidates([single, codex], "opencode", "")).toEqual([
      { profileId: "opencode", model: "" },
      { profileId: "codex", model: "gpt-5.1" },
    ]);
  });

  it("never seeds a profile the launch would refuse", () => {
    // cursor reads its positional as a path, so a row naming it is a row
    // that cannot start.
    const single = { id: "opencode", models: [], promptArgs: "--prompt=" };
    expect(seedCandidates([single, cursor], "opencode", "")[1].profileId).toBe("opencode");
  });

  it("falls back to two identical rows, which the error message then explains", () => {
    const single = { id: "opencode", models: [], promptArgs: "--prompt=" };
    const pair = seedCandidates([single], "opencode", "");
    expect(pair).toHaveLength(2);
    expect(candidatesError(pair)).toMatch(/same agent and model/);
  });
});

describe("what a candidate is told on top of the card's own prompt", () => {
  const suffix = composeCandidatePrompt("RUN THE CARD", "Claude Code · sonnet", 3);

  it("keeps the card's prompt intact and adds to it", () => {
    // The card's run prompt is the one the board builds; a best-of-N run
    // that composed its own would be a second way to run a card.
    expect(suffix.startsWith("RUN THE CARD")).toBe(true);
  });

  it("confines the agent to its own worktree", () => {
    expect(suffix).toMatch(/work only in it/);
    expect(suffix).toMatch(/do not switch branches or merge/);
  });

  it("makes the tab name carry the candidate, since all N name themselves the same otherwise", () => {
    expect(suffix).toMatch(/Begin your tab name with “Claude Code · sonnet ”/);
  });

  it("takes the card's status away from it", () => {
    // The card prompt ends "set it to the board's done column when
    // finished" -- right for one agent, wrong for three: the first to
    // finish would move a card the others are still working.
    expect(suffix).toMatch(/Leave this card's status alone/);
  });

  it("says how many it is running against", () => {
    expect(composeCandidatePrompt("x", "Codex CLI", 2)).toMatch(/one of 2 agents/);
  });
});

describe("the page the run lands on", () => {
  it("is named for the card, so two runs are told apart", () => {
    expect(runPageName("  Auth   rework ")).toBe("Auth rework");
    expect(runPageName("   ")).toBe("Best of N");
  });
});

describe("picking one", () => {
  const run: BestOfNRun = {
    cardPath: "/repo/.gavin-root/plans/auth.md",
    cardTitle: "Auth rework",
    pageId: "page-1",
    startedAt: 0,
    candidates: [
      runCandidate({ sessionId: "a", label: "Claude Code · opus", branch: "auth-a" }),
      runCandidate({ sessionId: "b", label: "Claude Code · sonnet", branch: "auth-b", worktreePath: "/repos/gavin-auth-b" }),
      runCandidate({ sessionId: "c", label: "Codex CLI", branch: "auth-c", worktreePath: "/repos/gavin-auth-c" }),
    ],
  };

  it("makes every other candidate a loser", () => {
    expect(losersOf(run, "b").map((c) => c.sessionId)).toEqual(["a", "c"]);
  });

  it("makes everything a loser when the winner is gone, which is the abandon case", () => {
    // A stale session id must degrade to "discard the lot", never to a
    // half-cleanup that leaves folders nobody can reach any more.
    expect(losersOf(run, null)).toHaveLength(3);
    expect(losersOf(run, "vanished")).toHaveLength(3);
  });

  it("names every folder it deletes and says the winner is not merged yet", () => {
    const confirm = pickConfirm(run.candidates[1], losersOf(run, "b"));
    expect(confirm.title).toBe("Keep Claude Code · sonnet and discard 2 candidates?");
    expect(confirm.lines?.[0]).toBe("gavin-auth-claude-code — Claude Code · opus");
    expect(confirm.lines?.at(-1)).toMatch(/merging it is still yours to do/);
    expect(confirm.danger).toBe(true);
    // Enter must not fire a deletion, so the dismissing answer is the
    // one that reads as safe.
    expect(confirm.cancelLabel).toBe("Keep watching");
  });

  it("offers the branches as one tick-box, named when there is one and counted when there are many", () => {
    expect(discardBranchesLabel([run.candidates[0]])).toBe("Also delete the branch auth-a");
    expect(discardBranchesLabel(run.candidates)).toBe("Also delete the 3 branches");
    expect(pickConfirm(run.candidates[1], losersOf(run, "b")).check.default).toBe(true);
  });

  it("abandoning says the card is left alone, since nothing was chosen", () => {
    const confirm = abandonConfirm(run.candidates);
    expect(confirm.title).toBe("Discard all 3 candidates?");
    expect(confirm.lines?.at(-1)).toMatch(/keeps the status it has/);
    expect(confirm.confirmLabel).toBe("Discard the run");
  });
});
