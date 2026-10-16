---
kind: task
title: "[sec] A cloned repo's [agent] model_flag is spliced unquoted into every agent launch line, bypassing workspace trust"
status: To Do
priority: high
complexity: complex
---
Fix a high-severity finding from the 2026-10-15 security audit (run-1). Fingerprint: `app/src/lib/agents/agentModel.ts:composeLaunchCommand:model_flag-unquoted-untrusted`.

Full record: `findings.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

Workspace trust (workspaceTrust.ts) gates only three .gavin-root/config.toml keys: [agent] command, [agent] file and [worktree] setup. It does so on the premise that every other key only selects among gavin's verified rows. [agent] model_flag is free text. The daemon parses it verbatim (gavin.rs parse_context_config, line 1875 in the current tree; it was 1825 at hunt time). trustedAgentConfig passes it through untouched, and resolveAgentConfig prefers it over the profile's own flag (settings.ts:558). composeLaunchCommand then appends it verbatim and unquoted to the launch command (agentModel.ts:67). The sibling effort_flag and advisor flag are filtered by flagIsInert for exactly this reason (agentModel.ts:70-80, 127, 142); model_flag is not. The resulting launchCommand is the agent command that every launcher reads through resolvedAgentFor or agentForCard: board Run, develop, resume, headless, rail-step and Best-of-N lines. The daemon runs it as sh -c. A repo that sets only model and model_flag needs no approval: hasExecutionKeys is false, configTrusted is true with no stamp, and no trust notice is shown. Its arbitrary shell commands run as the human on the first agent launch in that workspace, including a launch on a card the human wrote.

## Root cause

composeLaunchCommand appends the flag string unquoted with no flagIsInert check. model_flag is also not among the digest-gated ExecutionKeys, even though it is repo-supplied free text that ends up as shell syntax.

## The invariant to enforce

A repo-supplied value that is not one of the approved execution keys must never reach the sh -c line as shell syntax. A model flag carrying shell metacharacters should be dropped, as composeEffort does for effort_flag, or model_flag should join the trust digest.

## Trace (lines as of 2026-10-16; re-read before editing)

- `crates/daemon/src/gavin.rs:1875` (parse_context_config): The root context's [agent] model_flag is read verbatim from the repository's .gavin-root/config.toml into AgentConfig (serialized camelCase as modelFlag). The function starts at line 1858; the candidate's line 1825 has shifted by 50 lines in the current tree.
- `app/src/lib/workspace/workspaceTrust.ts:117` (trustedAgentConfig): An unapproved config has only command and file blanked, so modelFlag survives. A config naming only model/model_flag counts as trusted anyway, because hasExecutionKeys is false.
- `app/src/lib/core/layoutState.ts:2331` (trustedAgentConfigFor): Produces the config every launcher reads: resolvedAgentFor (line 2444) and agentForCard/agentForProfile via workspaceAgentConfig (line 2565).
- `app/src/lib/core/settings.ts:558` (resolveAgentConfig): config.modelFlag wins over the profile's verified flag.
- `app/src/lib/core/settings.ts:581` (resolveAgentConfig): launchCommand = composeAdvisor(composeEffort(composeLaunchCommand(command, modelFlag, model), ...)).
- `app/src/lib/agents/agentModel.ts:67` (composeLaunchCommand): Returns `${command} ${flag} ${quoteModel(chosen)}`; only the model is quoted, and the flag is neither quoted nor checked.
- `app/src/lib/cards/cardRun.ts:301` (buildRunCommand): The launch line is the agent command followed by the quoted prompt, so the injected flag precedes it unquoted. The function sits at line 291 in the current tree; it was cited as 280.
- `crates/daemon/src/pty.rs:164` (PtySession spawn): The session command is executed as `sh -c <line>` as the human.

## Fix

Apply to the model flag the same inertness rule the effort and advisor flags already get, so a repo-supplied flag with shell syntax is dropped. Optionally also add model_flag/effort_flag to ExecutionKeys so a repo-chosen flag is shown for approval. Regression tests: composeLaunchCommand("claude", "--model x; touch y", "opus") returns "claude", and resolveAgentConfig with config.modelFlag containing ';' yields a launchCommand without it. Stock flags (--model, -m) remain inert, so legitimate configs are unaffected.

`app/src/lib/agents/agentModel.ts`, as a sketch only:

```
export function composeLaunchCommand(command: string, flag: string, model: string): string {
  const chosen = model.trim();
  const usable = flag.trim();
  if (!chosen || !usable || !flagIsInert(usable) || commandSpecifiesModel(command, usable)) return command;
  return `${command} ${usable} ${quoteModel(chosen)}`;
}
```

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched.
- The audit reproduction no longer works. It is the record's `execution` field in `findings.json`.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
