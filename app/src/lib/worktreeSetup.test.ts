import { describe, it, expect } from "vitest";
import { setupPlan, setupNotice } from "./worktreeSetup";

describe("what a new worktree runs", () => {
  it("is the declared commands, chained so a failure stops the rest", () => {
    const plan = setupPlan(["npm install", "cargo fetch"], null);
    expect(plan).toEqual({ line: "npm install && cargo fetch", commands: 2, agentAfter: false });
  });

  it("puts the agent last on the SAME line, so it starts installed rather than racing the install", () => {
    const plan = setupPlan(["npm install"], "cclaude --dontask");
    // The whole point of the card: `&&` means a failed install never
    // reaches the agent, and one line means one tab to watch.
    expect(plan?.line).toBe("npm install && cclaude --dontask");
    expect(plan?.agentAfter).toBe(true);
  });

  it("is just the agent command in a workspace that declares no setup", () => {
    // The behaviour that existed before this feature, which must survive
    // it untouched: the fork dialog's "Start agent here" still opens one
    // agent session and nothing else.
    expect(setupPlan([], "cclaude")).toEqual({ line: "cclaude", commands: 0, agentAfter: true });
  });

  it("is nothing at all when neither is asked for, so no session opens", () => {
    // A rail binding a worktree in a workspace with no setup must not get
    // an empty tab for its trouble.
    expect(setupPlan([], null)).toBeNull();
    expect(setupPlan([], "")).toBeNull();
    expect(setupPlan(["", "   "], "  ")).toBeNull();
  });

  it("drops blanks rather than emitting the empty command they would become", () => {
    // `npm install &&  && cargo fetch` is a syntax error that would fail
    // the whole line, so a stray entry must not cost the commands around
    // it. The host's reader filters these too; this module is fed the
    // agent command as well, which resolves empty in a workspace with no
    // profile.
    expect(setupPlan([" npm install ", "", "  ", "cargo fetch"], null)?.line).toBe(
      "npm install && cargo fetch"
    );
    expect(setupPlan(["npm install"], "   ")).toEqual({
      line: "npm install",
      commands: 1,
      agentAfter: false,
    });
  });

  it("counts only the declared commands, never the agent", () => {
    // `commands` is what tells the dialog there is setup worth announcing;
    // counting the agent would make every fork claim a setup step.
    expect(setupPlan([], "cclaude")?.commands).toBe(0);
    expect(setupPlan(["make dev"], "cclaude")?.commands).toBe(1);
  });
});

// The wiring below is a prop hand-off between three components, which the
// pure suite cannot reach. Pinned in the source the way
// railBranchSeed.test.ts pins its own, because every one of these is a
// silent failure: a worktree that is simply never set up looks exactly
// like a workspace that declared no setup.
const SOURCES = import.meta.glob("./*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function source(name: string): string {
  const text = SOURCES[`./${name}`];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

const FORK = "GitForkDialog.svelte";
const BIND = "RailBindDialog.svelte";

describe("the session a new worktree gets", () => {
  it("runs the plan's line, and opens no session when there is no plan", () => {
    const s = source(FORK);
    expect(s).toContain("const plan = $derived(setupPlan(setup, allowSpawn && startAgent ? agentCommand : null));");
    // Captured before the awaits, run after them: what executes is what
    // the human saw on the button they pressed.
    expect(s).toContain("const run = plan;");
    expect(s).toContain("if (run) onRunInWorktree(path, run.line);");
  });

  it("reads the setup from the WORKSPACE root, not the git toplevel it forks from", () => {
    // `.gavin-root` sits beside the workspace, which is not always the
    // repo root this dialog is looking at.
    expect(source(FORK)).toContain('const gavinRoot = $derived($gavinTrees[workspaceId]?.rootPath ?? "");');
    expect(source(FORK)).toContain("backend\n      .worktreeSetup(root)");
  });

  it("is opened by BOTH callers — a rail's fork used to hand in a no-op", () => {
    // This is the bug the feature would otherwise still have: rail
    // binding passed `onSpawnAgent={() => {}}` because it never wanted an
    // agent, which would have swallowed the setup with it.
    expect(source("GitWorktreeSwitcher.svelte")).toContain("onRunInWorktree={spawnAgent}");
    expect(source(BIND)).toContain(
      "onRunInWorktree={(path, command) => void runOnRailPage(workspaceId, rail.id, path, command)}"
    );
    expect(source(BIND)).not.toContain("onSpawnAgent");
  });

  it("lands on the RAIL's page, not on whatever page the workspace is showing", () => {
    // runOnRailPage goes through createSessionOnRailPage, the seam that
    // exists so a rail's sessions stop piling onto "Page 1".
    expect(source(BIND)).toContain('import { bindRailAction, runOnRailPage } from "./orchestrationState";');
    expect(source(BIND)).not.toContain("createSessionForCard");
  });

  it("waits for the rail's binding, so that page opens IN the new worktree", () => {
    expect(source(FORK)).toContain("await onPicked?.(path);");
    expect(source(BIND)).toMatch(/onPicked=\{async \(path\) => \{/);
  });

  it("is announced only when there is declared setup to announce", () => {
    // A plan carrying nothing but the agent command would repeat the
    // checkbox directly above it.
    expect(source(FORK)).toContain("{#if plan && plan.commands > 0}");
    expect(source(FORK)).toContain("<code>{plan.line}</code>");
  });
});

describe("what the fork dialog says will happen", () => {
  it("names the count and where the list came from, singular and plural", () => {
    expect(setupNotice(setupPlan(["npm install"], null)!)).toBe(
      "Runs 1 setup command from .gavin-root/config.toml in the new worktree:"
    );
    expect(setupNotice(setupPlan(["npm install", "cargo fetch"], null)!)).toBe(
      "Runs 2 setup commands from .gavin-root/config.toml in the new worktree:"
    );
  });

  it("says the agent comes after, so the human knows one tab covers both", () => {
    expect(setupNotice(setupPlan(["npm install"], "cclaude")!)).toContain("then starts the agent there");
  });
});
