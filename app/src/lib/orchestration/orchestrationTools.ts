// The tool library, as pure data and pure functions (tools spec T7). No
// Svelte, no Tauri, no I/O -- toolsState.ts owns every side effect and
// orchestrationState.ts owns launching. TS mirrors of crates/protocol's
// ToolDef/ToolParam (camelCase on the wire).
//
// The one import is codeReview.ts, also pure: the review step's body is
// COMPOSED from the same function the Git tab and the card menu use, so
// a review files its findings the same way wherever it was started from.
// Two hand-kept copies of that instruction would drift into two card
// shapes on one board.
//
// A tool is a reusable unit of work droppable onto a rail: an agent
// prompt, a shell command line, or a bash script. Built-ins are
// constants here and never reach the daemon; everything else is stored
// per workspace or global to the machine.

import { isAbsolutePath } from "$lib/paths";
import { composeReviewPrompt, REVIEW_RULES_LABEL } from "$lib/review/codeReview";

/// `gavin` is the odd one out: an action the APP performs, with no
/// session and no checkout (tools spec T9). It is built-in-only -- the
/// library dialog never offers it -- because its body is not source the
/// human writes, it is the name of the action.
///
/// `until` is built-in-only for a different reason: its body IS a shell
/// command, but what makes it a kind rather than a `command` is its
/// COMPLETION RULE. A command step passes or stalls; an until step also
/// sends the rail BACKWARDS, re-running the step before it (see
/// orchestrationLoop.ts). The kind is where every other completion rule
/// in the scheduler already lives, so a duplicate of the tool -- or one
/// a newer gavin ships -- loops for the same reason this one does,
/// rather than because the scheduler recognised an id.
///
/// `pr` is built-in-only for the third reason: it has no body to run at
/// all. It waits on the pull request for the rail's branch, which gavin
/// reads with `gh` host-side (pull_request.rs) and the rail header draws
/// beside it -- one poll, so the chips and the verdict can never be
/// looking at different pull requests. Its completion rule is the `until`
/// rule with GitHub in place of a shell: pass, or send the rail back over
/// the work that failed. A `gavin` tool could not be it -- one of those
/// resolves inside its own launch and never passes through `running`
/// (tools spec §8.2), and waiting on CI is nothing but `running`.
///
/// `review` is the `pr` kind with a HUMAN in place of GitHub. It runs
/// nothing, takes no session and waits -- and the only thing that ends
/// the wait is the person: Skip sends the rail past it, Mark done says
/// the work was checked and passed. Both buttons already sit on a
/// running step, so the kind adds no control of its own; what it adds is
/// a step the scheduler will never finish by itself, which is exactly
/// what "hold here until I have looked at this" means.
///
/// A kind rather than a body, for the reason `until` is one: what makes
/// it this tool is its COMPLETION RULE, and the scheduler branches on
/// `kind` everywhere so a duplicate -- or one a newer gavin ships --
/// holds the rail for the same reason this one does rather than because
/// an id was recognised.
export type ToolKind = "agent" | "command" | "script" | "gavin" | "until" | "pr" | "review";

/// Where a tool came from. `builtin` is read-only -- the library dialog
/// offers Duplicate instead of Edit. Derived from the wire's
/// `workspaceId`, never stored: null is global, a string is that
/// workspace's own.
export type ToolScope = "builtin" | "global" | "workspace";

export interface ToolParam {
  /// `{{name}}` in the body.
  name: string;
  label: string;
  default: string;
}

export interface Tool {
  /// Built-ins use "builtin:<slug>"; everything else is a UUID.
  id: string;
  name: string;
  description: string;
  kind: ToolKind;
  body: string;
  params: ToolParam[];
  scope: ToolScope;
  /// Where this tool runs when it is launched STANDALONE from the Tools
  /// tab: relative resolves against the workspace root, absolute is kept
  /// as written, null is the root itself (see `resolveToolCwd`).
  ///
  /// A rail step ignores it, on purpose (spec T6/T11): a step runs in
  /// the rail's own checkout, because that is the checkout rail conflict
  /// detection is computed off. A step that quietly jumped out of its
  /// worktree would let two rails collide with nothing left to warn
  /// about.
  ///
  /// Optional so the built-ins below -- none of which wants a directory
  /// of its own -- do not each have to declare `cwd: null`.
  cwd?: string | null;
  /// The glyph this tool draws wherever tools are listed (v33): a NAME
  /// from `ui/iconLibrary.ts`, never an image. Null -- and absent, which
  /// is the same thing -- means "whatever this tool's KIND draws", which
  /// is what every tool authored before v33 means and what a tool
  /// nobody picked an icon for still means.
  ///
  /// Resolved through `toolIcon`, which falls back to the kind for a
  /// name it cannot look up. That is what makes a name a NEWER gavin
  /// offered survive a round trip through this build: it is stored and
  /// re-saved verbatim, and only the DRAWING degrades.
  ///
  /// Optional for the reason `cwd` is: the built-ins below wear their
  /// kinds' glyphs, and none of them should have to say so.
  icon?: string | null;
}

