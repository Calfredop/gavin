// Pure prompt/command composition for executable cards (card-model spec
// §3). The run flow (cardRunActions.ts) wires these to real sessions.

import { attachmentPromptBlock } from "$lib/cards/attachments";
import { slugStatus } from "$lib/core/planBoard";
import { cardIsOutside } from "$lib/git/worktreeCards";

// Every launched agent gets the same opening instruction, board Run and
// orchestration alike: name the tab before doing anything else. A page
// of "gavin" tabs all showing their cwd tells the human nothing about
// which agent is doing what, and the agent is the only one who knows.
// Stated here as well as in the gavin skill because this line is what an
// agent reads FIRST -- the skill explains, the prompt orders.
export const NAME_TAB_FIRST =
  "First, before anything else: call gavin_name_session to name this tab — " +
  "two to four words for the work itself, not for you.";

// v38: an agent whose CLI mints its OWN conversation id -- opencode
// today, per agent_setup.rs's `session_id_discovery` -- gets a second
// instruction appended: run that discovery command once an id exists,
// and self-report it as gavin_name_session's second argument, so gavin
// can reopen this exact conversation later instead of writing a fresh
// one from an account of it.
//
// A profile that mints its id up front (Claude Code) or has no verified
// convention (codex, gemini, cursor, custom) has an empty
// sessionIdDiscovery and gets NAME_TAB_FIRST completely unchanged --
// the same no-fallback-BETWEEN-rows rule sessionIdArgs/resumeArgs
// already take: a discovery command that fits nobody's CLI is worse
// than admitting there is none.
export function nameTabFirst(sessionIdDiscovery: string | null | undefined): string {
  const command = sessionIdDiscovery?.trim();
  if (!command) return NAME_TAB_FIRST;
  return (
    `${NAME_TAB_FIRST} Your CLI mints its own conversation id, which gavin has no way to ` +
    `fix at launch -- so once one exists, run \`${command}\` and pass what it prints as ` +
    `gavin_name_session's second argument.`
  );
}

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

// The sentence that names the decoy, appended to every prompt launched
// somewhere the card does NOT live -- a rail's worktree, a best-of-N
// candidate's checkout.
//
// Where `.gavin*` is tracked in git (this repo is such a workspace), a
// worktree carries its own copy of every card at the same relative path.
// The prompt names the absolute one exactly once, and from then on every
// relative path the agent forms resolves inside its cwd to a file that
// exists and looks right. Writing that one is silent: the board never
// moves, so the step never completes and the rail waits forever, and the
// divergence rides the branch to become a merge conflict.
//
// One sentence is the cheapest of the four fixes this was weighed
// against, and the only one that also covers an agent reaching the card
// through a skill rather than through the prompt. It says which file is
// real, what the other one is, and what happens if it is written -- the
// last part deliberately, because "there is a copy" reads as trivia and
// "the board never sees it" reads as an instruction.
//
// Empty when the card is inside the cwd, which is every board Run: there
// is no second copy to confuse, and a warning about a hazard that is not
// present is noise that teaches an agent to skim the framing.
export function cardHomeNote(path: string, cwd: string | null = null): string {
  if (!cardIsOutside(path, cwd)) return "";
  return (
    `\n\nThis card lives at ${path} and nowhere else. You are running in a different ` +
    `checkout of this repository, which carries its OWN copy of that file at the same ` +
    `relative path — a decoy. Gavin never reads it: a status, a tick or a move written ` +
    `there is invisible to the board, leaves this step running forever, and rides the ` +
    `branch into a merge conflict. Read and write the absolute path above every time, ` +
    `and never the copy under your working directory.`
  );
}

// `attachments` is the card's resolved ABSOLUTE paths, and defaults to
// none so the dozen call sites that predate the field keep compiling and
// keep meaning what they meant. It sits between the framing line and the
// body deliberately: the files are context FOR the body, and an agent
// told to read them after the instructions has already started.
//
// `cwd` is where the run will be LAUNCHED, and defaults to null so the
// same call sites keep compiling. It buys the decoy note above, and only
// the launchers that run outside the card's own folder need to pass it.
//
// `withheld` is the raw text of every entry the card names that gavin
// resolved outside the workspace and did not read (`attachments.ts`'s
// `withheldAttachmentPaths`) -- appended AFTER `cwd`, not beside
// `attachments`, so every call site written before this field existed
// keeps its `cwd` argument meaning what it always meant.
export function composeTaskPrompt(
  path: string,
  title: string,
  body: string,
  attachments: string[] = [],
  cwd: string | null = null,
  withheld: string[] = [],
  sessionIdDiscovery: string | null | undefined = null
): string {
  return (
    `${nameTabFirst(sessionIdDiscovery)}\n\n` +
    `You are executing the task card at ${path} ("${title}").` +
    `${attachmentPromptBlock(attachments, withheld)}\n\n` +
    `${body}\n\n` +
    `While you work, keep this card's status current with gavin_set_plan_field on ${path}; ` +
    `set it to the board's done column when finished.` +
    cardHomeNote(path, cwd)
  );
}

