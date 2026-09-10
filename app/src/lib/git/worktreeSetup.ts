import { count } from "$lib/orchestration/railConfirm";

/// What a newly created worktree will run, and how it will be described
/// before the human commits to creating it.
///
/// `[worktree] setup` in `.gavin-root/config.toml` declares the commands a
/// fresh checkout needs — `npm install`, `cargo fetch`, a `.env` copy —
/// and gavin runs them in a VISIBLE session in the new worktree, because
/// that is the rule for everything that takes minutes and can fail.
export interface SetupPlan {
  /// The exact line that session runs. Shown to the human verbatim: a
  /// prose paraphrase would be a second description to keep in sync with
  /// the thing actually executed, and this one cannot drift.
  line: string;
  /// How many DECLARED setup commands the line carries. The agent chained
  /// onto the end is not one of them, which is what lets a caller tell
  /// "there is setup to announce" from "this is just the agent command
  /// the checkbox already named".
  commands: number;
  /// Whether the agent runs on the same line, after the setup.
  agentAfter: boolean;
}

/// Blank entries drop out here as well as in the host's reader: this
/// module is also handed the agent command, which a workspace with no
/// resolved profile can hand back empty.
function usable(commands: string[]): string[] {
  return commands.map((c) => c.trim()).filter((c) => c.length > 0);
}

/// One line, not one session per command. The joiner is `&&` rather than
/// `;` so a failed install STOPS: an agent launched into a worktree whose
/// setup failed is worse than no agent at all, because it looks like it
/// worked. Chaining the agent onto the same line (rather than opening a
/// second tab beside it) is what makes the agent start in an installed
/// worktree instead of racing the install — and it keeps the failure and
/// the thing that would have followed it in one place the human is
/// already looking at.
///
/// `null` means there is nothing to run at all, and no session should be
/// opened — the ordinary case for a workspace that declares no setup and
/// a caller that isn't starting an agent.
///
/// `trusted` says whether the human has approved this repo's config.toml
/// execution keys (`workspaceTrust.ts`). Unapproved setup lines are
/// dropped entirely rather than shown and refused: config.toml ships with
/// the repository, so `setup` here can be a cloned repo's shell, `&&`-ed
/// ahead of the agent at the moment a worktree is cut. A plan built from
/// an unapproved config is exactly the plan a workspace declaring no
/// setup would get.
///
/// Required rather than defaulted, so the compiler names every call site
/// instead of letting one silently run a repo's commands. The agent
/// command needs no such flag — it arrives already resolved through
/// `trustedAgentConfigs`.
export function setupPlan(
  setup: string[],
  agentCommand: string | null,
  trusted: boolean
): SetupPlan | null {
  const commands = usable(trusted ? setup : []);
  const agent = usable(agentCommand ? [agentCommand] : []);
  const parts = [...commands, ...agent];
  if (parts.length === 0) return null;
  return { line: parts.join(" && "), commands: commands.length, agentAfter: agent.length > 0 };
}

/// The sentence above that line in the fork dialog. Only ever shown for a
/// plan that carries declared setup — announcing a bare agent command
/// would repeat the checkbox right beside it.
export function setupNotice(plan: SetupPlan): string {
  const what = `${count(plan.commands, "setup command")} from .gavin-root/config.toml`;
  return plan.agentAfter
    ? `Runs ${what} in the new worktree, then starts the agent there:`
    : `Runs ${what} in the new worktree:`;
}