/// One tool as the daemon stores it. `workspaceId` IS the scope.
export interface ToolRecord {
  id: string;
  workspaceId: string | null;
  name: string;
  description: string;
  kind: ToolKind;
  body: string;
  params: ToolParam[];
  position: number;
  /// v30. Present on every record this app writes; a daemon older than
  /// 30 drops it on the way in and hands back a row without it, which
  /// reads as null -- the reason `toolCwd` is a compat gate rather than
  /// a field the dialog simply offers.
  cwd: string | null;
  /// v33, and the same shape and the same trap as `cwd` one field up: a
  /// daemon older than 33 takes the save, drops the name and hands back
  /// a row without it, which reads as null and draws the tool's kind.
  /// `toolIcon` in daemonCompat.ts is what keeps the picker from
  /// offering a choice that daemon would throw away.
  icon: string | null;
}

/// The kinds a human can AUTHOR, in the order the dialog's chips offer
/// them: the three that also run on their own first, then the four that
/// only mean something inside a rail.
///
/// It was the first three alone until 2026-09-04, and the reason it is
/// now all of them is worth keeping. `gavin`, `until` and `pr` were
/// withheld from the chips not because the SCHEDULER treats an authored
/// one differently -- every rule about them branches on `kind` and never
/// on a built-in id, so a copy has always worked -- but because the edit
/// form could not express their bodies. A `gavin` body names an action,
/// and a free-text box let one name nothing; a `pr` body is not run at
/// all, so a duplicate came back as a command whose text was the word
/// "await-pr". `toolBodyEditor` below is what removed that obstacle: the
/// form now draws a SELECT for an action and no body field at all for a
/// wait, so each kind is authorable in the shape it actually has.
///
/// `review` is offered for that same reason and one of its own: a rail
/// with two review gates on it wants to say what each is FOR, and the
/// only place a human can say that is a duplicate with a name of its
/// own ("Check the migration"). Duplicating is the whole of that, so
/// withholding the chip would withhold the feature.
export const TOOL_KINDS: ToolKind[] = [
  "agent",
  "command",
  "script",
  "until",
  "pr",
  "review",
  "gavin",
];

export function toolKindLabel(kind: ToolKind): string {
  return kind === "agent"
    ? "Agent prompt"
    : kind === "command"
      ? "Bash command"
      : kind === "gavin"
        ? "Gavin action"
        : kind === "until"
          ? "Loop until"
          : kind === "pr"
            ? "Wait on a pull request"
            : kind === "review"
              ? "Wait for a manual review"
              : "Bash script";
}

/// The actions a `gavin` tool can name. The body is the selector rather
/// than the tool id, so a `gavin` tool stays DATA like every other one
/// (spec T7) -- the scheduler branches on what the tool says it does,
/// not on which constant it happens to be.
export const GAVIN_ACTIONS = ["start-rail"] as const;
export type GavinAction = (typeof GAVIN_ACTIONS)[number];

/// The action this tool performs, or null -- for a tool of another kind,
/// and for a `gavin` tool naming an action this version does not have.
/// The caller stalls on null rather than guessing.
export function gavinActionOf(tool: Pick<Tool, "kind" | "body">): GavinAction | null {
  if (tool.kind !== "gavin") return null;
  const named = tool.body.trim();
  return (GAVIN_ACTIONS as readonly string[]).includes(named) ? (named as GavinAction) : null;
}

/// Workspaces `builtin:start-rail`'s picker may offer as a target: every
/// ROOTED workspace but the rail's own. An unrooted workspace has no
/// `.gavin-root` and so no orchestration plan a rail could run in --
/// offering one would be a choice that always refuses.
export function startRailWorkspaceChoices<W extends { id: string; rootPath?: string | null }>(
  workspaces: W[],
  ownWorkspaceId: string
): W[] {
  return workspaces.filter((w) => w.id !== ownWorkspaceId && w.rootPath);
}

export function isBuiltinId(id: string): boolean {
  return id.startsWith("builtin:");
}

// ---- Authoring one ---------------------------------------------------------

/// A `pr` tool's body. Nothing runs it -- gavin reads GitHub itself
/// (pull_request.rs) and the step is over when the pull request says so
/// -- but the body still says what the step DOES, so a rail read on
/// paper is legible. The same reason `builtin:start-rail`'s body names
/// its action rather than hiding it in a branch on the id.
export const PR_BODY = "await-pr";

/// A `review` tool's body, on the same principle as PR_BODY: nothing
/// runs it, and it exists so a rail read on paper says what the step
/// does. `validateTool` also insists every tool has a body, and "" would
/// make the one kind with nothing to write the one kind that cannot be
/// saved.
export const REVIEW_BODY = "await-review";

/// How a kind's body is authored. Three shapes, because the six kinds
/// have three different relationships with their bodies:
///
/// - `text` — the body IS source the human writes: a prompt, a command
///   line, a script, or the shell check an `until` step loops on.
/// - `action` — the body NAMES something this app implements, so the
///   form offers the names rather than a text box. Only `gavin`.
/// - `none` — there is no body to write. `pr` and `review`, the two
///   kinds that run nothing at all.
///
/// A descriptor rather than a chain of ternaries in the template,
/// because the same three questions (what to call the field, how tall,
/// whether it is monospaced) were already being asked three times over
/// three kinds, and adding three more kinds to that is where the answers
/// start to disagree with each other.
export type ToolBodyEditor =
  | {
      shape: "text";
      label: string;
      placeholder: string;
      rows: number;
      /// Monospaced, and spellcheck off: shell source, not prose.
      mono: boolean;
    }
  | { shape: "action"; label: string }
  | { shape: "none"; note: string };

