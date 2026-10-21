// What a Scheduled task's run IS (ADR 0010): which argv carries it, and
// what its agent is told. Pure; `scheduledState.ts` does the launching.
//
// A scheduled run is headless -- one prompt, no TUI, then exit -- because
// nobody is watching it and a session that sits at its prompt would be a
// run that never ends. It reuses each profile's verified headless argv
// (`agent_setup.rs`'s `headless_args`), with one difference: that argv
// was written for Commit via agent, and for Claude Code it grants git
// alone. A scheduled run has to edit files -- its Run report at the very
// least -- so Claude Code's gains `--permission-mode acceptEdits`.
// opencode's runs the commit agent's own git-only definition, which
// cannot write the report at all, so it is not offered.

import { fillTemplate } from "$lib/agents/actionPromptDefaults";
import type { CardAgentFields } from "$lib/cards/cardAgent";
import type { ScheduledTask } from "$lib/scheduling/scheduledTask";

/// Profiles whose headless argv is the commit agent's and nothing wider.
const COMMIT_ONLY_HEADLESS = new Set(["opencode"]);

/// The headless argv a scheduled run of `profileId` launches with, or
/// null when that profile has none it can use.
export function scheduledRunArgs(profileId: string, headlessArgs: string): string | null {
  const args = headlessArgs.trim();
  if (!args || COMMIT_ONLY_HEADLESS.has(profileId)) return null;
  if (profileId === "claude-code" && !args.includes("--permission-mode")) {
    return args.startsWith("-p ")
      ? `-p --permission-mode acceptEdits ${args.slice(3)}`
      : `--permission-mode acceptEdits ${args}`;
  }
  return args;
}

/// Why `agent` cannot carry a scheduled run, or null when it can. The
/// sentence the Schedule dialog and a skipped fire both show.
export function scheduledRunBlocker(agent: {
  profileId: string;
  label?: string;
  headlessArgs: string;
}): string | null {
  if (scheduledRunArgs(agent.profileId, agent.headlessArgs) !== null) return null;
  return `${agent.label || agent.profileId} has no headless mode a scheduled run can use`;
}

/// The copy's run settings, in the shape a card Run resolves its agent
/// from -- so a Scheduled task is resolved exactly the way the card it
/// was copied from would be.
export function scheduledAgentFields(task: Pick<ScheduledTask, "agent" | "model" | "effort" | "complexity">): CardAgentFields {
  return { agent: task.agent, model: task.model, effort: task.effort, complexity: task.complexity };
}

/// "scheduled run #3", or what a Run now is called.
export function runLabel(fireNumber: number | null): string {
  return fireNumber === null ? "a run started by hand (Run now)" : `scheduled run #${fireNumber}`;
}

/// The prompt a scheduled run is launched with: `template` (the
/// `action:run-scheduled` body, overrides applied) around the task's own.
export function composeScheduledPrompt(
  template: string,
  run: { fireNumber: number | null; title: string; body: string; reportPath: string }
): string {
  return fillTemplate(template, {
    run_label: runLabel(run.fireNumber),
    title: run.title,
    body: run.body.trim(),
    report_path: run.reportPath,
  }).trim();
}