export function composePlanPrompt(
  path: string,
  attachments: string[] = [],
  cwd: string | null = null,
  withheld: string[] = [],
  sessionIdDiscovery: string | null | undefined = null
): string {
  return (
    `${nameTabFirst(sessionIdDiscovery)}\n\n` +
    `Read ${path} and execute that plan. Work its checklist top to bottom: ` +
    `tick items (- [x]) as you complete them, promote items that need their own agent ` +
    `with gavin_promote_task, and keep the plan's status current with gavin_set_plan_field.` +
    attachmentPromptBlock(attachments, withheld) +
    cardHomeNote(path, cwd)
  );
}

// Develop (the To Do column's counterpart to Resume): a thin card that
// has not been started, handed to the gavin-develop skill so it comes
// back as work an agent can execute. One composer for both kinds -- the
// card file is the agent's to read whatever it is, and inlining a task's
// body is exactly what makes an agent start BUILDING instead of
// interviewing.
//
// The shapes are named WITH the small one ("a sharper prompt"), because
// a prompt that lists only checklists and child cards forecloses the
// finding that the card was never big: an agent told to produce steps
// produces steps. And the kind is named because it is the one part of
// developing that has no visible half -- a card left `kind: task` after
// gaining a checklist runs with that checklist inlined as its prompt,
// while one pushed to `kind: plan` without gaining one runs with its
// body never inlined at all.
//
// The level is named for the same reason the kind is: it has no visible
// half either. A card left unrated runs the workspace's default agent,
// so an intricate card and a rename come back off the same model -- and
// nothing about the developed card says which one it should have been.
//
// Nothing here mentions the done column: the run ends when the card is
// developed, and the card stays where it is. Developing is not starting.
export function composeDevelopPrompt(
  path: string,
  title: string,
  sessionIdDiscovery: string | null | undefined = null
): string {
  return (
    `${nameTabFirst(sessionIdDiscovery)}\n\n` +
    `Use the gavin-develop skill on the card at ${path} ("${title}"): develop it into ` +
    `work an agent can execute \u2014 a checklist, nested task cards, both, or, when it is ` +
    `really one sitting, a sharper prompt \u2014 and set the card's kind and complexity to ` +
    `match what you wrote.\n\n` +
    `Interview me in this tab before you decide anything, and write nothing to the card ` +
    `until I approve what you propose. Leave the card's status where it is: developing a ` +
    `card is not starting it.`
  );
}

// POSIX single-quoting: wrap in single quotes, closing/reopening around
// each embedded single quote. Newlines and every other byte ride inside
// the quotes untouched.
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/// A conversation id for a run about to be launched, or null when this
/// profile cannot take one.
///
/// Minted by GAVIN rather than read back from the agent afterwards, which
/// is the whole design: `claude --session-id <uuid>` lets the CALLER fix
/// the id, so gavin holds it from the first byte and never has to scrape
/// `~/.claude/projects` or guess by mtime. An agent whose CLI has no such
/// flag gets null and falls back to a written reconstruction of what the
/// last agent was doing (`composeResumeTaskPrompt`).
///
/// A real UUID because the CLI validates it: `--session-id` refuses
/// anything else.
export function mintConversationId(sessionIdArgs: string): string | null {
  return sessionIdArgs.trim() ? crypto.randomUUID() : null;
}

