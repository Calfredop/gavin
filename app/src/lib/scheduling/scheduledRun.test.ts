import { describe, expect, it } from "vitest";
import { DEFAULT_RUN_SCHEDULED } from "$lib/agents/actionPromptDefaults";
import { actionPromptById } from "$lib/agents/actionPrompts";
import { placeholdersIn } from "$lib/orchestration/orchestrationTools";
import {
  composeScheduledPrompt,
  runLabel,
  scheduledRunArgs,
  scheduledRunBlocker,
} from "$lib/scheduling/scheduledRun";

describe("the argv a scheduled run launches with", () => {
  it("lets Claude Code edit files, beyond the commit agent's git-only grant", () => {
    expect(scheduledRunArgs("claude-code", '-p --allowedTools "Bash(git *)" --')).toBe(
      '-p --permission-mode acceptEdits --allowedTools "Bash(git *)" --'
    );
  });

  it("keeps a headless argv that already writes the workspace", () => {
    const codex = "exec --sandbox workspace-write --ask-for-approval never --";
    expect(scheduledRunArgs("codex", codex)).toBe(codex);
    expect(scheduledRunArgs("gemini", "--yolo --prompt=")).toBe("--yolo --prompt=");
  });

  it("refuses a profile with no headless mode, or only the commit agent's", () => {
    expect(scheduledRunArgs("custom", "")).toBeNull();
    expect(scheduledRunArgs("opencode", "run --agent gavin-commit --auto --")).toBeNull();
    expect(scheduledRunBlocker({ profileId: "opencode", label: "opencode", headlessArgs: "run --" })).toBe(
      "opencode has no headless mode a scheduled run can use"
    );
    expect(scheduledRunBlocker({ profileId: "codex", headlessArgs: "exec --" })).toBeNull();
  });
});

describe("the scheduled run's prompt", () => {
  const prompt = composeScheduledPrompt(DEFAULT_RUN_SCHEDULED, {
    fireNumber: 3,
    title: "Bump deps",
    body: "\nRun the bump.\n",
    reportPath: "/ws/.gavin-root/scheduled/runs/bump/20261021-090000.md",
  });

  it("carries the task's own prompt and the Run report contract", () => {
    expect(prompt).toContain("scheduled run #3 of the Scheduled task “Bump deps”");
    expect(prompt).toContain("\n\nRun the bump.\n\n");
    expect(prompt).toContain("/ws/.gavin-root/scheduled/runs/bump/20261021-090000.md");
    expect(prompt).toContain("first line must be a markdown heading");
    expect(prompt).toContain("what changed (files, commits)");
    expect(prompt).toContain("needs the human");
    expect(prompt).not.toMatch(/\{\{/);
  });

  it("names a Run now as one", () => {
    expect(runLabel(null)).toBe("a run started by hand (Run now)");
  });

  it("declares every placeholder its default uses, so the editor offers them", () => {
    const declared = actionPromptById("action:run-scheduled")!.params.map((p) => p.name);
    expect(placeholdersIn(DEFAULT_RUN_SCHEDULED).sort()).toEqual([...declared].sort());
  });
});