export function toolBodyEditor(kind: ToolKind): ToolBodyEditor {
  switch (kind) {
    case "agent":
      return {
        shape: "text",
        label: "Prompt",
        placeholder: "What the agent should do, in this rail's checkout.",
        rows: 8,
        mono: false,
      };
    case "command":
      return {
        shape: "text",
        label: "Command",
        placeholder: "./deploy.sh {{env}}",
        rows: 3,
        mono: true,
      };
    case "until":
      return {
        shape: "text",
        label: "Check command",
        placeholder: "npm test",
        rows: 3,
        mono: true,
      };
    case "gavin":
      return { shape: "action", label: "Action" };
    case "pr":
      return {
        shape: "none",
        note:
          "Nothing to write: gavin reads the pull request for this rail's branch itself. " +
          "What the step waits for is a parameter, not a body.",
      };
    case "review":
      return {
        shape: "none",
        note:
          "Nothing to write: this step runs nothing at all. It holds the rail where it is " +
          "so you can read the work — and go on editing it, or put an agent back on it — " +
          "until you press Skip on the step to send the rail past it.",
      };
    default:
      return {
        shape: "text",
        label: "Script",
        placeholder: "./deploy.sh {{env}}",
        rows: 8,
        mono: true,
      };
  }
}

/// Whether a body is one of the fixed texts a kind imposes rather than
/// something a human typed. Used only to decide what switching kinds may
/// throw away.
function isFixedBody(body: string): boolean {
  const said = body.trim();
  return (
    said === PR_BODY ||
    said === REVIEW_BODY ||
    (GAVIN_ACTIONS as readonly string[]).includes(said)
  );
}

/// The body a draft carries after the human picks a different kind.
///
/// Three of the kinds have no body a human writes, and all three still
/// need one: `gavinActionOf` READS a `gavin` body, and a `pr` or
/// `review` body is what makes the step legible on paper. So switching
/// to any of them replaces whatever was in the box. `stashed` is the authored body held across that swap
/// -- switching back restores it, so a stray click on a chip costs a
/// click rather than eight lines of prompt.
///
/// Null is "nothing was ever put away", which an EMPTY STRING is not: a
/// new tool starts with a blank body, and a blank one restored is the
/// blank the human was looking at. Conflating the two is what leaves
/// "await-pr" sitting in a brand-new tool's Command field.
///
/// Switching to `gavin` keeps a body that already names an action, so
/// re-picking the chip a draft is already on changes nothing.
export function bodyForKind(kind: ToolKind, current: string, stashed: string | null): string {
  if (kind === "pr") return PR_BODY;
  if (kind === "review") return REVIEW_BODY;
  if (kind === "gavin") {
    return gavinActionOf({ kind, body: current }) ? current.trim() : GAVIN_ACTIONS[0];
  }
  return isFixedBody(current) && stashed !== null ? stashed : current;
}

/// What a kind reads its PARAMETERS as, for the hint under the parameter
/// grid — or null for the three whose params are only text substituted
/// into a body.
///
/// The three that need this are the three whose params are ARGUMENTS:
/// nothing pastes them into the body, so a human authoring one from
/// scratch has no way to discover the names from the form. Getting a
/// name wrong is silent by design -- `summaryParam` ignores a param the
/// tool does not declare, so a budget typed into `retries` reads as no
/// budget at all rather than as an error.
export function toolKindParamNote(kind: ToolKind): string | null {
  switch (kind) {
    case "until":
      return "The check is the body. This kind also reads a `max` parameter — how many times it may send the rail back before giving up.";
    case "pr":
      return "This kind reads a `require` parameter (checks / approval) and a `max` — how many times a failing check may send the rail back.";
    case "gavin":
      return "The parameters are the action's arguments: `start-rail` reads `rail`, the name of the rail to arm, and an optional `workspace` -- which workspace it is in, blank for this rail's own.";
    default:
      return null;
  }
}

// ---- The built-in set ------------------------------------------------------
// Seventeen tools covering every example the cards named, and
// demonstrating all three authorable kinds. Data, not code: nothing
// about running any of them is special.
//
// The last two, Consolidate repo and Reconcile repo, are the ones the
// Tools tab was asked for by name, and they are the two written for a
// WORKSPACE rather than for a rail: neither assumes a branch of its own,
// and both are jobs a human does to a repository between pieces of work
// rather than as a step inside one. They are ordinary `agent` tools all
// the same -- a rail can carry either, and the Tools tab offers every
// agent, command and script tool in the library beside them. They are
// APPENDED rather than slotted in beside the other agent tools because
// this list's order is the order the library draws, and a new tool
// belongs at the end of it.
//
// Four are not like the others, because their bodies are not source a
// human writes in a text box. Start rail is the `gavin` kind: arming
// another rail is not a shell command and not a prompt, it is something
// only this app can do, and its body names the action rather than hiding
// it in a branch on the id. Loop until a check passes is the `until`
// kind: its body IS a shell command, but its verdict can send the rail
// backwards, and that is a completion rule rather than a body. Wait for
// the pull request is the `pr` kind, which has no body to run at all --
// gavin reads GitHub itself, and the step is over when the pull request
// says so. Manual review is the `review` kind, which runs nothing and
// waits on a PERSON: the rail stops there until somebody has looked.
//
// Merge ships TWICE, once per direction, because a step always runs in
// the rail's own checkout and only the inbound direction is reachable
// from there.
//
// Substitution is LITERAL (spec T3) -- the tool author owns the quoting.
// The bodies below are written with that in mind.

