// The review flow's pure half: where a workspace's review rules live,
// what base a review defaults to, and the prompts a review agent is
// handed. No Svelte, no Tauri, no I/O -- codeReviewActions.ts owns the
// session and the surfaces own the dialog.
//
// A review's OUTPUT is cards, not a paragraph in a terminal. That is the
// whole reason this exists as more than the `builtin:code-review` rail
// step it grew out of: an agent's findings scroll off the screen, and a
// finding nobody can assign, order or tick is not work -- it is a
// message. Everything below is written so the agent finishes by filing
// them.

import { NAME_TAB_FIRST, noPromptReason } from "$lib/cards/cardRun";
import type { BranchInfo } from "$lib/git/git";

// ---- The review-rules file -------------------------------------------------

/// The gavin marker directory: `.gavin-root` for the workspace's root
/// context, `.gavin` for every nested one. Mirrors the daemon's
/// GAVIN_ROOT_DIR / GAVIN_DIR, which is the authority -- these two names
/// are how a context is RECOGNIZED, so they are not ours to vary.
export function gavinDirFor(kind: "root" | "context"): string {
  return kind === "root" ? ".gavin-root" : ".gavin";
}

export const REVIEW_RULES_FILE = "REVIEW.md";

/// What the rules file is called when a human has to be told about it.
/// The relative spelling, because that is what they will go looking for.
export const REVIEW_RULES_LABEL = `.gavin-root/${REVIEW_RULES_FILE}`;

/// This workspace's review rules, by CONVENTION rather than
/// configuration: `<root>/.gavin-root/REVIEW.md`, the way Cursor's
/// review reads `.cursor/BUGBOT.md`.
///
/// Deliberately not a config.toml key like `prd`. That key is read by
/// the daemon and reaches the app over the wire, so a new one would be a
/// protocol bump, a compat gate and a picker on three surfaces -- to
/// choose between one path and one path. A fixed path costs none of
/// that, and a fixed path is also what makes the rules FINDABLE: an
/// agent that never opened this app can be told where they are.
///
/// Rules are workspace-wide (the ROOT context's folder), even for a card
/// living in a nested context. House rules for reviewing this repository
/// are a property of the repository, not of the sub-folder the finding
/// happens to land in.
export function reviewRulesPath(rootFolder: string): string {
  return `${rootFolder.replace(/\/+$/, "")}/${gavinDirFor("root")}/${REVIEW_RULES_FILE}`;
}

/// Where a context's cards are written when the gavin tools cannot be
/// reached and the agent has to author the file itself.
export function plansFolderPath(folderPath: string, kind: "root" | "context"): string {
  return `${folderPath.replace(/\/+$/, "")}/${gavinDirFor(kind)}/plans`;
}

/// What "Create rules file" writes. A file with headings and no rules
/// under them, because the alternative -- shipping opinions as the
/// default -- would have every workspace reviewing against gavin's
/// habits while reading as though someone had chosen them.
///
/// The prose says what a rule is FOR, since the failure mode of a rules
/// file is a wish list ("write good code") that changes no review.
export const REVIEW_RULES_STARTER = `# Review rules

House rules for "Review with agent" in this workspace. The review agent
reads this file before it reads the diff, and these rules win over its
own habits.

Write rules that could FAIL a review — something a reviewer can check
against the diff and answer yes or no. A rule nobody can fail is a
preference, and it will quietly be ignored.

## Always flag

- (e.g. a new public function with no test)

## Never flag

- (e.g. formatting — the formatter owns it)

## This codebase's traps

- (e.g. the thing every newcomer gets wrong here)
`;

// ---- The base a review compares against ------------------------------------

/// Trunk names, most conventional first. Only ever consulted for a
/// DEFAULT: the dialog's field is free text, so a repository that names
/// its trunk something else costs the human one edit rather than making
/// the feature unusable.
const TRUNK_NAMES = ["main", "master", "develop", "trunk"];

/// The base to seed a review with: this repository's trunk, unless that
/// is the branch we are standing on.
///
/// Standing ON the trunk falls back to its upstream, because a branch
/// reviewed against itself has an empty diff and the agent would report
/// nothing -- an answer indistinguishable from a clean review. The
/// upstream turns that case into the one review that is still meaningful
/// there: what this checkout has that the remote does not.
export function defaultReviewBase(branches: BranchInfo[], fallback = "main"): string {
  for (const name of TRUNK_NAMES) {
    const hit = branches.find((b) => b.name === name);
    if (hit && !hit.current) return name;
  }
  const current = branches.find((b) => b.current);
  if (current?.upstream) return current.upstream;
  return fallback;
}

// ---- The prompt ------------------------------------------------------------

/// The card whose work is under review, when a review was started from
/// one. `kind` decides where the findings land: only a PLAN can be a
/// parent, so a task card's findings have to stand on their own.
export interface ReviewedCard {
  path: string;
  fileName: string;
  title: string;
  kind: "task" | "plan";
}