/// `<command> [--session-id <uuid>] <promptArgs><quoted prompt>`: the
/// launched, VISIBLE session, seeded with what it was asked to do.
///
/// `promptArgs` is a prefix concatenated with the quoted prompt rather
/// than a flag joined by a space, because the two conventions in the
/// table need different spellings and one concatenation covers both:
///
///   ""          -> `claude 'do it'`            (the bare positional)
///   "--prompt=" -> `opencode --prompt='do it'` (a flag with its value ATTACHED)
///
/// The attached form is not cosmetic. opencode parses `--prompt <value>`
/// with yargs, which reads a value beginning with `-` as the next flag
/// and prints its usage banner instead of starting; `--prompt=<value>`
/// takes the same bytes and keeps them.
///
/// Null for a profile that takes NO prompt, so a mangled argv can never
/// be launched. That is the case this function exists to refuse: `cursor`
/// and bare `opencode` read their positional as a PATH, so handing either
/// a prompt starts nothing and reports nothing -- the session opens on a
/// directory that does not exist, or dies before there is a session at
/// all. Every caller must handle the null; there is nothing safe to fall
/// back to.
///
/// The conversation id goes BEFORE the prompt, because the prompt is a
/// positional and anything after it would be read as another one. Both
/// id arguments are dropped together: an id with no argv to carry it, or
/// argv with no id, would each put a stray token in front of the prompt.
export function buildRunCommand(
  agentCommand: string,
  promptArgs: string | null,
  prompt: string,
  sessionIdArgs = "",
  conversationId: string | null = null
): string | null {
  if (promptArgs === null) return null;
  const args = sessionIdArgs.trim();
  const fixId = args && conversationId ? ` ${args} ${conversationId}` : "";
  return `${agentCommand}${fixId} ${promptArgs}${shellQuote(prompt)}`;
}

/// A remembered launch command with a NEW conversation id in place of
/// the one baked into it, for a re-launch.
///
/// Replaying a command that carries `--session-id <uuid>` does not
/// merely repeat the conversation -- it fails: the CLI refuses with
/// "Session ID <uuid> is already in use" and nothing starts. Measured
/// against the real binary, not deduced from the help text.
///
/// The id is the first token after the profile's own argv, which always
/// sits ahead of the quoted prompt (see buildRunCommand), so the first
/// occurrence is the right one even for a prompt that happens to contain
/// the same flag. A command with no id in it comes back untouched and
/// with a null id -- which is what an older binding, or a profile with
/// no verified argv, looks like.
export function withFreshConversationId(
  command: string | null,
  sessionIdArgs: string
): { command: string | null; conversationId: string | null } {
  const args = sessionIdArgs.trim();
  if (!command || !args) return { command, conversationId: null };
  const marker = ` ${args} `;
  const at = command.indexOf(marker);
  if (at === -1) return { command, conversationId: null };
  const start = at + marker.length;
  const end = command.indexOf(" ", start);
  const conversationId = crypto.randomUUID();
  const tail = end === -1 ? "" : command.slice(end);
  return { command: command.slice(0, start) + conversationId + tail, conversationId };
}

/// `<command> <resume_args> <uuid>` -- the agent reopening the
/// conversation it was having, rather than a new agent reading an
/// account of it.
///
/// No prompt. Resume puts the agent back at the end of its own
/// transcript, and a prompt appended here would be a fresh instruction
/// on top of a conversation that already holds the whole task -- which
/// is the from-scratch second attempt this whole family of cards exists
/// to prevent, wearing a better name.
///
/// The id is REUSED, not forked (`--fork-session`). Measured: resuming
/// appends to the same `<uuid>.jsonl` transcript rather than rotating
/// it, so the failed attempt stays readable either way -- and the one
/// argument for forking was that it might not. One conversation per
/// step is simpler to display and simpler to reason about.
///
/// Null when the profile verified no resume argv, which is the signal to
/// fall back to `composeResumeTaskPrompt`.
///
/// Also null when the conversation's log is known to be MISSING. The id
/// is proof that a launch was attempted, not that a conversation
/// happened: gavin mints it before the agent has done anything at all,
/// so an agent that died at launch leaves an id with no transcript
/// behind it, and `<resume argv> <uuid>` has nothing to open -- the CLI
/// says so and exits, and a card that kept offering the button offered
/// it for ever. The caller tells a missing log apart from a missing argv
/// with `unresumableConversationReason`, because the two nulls want
/// different answers: fall through, or refuse and say why.
///
/// `unknown` builds the command. Only a log root gavin can see, which
/// does not hold the file, is evidence that the conversation is gone;
/// everywhere else -- a profile with no `TokenLog`, a CLI pointed at
/// another config dir, the check itself failing -- the CLI is the one
/// that answers, which is what it always did.
export function buildResumeCommand(
  agentCommand: string,
  resumeArgs: string,
  conversationId: string | null | undefined,
  log: ConversationLog = "unknown"
): string | null {
  const args = resumeArgs.trim();
  if (!args || !conversationId?.trim()) return null;
  if (log === "missing") return null;
  return `${agentCommand} ${args} ${conversationId.trim()}`;
}

