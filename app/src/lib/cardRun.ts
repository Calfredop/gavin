// Pure prompt/command composition for executable cards (card-model spec
// §3). The run flow (cardRunActions.ts) wires these to real sessions.

import { slugStatus } from "./planBoard";

// Every launched agent gets the same opening instruction, board Run and
// orchestration alike: name the tab before doing anything else. A page
// of "gavin" tabs all showing their cwd tells the human nothing about
// which agent is doing what, and the agent is the only one who knows.
// Stated here as well as in the gavin skill because this line is what an
// agent reads FIRST -- the skill explains, the prompt orders.
export const NAME_TAB_FIRST =
  "First, before anything else: call gavin_name_session to name this tab — " +
  "two to four words for the work itself, not for you.";

export function composeTaskPrompt(path: string, title: string, body: string): string {
  return (
    `${NAME_TAB_FIRST}\n\n` +
    `You are executing the task card at ${path} ("${title}").\n\n` +
    `${body}\n\n` +
    `While you work, keep this card's status current with gavin_set_plan_field on ${path}; ` +
    `set it to the board's done column when finished.`
  );
}

export function composePlanPrompt(path: string): string {
  return (
    `${NAME_TAB_FIRST}\n\n` +
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

// Resume (fixed-column run actions): an In Progress card has already
// been worked on, so its prompt points at the gavin-resume skill --
// which teaches an agent to find the work in flight before adding to
// it -- instead of the from-scratch framing above.
export function composeResumeTaskPrompt(path: string, title: string, body: string): string {
  return (
    `${NAME_TAB_FIRST}\n\n` +
    `Use the gavin-resume skill to resume the task card at ${path} ("${title}"). ` +
    `Work on it already started and stopped.\n\n` +
    `${body}\n\n` +
    `Find what is already done before you write anything, then carry on from there. ` +
    `Keep this card's status current with gavin_set_plan_field on ${path}; ` +
    `set it to the board's done column when finished.`
  );
}

export function composeResumePlanPrompt(path: string): string {
  return (
    `${NAME_TAB_FIRST}\n\n` +
    `Use the gavin-resume skill to resume the plan at ${path}. Work on it already started ` +
    `and stopped: find what is already done before you write anything — the checklist's ` +
    `ticks are the record, but not the whole of it. Then work it top to bottom from there, ` +
    `ticking items (- [x]) as you complete them, promoting items that need their own agent ` +
    `with gavin_promote_task, and keeping the plan's status current with gavin_set_plan_field.`
  );
}
