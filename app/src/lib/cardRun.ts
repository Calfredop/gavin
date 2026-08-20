// Pure prompt/command composition for executable cards (card-model spec
// §3). The run flow (cardRunActions.ts) wires these to real sessions.

import { slugStatus } from "./planBoard";

export function composeTaskPrompt(path: string, title: string, body: string): string {
  return (
    `You are executing the task card at ${path} ("${title}").\n\n` +
    `${body}\n\n` +
    `While you work, keep this card's status current with gavin_set_plan_field on ${path}; ` +
    `set it to the board's done column when finished.`
  );
}

export function composePlanPrompt(path: string): string {
  return (
    `Read ${path} and execute that plan. Work its checklist top to bottom: ` +
    `tick items (- [x]) as you complete them, promote items that need their own agent ` +
    `with gavin_promote_task, and keep the plan's status current with gavin_set_plan_field.`
  );
}

// POSIX single-quoting: wrap in single quotes, closing/reopening around
// each embedded single quote. Newlines and every other byte ride inside
// the quotes untouched.
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

export function buildRunCommand(agentCommand: string, prompt: string): string {
  return `${agentCommand} ${shellQuote(prompt)}`;
}

// The app writes "In Progress" on launch unless the card already sits in
// a slug-matching column (spec §3). It never auto-completes.
export function runStatusNeeded(currentStatus: string | null): boolean {
  return slugStatus(currentStatus ?? "") !== slugStatus("In Progress");
}