export const BUILTIN_TOOLS: Tool[] = [
  {
    id: "builtin:commit",
    name: "Commit changes",
    description: "An agent reads the diff and commits it in logical chunks. Never pushes.",
    kind: "agent",
    scope: "builtin",
    params: [],
    body:
      "Commit the uncommitted work in this checkout.\n\n" +
      "1. Read `git status` and `git diff` (staged and unstaged) before deciding anything.\n" +
      "2. Group unrelated changes into SEPARATE commits rather than one catch-all.\n" +
      "3. Write a conventional-commit subject for each (`feat(scope): …`, `fix(scope): …`), " +
      "describing what changed and why, not which files moved.\n" +
      "4. Do NOT push, and do not amend or rewrite any existing commit.\n\n" +
      "If there is nothing to commit, say so and stop — that is a success, not a problem.",
  },
  {
    id: "builtin:push",
    name: "Push branch",
    description: "Pushes the checked-out branch, setting upstream on first push.",
    kind: "command",
    scope: "builtin",
    params: [{ name: "remote", label: "Remote", default: "origin" }],
    body: "git push -u {{remote}} HEAD",
  },
  {
    id: "builtin:merge",
    name: "Update from a branch",
    description:
      "An agent merges a branch INTO this rail's checkout, resolving conflicts or aborting " +
      "cleanly. It brings that branch's work here — it lands this rail nowhere.",
    kind: "agent",
    scope: "builtin",
    params: [{ name: "branch", label: "Branch to merge in", default: "main" }],
    body:
      "Merge the branch `{{branch}}` into the branch checked out in this worktree.\n\n" +
      "This is the INBOUND direction: it brings `{{branch}}` here. It does not land this " +
      "branch on `{{branch}}` — the “Merge this rail into a branch” tool does that.\n\n" +
      "1. Run `git merge --no-edit {{branch}}`.\n" +
      "2. If it conflicts, resolve each conflict by understanding BOTH sides — never by " +
      "taking one wholesale — then run the project's tests before committing the merge.\n" +
      "3. If you cannot resolve a conflict confidently, run `git merge --abort` and explain " +
      "exactly what blocked you. An aborted merge is a better outcome than a wrong one.\n\n" +
      "Do not push.",
  },
  {
    id: "builtin:merge-into",
    name: "Merge this rail into a branch",
    description:
      "An agent lands this rail's branch on another one, merging in the checkout that HOLDS " +
      "that branch — the rail's own worktree cannot do it.",
    kind: "agent",
    scope: "builtin",
    params: [{ name: "base", label: "Branch to land on", default: "main" }],
    // The merge deliberately runs somewhere else. A step always runs in
    // the rail's checkout, and from there the landing direction is
    // unreachable: git refuses to check `{{base}}` out while another
    // worktree holds it, and merging this branch into itself exits 0
    // having done nothing. `git -C <the checkout that has it>` is the
    // same move the Git tab's own merge-back makes (gitState.mergeBack).
    body:
      "Land the work in this checkout on the branch `{{base}}`, by merging it there.\n\n" +
      "The merge cannot run here: git will not let you check `{{base}}` out while another " +
      "worktree holds it, and merging this branch into itself does nothing. Run it in the " +
      "checkout that HAS `{{base}}`.\n\n" +
      "1. `git rev-parse --abbrev-ref HEAD` — the branch to land. If it is already " +
      "`{{base}}`, stop and say so: this rail has no branch of its own to merge.\n" +
      "2. `git status --short` — uncommitted changes here do NOT travel with a merge. If " +
      "there are any, stop and list them rather than committing them yourself.\n" +
      "3. `git worktree list` — find the checkout holding `{{base}}`, then merge from there: " +
      "`git -C <that checkout> merge --no-edit <this branch>`. If no worktree has `{{base}}` " +
      "checked out, stop and say so.\n" +
      "4. If git refuses because that checkout has local changes, report its message and " +
      "stop. Never commit, stash or discard work you did not write — that checkout is " +
      "someone else's, and its stash stack is shared.\n" +
      "5. If it conflicts, resolve each conflict by understanding BOTH sides — never by " +
      "taking one wholesale — then run the project's tests before committing the merge. If " +
      "you cannot resolve one confidently, run `git -C <that checkout> merge --abort` and " +
      "explain exactly what blocked you. Leaving that checkout mid-merge is the worst " +
      "outcome available here.\n\n" +
      "Do not push, and do not remove this worktree or delete this branch.",
  },
  {
    id: "builtin:open-pr",
    name: "Open a pull request",
    description: "Opens a PR from the current branch with the GitHub CLI. Requires `gh`.",
    kind: "command",
    scope: "builtin",
    params: [{ name: "base", label: "Base branch", default: "main" }],
    body: "gh pr create --fill --base {{base}} --head \"$(git rev-parse --abbrev-ref HEAD)\"",
  },
  {
    id: "builtin:run-tests",
    name: "Run tests",
    description: "Runs the project's test command. The step is done when it exits 0.",
    kind: "command",
    scope: "builtin",
    params: [{ name: "command", label: "Test command", default: "npm test" }],
    body: "{{command}}",
  },
  {
    id: "builtin:until",
    name: "Loop until a check passes",
    description:
      "Runs a check; while it fails, sends the rail back to re-run the step before this one, " +
      "up to the attempt budget. An agent step is retried with the check's output in its prompt.",
    kind: "until",
    scope: "builtin",
    params: [
      { name: "check", label: "Check command", default: "npm test" },
      { name: "max", label: "Retries", default: "5" },
    ],
    // Only `check` appears here. `max` is read as an ARGUMENT by the
    // scheduler (untilMax), the way the Start rail tool reads `rail` --
    // pasting a number into the command line would be meaningless.
    body: "{{check}}",
  },
  {
    id: "builtin:await-pr",
    name: "Wait for the pull request",
    description:
      "Waits on the pull request for this rail's branch — CI, and optionally an approval. " +
      "A failing check sends the rail back to re-run the step before this one. Never merges.",
    kind: "pr",
    scope: "builtin",
    params: [
      // Free text on purpose (prRequirement reads it loosely): the
      // dialog has one field shape, and "checks and approval" is what a
      // human types when asked what to wait for.
      { name: "require", label: "Wait for (checks / approval)", default: "checks" },
      { name: "max", label: "Retries", default: "3" },
    ],
    // Nothing to substitute: the branch comes from the rail's binding
    // and the pull request from GitHub. The body still says what the
    // step does, so a plan read on paper is legible -- the same reason
    // `builtin:start-rail`'s body names its action.
    body: "await-pr",
  },
  {
    id: "builtin:manual-review",
    name: "Manual review",
    description:
      "Holds the rail here until you have looked at the work yourself. Runs nothing and " +
      "starts no agent — press Skip on the step to send the rail on.",
    kind: "review",
    scope: "builtin",
    // No parameters, deliberately. There is nothing for the step to
    // resolve -- it runs no command and writes no prompt -- and a
    // free-text "what to check" field would be a note nothing displays.
    // A rail that wants to say WHY it stops here duplicates this tool
    // and renames the copy, which is the name the chip already draws.
    params: [],
    // Nothing runs it. The body says what the step does so a rail read
    // on paper is legible, exactly as `builtin:await-pr`'s does.
    body: REVIEW_BODY,
  },
  {
    id: "builtin:unity-tests",
    name: "Run Unity tests",
    description: "Runs a Unity project's test platform in batch mode, logging to the terminal.",
    kind: "command",
    scope: "builtin",
    params: [
      {
        name: "unity",
        label: "Unity executable",
        default: "/Applications/Unity/Hub/Editor/6000.0.32f1/Unity.app/Contents/MacOS/Unity",
      },
      { name: "project", label: "Project path", default: "." },
      { name: "platform", label: "Test platform (EditMode / PlayMode)", default: "EditMode" },
      { name: "results", label: "Results file", default: "TestResults.xml" },
    ],
    body:
      '"{{unity}}" -runTests -batchmode -projectPath "{{project}}" ' +
      '-testPlatform {{platform}} -testResults "{{results}}" -logFile -',
  },
  {
    id: "builtin:browser-test",
    name: "Browser test (Chrome)",
    description: "An agent drives the Claude-in-Chrome tools through a checklist against a URL.",
    kind: "agent",
    scope: "builtin",
    params: [
      { name: "url", label: "URL", default: "http://localhost:5173" },
      {
        name: "checks",
        label: "Checks (one per line)",
        default: "- the page renders with no console errors",
      },
    ],
    body:
      "Use the Claude-in-Chrome browser tools to test {{url}}.\n\n" +
      "Open it in a NEW tab, then verify each of these:\n{{checks}}\n\n" +
      "Read the console with read_console_messages and report any errors. " +
      "Report pass/fail per check with the evidence you actually saw — never assume a " +
      "check passed because the page loaded. Close the tab when you are done.",
  },
  {
    id: "builtin:code-review",
    name: "Review this branch",
    description:
      "An agent reviews the branch's diff and files each finding as a card. Changes no code.",
    kind: "agent",
    scope: "builtin",
    params: [{ name: "base", label: "Compare against", default: "main" }],
    // Composed, not written out: the same instruction the Git tab and
    // the card menu hand their agents. `{{base}}` survives composition
    // because substitution is literal and happens at LAUNCH -- the body
    // stored here is a template like every other tool's.
    //
    // The context folder is null and the rules path relative, because
    // this one body is shared by every workspace: a step runs in the
    // rail's own checkout, so `.gavin-root/REVIEW.md` resolves there,
    // and the context to file into is the agent's to look up.
    body: composeReviewPrompt({
      base: "{{base}}",
      rulesPath: REVIEW_RULES_LABEL,
      contextFolder: null,
      plansFolder: null,
      nameTab: false,
    }),
  },
  {
    id: "builtin:notify",
    name: "Send a notification",
    description: "A macOS notification via osascript. A quote in the text will break it.",
    kind: "command",
    scope: "builtin",
    params: [
      { name: "title", label: "Title", default: "gavin" },
      { name: "message", label: "Message", default: "The rail reached this step." },
    ],
    body: `osascript -e 'display notification "{{message}}" with title "{{title}}"'`,
  },
  {
    id: "builtin:send-email",
    name: "Send an email (Mail.app)",
    description: "Sends through macOS Mail.app via osascript. A quote in the text will break it.",
    kind: "script",
    scope: "builtin",
    params: [
      { name: "to", label: "To", default: "" },
      { name: "subject", label: "Subject", default: "gavin: the rail finished" },
      { name: "body", label: "Body", default: "The rail reached this step." },
    ],
    // The heredoc is single-quoted, so the SHELL expands nothing inside
    // it -- every {{param}} is already substituted by the time this runs.
    body: [
      "set -euo pipefail",
      "osascript <<'APPLESCRIPT'",
      'tell application "Mail"',
      "  set gavinMessage to make new outgoing message with properties " +
        '{subject:"{{subject}}", content:"{{body}}", visible:false}',
      "  tell gavinMessage",
      "    make new to recipient at end of to recipients with properties " +
        '{address:"{{to}}"}',
      "    send",
      "  end tell",
      "end tell",
      "APPLESCRIPT",
    ].join("\n"),
  },
  {
    id: "builtin:start-rail",
    name: "Start rail",
    description:
      "Arms another rail by name — the last step of a rail that unblocks the next one. Its " +
      "own workspace by default, or one you pick. Runs inside gavin: no session, no checkout.",
    kind: "gavin",
    scope: "builtin",
    params: [
      // No default. A rail name is the one parameter no shipped value can
      // guess, and an empty one refuses at launch with a message naming
      // the field rather than arming somebody else's rail.
      { name: "rail", label: "Rail to start", default: "" },
      // Empty means the rail's own workspace, which is what every step
      // written before this parameter existed already means. A non-empty
      // value is a workspace ID from StepParamsDialog's picker -- see
      // startRailTargetWorkspace in orchestration.ts.
      { name: "workspace", label: "Workspace (optional — defaults to this rail's own)", default: "" },
    ],
    body: "start-rail",
  },
  {
    id: "builtin:consolidate-repo",
    name: "Consolidate repo",
    description:
      "An agent commits a dirty tree feature by feature — only the files each change touches. " +
      "Never `git add -A`, never pushes.",
    kind: "agent",
    scope: "builtin",
    params: [],
    // Deliberately narrower than "Commit changes" above, which groups
    // what it finds and stops there. This one is written for the tree
    // several agents have been editing at once: the grouping rule is
    // per-FEATURE rather than per-change, and the staging rule is
    // explicit, because `git add -A` in a shared checkout commits
    // somebody else's half-finished work under this run's message.
    body:
      "Consolidate the uncommitted work in this checkout into a series of clean commits.\n\n" +
      "This tree may carry work from SEVERAL pieces of work at once, so the job is to " +
      "separate them, not to bank them.\n\n" +
      "1. Read `git status` and the full diff (staged and unstaged) before deciding anything. " +
      "Read the changed files themselves where the diff alone does not say what a change is for.\n" +
      "2. Group the changes by FEATURE — one commit per coherent piece of work, however many " +
      "files it spans. A file touched by two features is split with `git add -p`.\n" +
      "3. Stage each commit by naming its own paths (`git add <path> …`). Never `git add -A`, " +
      "`git add .` or `git commit -a`: they would sweep in work you have not read.\n" +
      "4. Write a conventional-commit subject for each (`feat(scope): …`, `fix(scope): …`) and " +
      "a body explaining WHY the change is right — the constraint it respects, the failure it " +
      "prevents. Never attribute the work to an agent or an AI.\n" +
      "5. Leave anything you cannot confidently attribute UNCOMMITTED, and list it at the end. " +
      "An honest leftover is a better outcome than a commit that mixes two features.\n" +
      "6. Do NOT push, and do not amend, rebase or rewrite any existing commit.\n\n" +
      "If there is nothing to commit, say so and stop — that is a success, not a problem.",
  },
  {
    id: "builtin:reconcile-repo",
    name: "Reconcile repo",
    description:
      "An agent reports every branch and worktree against a base: what is merged, what is " +
      "behind, what looks abandoned. Reads only — deletes nothing.",
    kind: "agent",
    scope: "builtin",
    params: [{ name: "base", label: "Compare against", default: "main" }],
    // A REPORT, and the prompt says so three times, because the obvious
    // next step from every finding here is a delete -- and a branch that
    // looks abandoned to a reader of `git log` is regularly one somebody
    // is working in another checkout. What to remove is the human's
    // call; what exists is the question this answers.
    body:
      "Report the state of every branch and worktree in this repository against `{{base}}`.\n\n" +
      "This is a REPORT. Do not delete a branch, remove a worktree, merge, rebase, push or " +
      "commit anything — not even something that looks obviously dead.\n\n" +
      "1. `git worktree list` and `git branch -vv` — what exists, and which checkout holds each " +
      "branch. A branch checked out somewhere else is in use, whatever its log says.\n" +
      "2. For each branch, compare it with `{{base}}`: `git rev-list --left-right --count " +
      "{{base}}...<branch>` gives how far behind and ahead it is, and " +
      "`git branch --merged {{base}}` says whether its work already landed.\n" +
      "3. Sort every branch into one of: MERGED (its work is in `{{base}}`; nothing would be " +
      "lost by removing it), BEHIND (unmerged work, but `{{base}}` has moved on), ACTIVE " +
      "(unmerged and recently touched), or UNCLEAR — and use UNCLEAR rather than guessing.\n" +
      "4. Name any worktree whose branch is gone, and any that has uncommitted changes: those " +
      "are the two states that lose work when somebody tidies up.\n" +
      "5. Finish with a short table: branch, worktree, ahead/behind, last commit date, verdict. " +
      "Say what you would suggest removing and why — and stop there, without removing it.",
  },
];

