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

// The daemon runs a session's command as `sh -c <line>` (pty.rs), so a
// one-line `command` tool needs no wrapping at all, while a multi-line
// `script` tool wants bash -- `[[`, arrays and pipefail all behave as
// the author wrote them rather than as POSIX sh reads them.
//
// Both get a failure epilogue, because a PTY that exits closes its tab
// immediately: without a last line naming the code, a tool that failed
// in half a second leaves nothing on screen to read. The exit status is
// re-raised afterwards, since it IS the step's verdict (tools spec T5).
export function buildToolCommand(
  kind: "command" | "script",
  body: string,
  toolName: string
): string {
  const inner = kind === "script" ? `bash -c ${shellQuote(body)}` : body;
  return [
    inner,
    "__gavin_code=$?",
    // `\\n`, not `\n`: this string is SHELL source, so the escape has to
    // survive into it for printf to interpret. A bare `\n` here would put
    // a real newline inside the single-quoted format string -- which
    // happens to print the same thing, but splits the command across
    // lines for no reason and breaks the moment the epilogue is edited.
    `[ "$__gavin_code" -ne 0 ] && printf '\\n[gavin] %s exited with code %s\\n' ${shellQuote(toolName)} "$__gavin_code"`,
    'exit "$__gavin_code"',
  ].join("\n");
}

// The app writes "In Progress" on launch unless the card already sits in
// a slug-matching column (spec §3). It never auto-completes.
export function runStatusNeeded(currentStatus: string | null): boolean {
  return slugStatus(currentStatus ?? "") !== slugStatus("In Progress");
}