/// Whether the conversation a binding recorded is still on this machine
/// to be reopened. Mirrors `ConversationLog` in `agent_tokens.rs`, which
/// is where the question is answered: the same resolver the token read
/// uses, so the two can never disagree about where a conversation lives.
///
/// Three values rather than a bool, because `unknown` and `missing` are
/// different sentences and only one of them may stop a resume.
export type ConversationLog = "present" | "missing" | "unknown";

/// Why a resume must not be launched, or null when it may be.
///
/// One sentence for every surface that offers Resume -- the detail
/// modal, the card menu, the column button, a rail step, auto-resume's
/// notification -- because they all reach the same launch, and a refusal
/// the human reads in one place has to be the refusal they read in the
/// others. It says what happened (the agent never completed a turn, so
/// it wrote nothing and edited nothing) and then `wayForward`, which is
/// the caller's to name: Re-launch on a card, Retry on a rail step. The
/// two verbs differ and the sentence must not guess.
///
/// Refusing, rather than quietly taking the written reconstruction, is
/// the point. That prompt tells the agent work on the card "already
/// started and stopped" and sends it looking for what was done -- which
/// for an agent that died at launch is nothing, under a verb that
/// promised continuity. `resume_args`'s own doc comment calls that the
/// silent fresh conversation wearing a better name.
export function unresumableConversationReason(
  log: ConversationLog,
  wayForward: string
): string | null {
  if (log !== "missing") return null;
  return (
    `This agent stopped before it wrote a line of its conversation, so there is nothing ` +
    `to resume. ${wayForward}`
  );
}

// Why this workspace's agent cannot be started on a card. Never about
// the card: it is about the agent the workspace CHOSE, which is a thing
// the human can go and change, so the sentence says where.
//
// A plain string rather than string|null, because every caller reaches
// it having already found out it is blocked -- buildRunCommand handed
// back null, or the surface is deciding whether to offer the action at
// all -- and needs the words, not a second verdict.
export function noPromptReason(agentLabel: string): string {
  return (
    `${agentLabel} takes no prompt on its command line, so gavin cannot start a card ` +
    `with it. Pick a different agent in Settings.`
  );
}

// The same answer in gitState's agentCommitBlocker shape, for the
// surfaces that bind a reason to a control rather than react to a failed
// launch. Hang it on a NON-disabled ancestor: a disabled element never
// fires mouseenter, so a tooltip bound to one can never appear.
export function agentPromptBlocker(
  promptArgs: string | null,
  agentLabel: string
): string | null {
  return promptArgs === null ? noPromptReason(agentLabel) : null;
}

/// The one instruction behind the Git tab's "Commit via agent". Fixed
/// text with nothing interpolated: the button IS the whole interaction,
/// so there is no user input to compose in -- and no NAME_TAB_FIRST
/// either, because this run has no tab to name. The app names its
/// session itself, for the case where the human reveals it.
export const COMMIT_PROMPT =
  "Commit pending and unversioned changes, in logical chunks. Do not push.";