// ---- Resolution ------------------------------------------------------------

/// The whole library the tab offers: built-ins, then the daemon's rows.
/// A workspace tool SHADOWS a global one with the same id -- ids are
/// unique in SQLite, so that only happens when a tool changed scope and
/// a stale row survived, in which case the workspace's own wins.
export function toolLibrary(records: ToolRecord[]): Tool[] {
  const byId = new Map<string, Tool>();
  for (const tool of BUILTIN_TOOLS) byId.set(tool.id, tool);
  for (const record of records) {
    // A built-in id in the store is not writable through the app, but a
    // hand-edited database must not be able to replace a built-in.
    if (isBuiltinId(record.id)) continue;
    const existing = byId.get(record.id);
    if (existing && existing.scope === "workspace" && record.workspaceId === null) continue;
    byId.set(record.id, {
      id: record.id,
      name: record.name,
      description: record.description,
      kind: record.kind,
      body: record.body,
      params: record.params,
      scope: record.workspaceId === null ? "global" : "workspace",
      // `?? null` rather than passed straight through: a row written by
      // a daemon older than v30 has no `cwd` key at all, and undefined
      // and null must not be two spellings of "runs at the root".
      cwd: record.cwd ?? null,
      // Same rule for the same reason, one version later: a row from a
      // daemon older than v33 has no `icon` key, and "wears its kind's
      // glyph" must have one spelling.
      icon: record.icon ?? null,
    });
  }
  return [...byId.values()];
}