export interface ReviewPromptOptions {
  /// Branch, tag or commit to compare against. Free text: the human may
  /// type `origin/main`, a tag, or `HEAD~5`, and every one of those is a
  /// legitimate thing to review against.
  base: string;
  /// Where the rules file is, whether or not it exists. Named even when
  /// absent -- an agent told the path can look, and a review that
  /// silently skipped the rules because the app checked first would be
  /// wrong the moment the file appears mid-run.
  rulesPath: string;
  /// The gavin context folder findings are filed into, or null when the
  /// caller does not know it -- the rail step, which is one stored tool
  /// body shared by every workspace. The agent is then told to find the
  /// context itself, which it can: `gavin_get_tree` is the canonical
  /// answer and is already the tool it would reach for.
  contextFolder: string | null;
  /// The same context's plans folder, for the hand-authored fallback.
  /// Null travels with a null `contextFolder`, for the same reason.
  plansFolder: string | null;
  card?: ReviewedCard | null;
  /// Whether to open with the name-your-tab instruction. False for the
  /// rail step: orchestration names a step's session itself, and none of
  /// the other built-in tool bodies carry the line either.
  nameTab?: boolean;
}

/// The instruction a review agent is handed, on every surface: the Git
/// tab, the card menu, and the `builtin:code-review` rail step.
///
/// One composer rather than three, because the part that matters is
/// identical everywhere -- how a finding becomes a card -- and three
/// copies of that would drift into three different card shapes on one
/// board. Only the SUBJECT differs, and it is one sentence.
export function composeReviewPrompt(options: ReviewPromptOptions): string {
  const { base, rulesPath, contextFolder, plansFolder, card, nameTab = true } = options;
  const subject = card
    ? `the work done for the card at ${card.path} ("${card.title}")`
    : "the changes on this branch";
  // A plan card adopts its findings as nested tasks: a task with a
  // `parent` and no status of its own rides inside its parent's card,
  // travels with it into done/ and archives with it -- exactly right for
  // "what this piece of work left behind". A task card cannot be a
  // parent (only a plan can), so its findings stand on their own in the
  // first column and name the card they came from instead.
  const nests = card?.kind === "plan";
  const placement = nests
    ? `- \`parent\`: \`${card?.fileName}\`, and NO status — that is what makes the finding ` +
      `nest inside the card whose work produced it`
    : "- `status`: the board's first column — check the column names with `gavin_get_board` " +
      "rather than assuming they are the defaults" +
      (card ? ", and name the card above in the body, since it is where the finding came from" : "");

  return [
    nameTab ? NAME_TAB_FIRST : "",
    "",
    `Review ${subject} against \`${base}\`. Change nothing: this is a review, and the ` +
      `cards you file are its whole output.`,
    "",
    `First read \`${rulesPath}\`. It is this workspace's review rules, and where it says ` +
      `something your own habits do not, it wins. If it is not there, review by your own ` +
      `judgement and do not create it.`,
    card
      ? `Then read the card itself — it says what the work was FOR, and a review that does ` +
        `not know the intent reports style.`
      : "",
    "",
    "Look for correctness bugs first, then reuse and simplification opportunities. Before " +
      "you write a finding down, establish the case that actually breaks: inputs, state, and " +
      "the wrong output or crash they produce. A finding you cannot make fail is a guess, and " +
      "a board full of guesses costs more to clear than the review saved.",
    "",
    "File each finding you keep as its own card, with `gavin_create_plan`:",
    "",
    contextFolder
      ? `- \`context_folder\`: \`${contextFolder}\``
      : "- `context_folder`: this workspace's root gavin context — find its folder with " +
        "`gavin_get_tree` rather than guessing",
    "- `file_name`: kebab-case, prefixed `review-`",
    "- `title`: the defect in one line — what is wrong, not which file it is in",
    "- `kind`: `task` when the fix is work an agent could execute, and then the body IS that " +
      "agent's prompt; `note` when it is an observation for a human to judge",
    placement,
    "- the body always gives `file:line`, what breaks, and the concrete case that breaks it",
    "",
    "Create them most severe first, so the column reads in that order. If the gavin tools are " +
      "unreachable, write the same cards by hand as markdown files in " +
      (plansFolder ? `\`${plansFolder}\`` : "that context's `plans/` folder") +
      " — same frontmatter, one file per finding — rather than reporting them only in this " +
      "terminal.",
    "",
    "If you find nothing worth a card, say so plainly and file none. A clean review is a " +
      "result, not a failure to produce output.",
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n")
    .trim();
}

/// Why a review cannot be started, or null. The surfaces ask BEFORE
/// offering the action, so the words end up on a tooltip rather than in
/// an error strip after a click that did nothing.
export function reviewBlocker(options: {
  promptArgs: string | null;
  agentLabel: string;
  contextFolder: string | null;
}): string | null {
  if (options.contextFolder === null) {
    return "This workspace has no gavin context, so a review has nowhere to file its findings";
  }
  // Deliberately the same sentence the card runs use: it is the same
  // fact about the same configured agent, and two spellings of it would
  // read as two different problems.
  if (options.promptArgs === null) return noPromptReason(options.agentLabel);
  return null;
}
