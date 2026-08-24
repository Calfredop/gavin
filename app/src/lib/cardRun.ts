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

// The provisional tab name the app writes the moment it launches a card,
// before the agent has said anything. The agent's own gavin_name_session
// then overwrites it with something sharper -- but until it does (and if
// it never does, because the gavin tools are unreachable), the tab reads
// as the card rather than as a session-id fragment.
//
// Same 40-character cap as gavin-mcp's clean_session_name, so a tab is
// bounded the same way whichever side named it. Null for a title with
// nothing in it: no name at all falls back to the cwd label, which beats
// naming a tab "".
const MAX_SESSION_NAME = 40;

export function provisionalSessionName(title: string): string | null {
  const collapsed = title.split(/\s+/).filter(Boolean).join(" ");
  if (!collapsed) return null;
  // Array spread, not slice: a title ending in an astral character would
  // be cut mid-surrogate-pair by index slicing.
  const chars = [...collapsed];
  return chars.length > MAX_SESSION_NAME
    ? chars.slice(0, MAX_SESSION_NAME).join("") + "\u2026"
    : collapsed;
}

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

/// The one instruction behind the Git tab's "Commit via agent". Fixed
/// text with nothing interpolated: the button IS the whole interaction,
/// so there is no user input to compose in -- and no NAME_TAB_FIRST
/// either, because this run has no tab to name. The app names its
/// session itself, for the case where the human reveals it.
export const COMMIT_PROMPT =
  "Commit pending and unversioned changes, in logical chunks. Do not push.";

// `<command> <headlessArgs> '<prompt>'`: one prompt, no TUI, then exit.
// What a HIDDEN session needs -- an interactive agent sits at its prompt
// forever, and a session nobody can see never coming back is a spinner
// with no end, so a profile with no verified headless argv is refused
// here rather than launched and hoped for (agent_setup.rs's
// headless_args carries the argv, and only for verified rows).
//
// The prompt goes LAST and the argv ends in `--`, which is the profile
// table's job to guarantee: an allow-list flag that takes a variadic
// value would otherwise swallow the prompt whole.
export function buildHeadlessCommand(
  agentCommand: string,
  headlessArgs: string,
  prompt: string
): string | null {
  if (!headlessArgs.trim()) return null;
  return `${agentCommand} ${headlessArgs.trim()} ${shellQuote(prompt)}`;
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