export function findTool(library: Tool[], toolId: string): Tool | undefined {
  return library.find((t) => t.id === toolId);
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/// Every distinct `{{placeholder}}` in a body, in first-appearance
/// order. The library dialog uses this to flag a placeholder no param
/// declares -- the single most likely authoring mistake.
export function placeholdersIn(body: string): string[] {
  const seen: string[] = [];
  for (const match of body.matchAll(PLACEHOLDER)) {
    if (!seen.includes(match[1])) seen.push(match[1]);
  }
  return seen;
}

/// Placeholders the body uses that no parameter declares.
export function undeclaredPlaceholders(tool: Pick<Tool, "body" | "params">): string[] {
  const declared = new Set(tool.params.map((p) => p.name));
  return placeholdersIn(tool.body).filter((name) => !declared.has(name));
}

/// The body with every declared `{{param}}` replaced by the step's
/// override, else the param's default.
///
/// Substitution is LITERAL and one-pass: a value containing `{{x}}` is
/// NOT re-scanned, so a parameter can never expand into another. An
/// UNDECLARED placeholder is left verbatim -- silently blanking a typo
/// like `{{brnach}}` would turn an authoring mistake into a command that
/// runs against the wrong thing.
export function resolveToolBody(
  tool: Pick<Tool, "body" | "params">,
  overrides: Record<string, string>
): string {
  const value = new Map<string, string>();
  for (const param of tool.params) {
    value.set(param.name, overrides[param.name] ?? param.default);
  }
  return tool.body.replace(PLACEHOLDER, (whole, name: string) => value.get(name) ?? whole);
}

/// The value a step will actually use for ONE declared param: its
/// override, else the tool's own default. `""` when the tool declares no
/// such param, which is the same answer an empty default gives -- every
/// caller treats empty as "not supplied".
///
/// resolveToolBody is the substitution path; this is the read path, for
/// a `gavin` action whose params are arguments rather than text to paste
/// into a body.
export function resolveToolParam(
  tool: Pick<Tool, "params">,
  overrides: Record<string, string>,
  name: string
): string {
  const param = tool.params.find((p) => p.name === name);
  if (!param) return "";
  return overrides[name] ?? param.default;
}

/// A one-line summary of the params a step actually OVERRODE, for the
/// chip. Empty when the step runs the tool as it ships, which is the
/// common case and deserves no visual weight.
export function describeOverrides(
  tool: Pick<Tool, "params">,
  overrides: Record<string, string>
): string {
  return tool.params
    .filter((p) => p.name in overrides && overrides[p.name] !== p.default)
    .map((p) => `${p.name}=${overrides[p.name]}`)
    .join(" · ");
}

/// Drops overrides equal to the tool's own default, so a later edit to
/// that default still reaches steps that never deliberately overrode it
/// (spec §5.4). Also drops overrides for params the tool no longer has.
export function pruneOverrides(
  tool: Pick<Tool, "params">,
  overrides: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const param of tool.params) {
    const value = overrides[param.name];
    if (value !== undefined && value !== param.default) out[param.name] = value;
  }
  return out;
}