// `<command> <headlessArgs><prompt>`: one prompt, no TUI, then exit.
// What a HIDDEN session needs -- an interactive agent sits at its prompt
// forever, and a session nobody can see never coming back is a spinner
// with no end, so a profile with no verified headless argv is refused
// here rather than launched and hoped for (agent_setup.rs's
// headless_args carries the argv, and only for verified rows).
//
// Two shapes, matching `buildRunCommand`'s promptArgs rule:
// - args ending in ` --`: positional prompt after a double-dash so a
//   leading `-` in the prompt is not eaten as a flag (claude, codex,
//   cursor, opencode).
// - args ending in `=`: flag-attached prompt with NO intervening space
//   (gemini's `--prompt=`), the same concatenation interactive
//   `--prompt=` rows already use.
export function buildHeadlessCommand(
  agentCommand: string,
  headlessArgs: string,
  prompt: string
): string | null {
  if (!headlessArgs.trim()) return null;
  const args = headlessArgs.trim();
  if (args.endsWith("=")) {
    return `${agentCommand} ${args}${shellQuote(prompt)}`;
  }
  return `${agentCommand} ${args} ${shellQuote(prompt)}`;
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

// Where the "Develop into a plan…" action is offered, for both surfaces
// that offer it (the card menu and the detail modal). To Do only: a card
// that has been started or finished is past the point where reshaping it
// helps, and a nested task -- no status of its own -- is already part of
// a developed plan. Bound cards are out too, since a develop run rewrites
// the card its agent is executing.
export function developAvailable(
  kind: "note" | "task" | "plan",
  status: string | null,
  bound: boolean
): boolean {
  if (kind === "note" || bound) return false;
  return slugStatus(status ?? "") === slugStatus("To Do");
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
// Resume carries the block too. It is the SAME card: an attachment the
// card records is as much a part of resuming it as of starting it, and a
// resume that quietly dropped the references would be the one run mode
// where the agent works blind.
export function composeResumeTaskPrompt(
  path: string,
  title: string,
  body: string,
  attachments: string[] = [],
  withheld: string[] = [],
  sessionIdDiscovery: string | null | undefined = null
): string {
  return (
    `${nameTabFirst(sessionIdDiscovery)}\n\n` +
    `Use the gavin-resume skill to resume the task card at ${path} ("${title}"). ` +
    `Work on it already started and stopped.` +
    `${attachmentPromptBlock(attachments, withheld)}\n\n` +
    `${body}\n\n` +
    `Find what is already done before you write anything, then carry on from there. ` +
    `Keep this card's status current with gavin_set_plan_field on ${path}; ` +
    `set it to the board's done column when finished.`
  );
}

export function composeResumePlanPrompt(
  path: string,
  attachments: string[] = [],
  withheld: string[] = [],
  sessionIdDiscovery: string | null | undefined = null
): string {
  return (
    `${nameTabFirst(sessionIdDiscovery)}\n\n` +
    `Use the gavin-resume skill to resume the plan at ${path}. Work on it already started ` +
    `and stopped: find what is already done before you write anything — the checklist's ` +
    `ticks are the record, but not the whole of it. Then work it top to bottom from there, ` +
    `ticking items (- [x]) as you complete them, promoting items that need their own agent ` +
    `with gavin_promote_task, and keeping the plan's status current with gavin_set_plan_field.` +
    attachmentPromptBlock(attachments, withheld)
  );
}

// The Review tab's launch: an agent brought up ON a card whose work is
// finished, so the human can ask about it beside the diff.
//
// It parts company with a resume in the one way that matters here: it
// says nothing about status. A resume tells the agent to keep the card's
// status current, which on a Done card means moving it out of the
// column that put it in front of the reviewer -- a surface that empties
// itself as you use it. So the instruction is inverted and stated,
// rather than merely left out: an agent that has read gavin's skill
// knows to keep a card's status current, and silence would be read as
// an oversight.
//
// It also opens by changing nothing. A review that starts by editing is
// a review nobody asked for, and the whole value of having the agent
// here is that the human can ask a question first. Nothing REFUSES a
// later edit: the human is at the terminal, and the next thing they type
// may well be "fix it".
export function composeReviewLaunchPrompt(
  path: string,
  title: string,
  kind: "task" | "plan",
  body: string,
  attachments: string[] = [],
  withheld: string[] = [],
  sessionIdDiscovery: string | null | undefined = null
): string {
  const subject = kind === "task" ? "task card" : "plan";
  // The body is quoted when there is one and skipped when there is not,
  // rather than always interpolated: a plan's body is its checklist,
  // which the agent is being sent to READ from the file, and an empty
  // paragraph in the middle of the prompt reads as a section that failed
  // to load.
  const quoted = body.trim() ? `\n\n${body.trim()}` : "";
  return (
    `${nameTabFirst(sessionIdDiscovery)}\n\n` +
    `The work for the ${subject} at ${path} ("${title}") is finished and is being reviewed. ` +
    `Read the card and find what the work actually did — the checklist, the files it ` +
    `touched, and the commits on this checkout — before you answer anything.` +
    `${attachmentPromptBlock(attachments, withheld)}${quoted}\n\n` +
    `Change nothing until you are asked to. Do not change this card's status: it is sitting ` +
    `in the column that put it in front of a reviewer, and moving it takes it off their list. ` +
    `Wait for the reviewer's first question.`
  );
}