/// A blank tool for the library dialog's New. Workspace-scoped by
/// default: the narrower scope is the safer one to start from.
export function emptyTool(id: string): Tool {
  return {
    id,
    name: "",
    description: "",
    kind: "command",
    body: "",
    params: [],
    scope: "workspace",
    cwd: null,
    icon: null,
  };
}

/// A built-in copied into an editable tool. The name is suffixed so the
/// duplicate is distinguishable in a list beside its original.
export function duplicateTool(tool: Tool, id: string): Tool {
  return {
    ...tool,
    id,
    name: `${tool.name} (copy)`,
    params: tool.params.map((p) => ({ ...p })),
    scope: "workspace",
  };
}

/// Wire shape for a save. Built-ins can never be saved, so this refuses
/// them rather than letting the daemon's error be the only guard.
export function toRecord(tool: Tool, workspaceId: string, position: number): ToolRecord {
  if (tool.scope === "builtin") throw new Error("a built-in tool cannot be saved");
  return {
    id: tool.id,
    workspaceId: tool.scope === "global" ? null : workspaceId,
    name: tool.name.trim(),
    description: tool.description.trim(),
    kind: tool.kind,
    body: tool.body,
    params: tool.params,
    position,
    // An untouched field is not a directory. Normalised to null here so
    // the daemon, the launcher and the row all read "runs at the root"
    // the same way -- the store trims too, but a record that carried
    // `"  "` would still show a blank directory on the tab.
    cwd: tool.cwd?.trim() ? tool.cwd.trim() : null,
    // Kept VERBATIM rather than checked against the library, and that is
    // the deliberate half: a name this build cannot draw is still a name
    // its author picked -- from a newer gavin, or from a library entry
    // since renamed -- and dropping it on an unrelated edit would take
    // their choice away silently. `toolIcon` degrades the drawing; the
    // record keeps the fact. Blank normalises to null so "wears its
    // kind's glyph" has one spelling on the wire.
    icon: tool.icon?.trim() ? tool.icon.trim() : null,
  };
}

/// Where a tool launched STANDALONE runs: its own `cwd` resolved against
/// the workspace root. Absolute is kept as written, relative is joined
/// to the root, and no directory at all IS the root.
///
/// Not used by rails, deliberately (spec T6/T11) -- a rail step runs in
/// `worktreePath ?? rootPath` and never asks the tool. Rail conflict
/// detection is computed off that checkout, so a step that resolved a
/// tool's own directory would let two rails work the same tree with
/// nothing left to warn about.
///
/// Null when there is no root to resolve against, which is the caller's
/// cue to refuse the launch rather than start a session in whatever
/// directory the app happens to have.
export function resolveToolCwd(tool: Pick<Tool, "cwd">, rootPath: string | null): string | null {
  const own = tool.cwd?.trim() ?? "";
  // Absolute on either alphabet: a tool committed to a repo may name a
  // `C:\tools\x` directory, and treating that as relative would join it
  // onto the root and start the session somewhere that does not exist.
  if (isAbsolutePath(own)) return own;
  if (!rootPath) return null;
  if (!own || own === ".") return rootPath;
  // Plain join: a `..` segment is the human's own business, and
  // rewriting the path they typed would make the field lie about where
  // the tool runs. The trailing slash is trimmed so the two spellings of
  // one root produce one string.
  return `${rootPath.replace(/\/+$/, "")}/${own.replace(/^\.\//, "")}`;
}

/// What is wrong with a tool the human is editing, or null. Checked in
/// the dialog so the message names the field rather than arriving as a
/// daemon error after the save.
export function validateTool(tool: Tool): string | null {
  if (!tool.name.trim()) return "A tool needs a name.";
  if (!tool.body.trim()) return "A tool needs a body.";
  // The dialog draws a `gavin` body as a select over GAVIN_ACTIONS, so
  // this is reachable only from a tool whose action a NEWER gavin named
  // and this one does not have. Refused rather than saved: such a tool
  // stalls every step it is dropped onto, with the mistake discoverable
  // only at launch.
  if (tool.kind === "gavin" && !gavinActionOf(tool)) {
    return `“${tool.body.trim()}” is not a gavin action.`;
  }
  const seen = new Set<string>();
  for (const param of tool.params) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(param.name)) {
      return `“${param.name}” is not a usable parameter name — letters, digits and underscores, not starting with a digit.`;
    }
    if (seen.has(param.name)) return `Two parameters are both called “${param.name}”.`;
    seen.add(param.name);
  }
  // A working directory with a `{{param}}` in it would look substituted
  // and would not be: resolveToolCwd is the resolve path, and only
  // resolveToolBody substitutes. Refused here so the mistake is a
  // message naming the field rather than a session started in a
  // directory called `{{env}}`.
  if (tool.cwd && placeholdersIn(tool.cwd).length > 0) {
    return "A working directory can't take a {{parameter}} — only the body is substituted.";
  }
  return null;
}
