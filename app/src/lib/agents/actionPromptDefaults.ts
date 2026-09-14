// Shipped default bodies for agent action prompts, plus fillTemplate.
//
// Kept free of orchestrationTools / cardRun / codeReview imports so those
// modules can fill templates at load time (builtin:code-review's body is
// composed when BUILTIN_TOOLS is built) without racing ACTION_PROMPTS.
// actionPrompts.ts re-exports everything here for the catalog API.

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/// Literal `{{name}}` substitution, one pass. Undeclared placeholders
/// stay verbatim — same rule resolveToolBody follows.
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole
  );
}

export const DEFAULT_RUN_TASK =
  "{{name_tab_first}}\n\n" +
  'You are executing the task card at {{path}} ("{{title}}").' +
  "{{attachments}}\n\n" +
  "{{body}}\n\n" +
  "While you work, keep this card's status current with gavin_set_plan_field on {{path}}; " +
  "set it to the board's done column when finished." +
  "{{card_home_note}}";

export const DEFAULT_RUN_PLAN =
  "{{name_tab_first}}\n\n" +
  "Read {{path}} and execute that plan. Work its checklist top to bottom: " +
  "tick items (- [x]) as you complete them, promote items that need their own agent " +
  "with gavin_promote_task, and keep the plan's status current with gavin_set_plan_field." +
  "{{attachments}}" +
  "{{card_home_note}}";

export const DEFAULT_RESUME_TASK =
  "{{name_tab_first}}\n\n" +
  'Use the gavin-resume skill to resume the task card at {{path}} ("{{title}}"). ' +
  "Work on it already started and stopped." +
  "{{attachments}}\n\n" +
  "{{body}}\n\n" +
  "Find what is already done before you write anything, then carry on from there. " +
  "Keep this card's status current with gavin_set_plan_field on {{path}}; " +
  "set it to the board's done column when finished.";

export const DEFAULT_RESUME_PLAN =
  "{{name_tab_first}}\n\n" +
  "Use the gavin-resume skill to resume the plan at {{path}}. Work on it already started " +
  "and stopped: find what is already done before you write anything — the checklist's " +
  "ticks are the record, but not the whole of it. Then work it top to bottom from there, " +
  "ticking items (- [x]) as you complete them, promoting items that need their own agent " +
  "with gavin_promote_task, and keeping the plan's status current with gavin_set_plan_field." +
  "{{attachments}}";

export const DEFAULT_DEVELOP =
  "{{name_tab_first}}\n\n" +
  'Use the gavin-develop skill on the card at {{path}} ("{{title}}"): develop it into ' +
  "work an agent can execute \u2014 a checklist, nested task cards, both, or, when it is " +
  "really one sitting, a sharper prompt \u2014 and set the card's kind and complexity to " +
  "match what you wrote.\n\n" +
  "Interview me in this tab before you decide anything, and write nothing to the card " +
  "until I approve what you propose. Leave the card's status where it is: developing a " +
  "card is not starting it.";

export const DEFAULT_REVIEW_LAUNCH =
  "{{name_tab_first}}\n\n" +
  'The work for the {{subject}} at {{path}} ("{{title}}") is finished and is being reviewed. ' +
  "Read the card and find what the work actually did — the checklist, the files it " +
  "touched, and the commits on this checkout — before you answer anything." +
  "{{attachments}}{{quoted_body}}\n\n" +
  "Change nothing until you are asked to. Do not change this card's status: it is sitting " +
  "in the column that put it in front of a reviewer, and moving it takes it off their list. " +
  "Wait for the reviewer's first question.";

export const DEFAULT_ORGANIZE =
  "{{name_tab_first}}\n\n" +
  "Use the gavin-orchestrate skill to put this workspace's UNPLACED cards on rails.\n\n" +
  "{{unplaced_block}}\n\n" +
  "{{rails_block}}\n\n" +
  "{{conflicts_block}}\n\n" +
  "Place every unplaced card the payload lists: extend a rail where the work belongs on one, add\n" +
  "a rail where it does not. Leave the steps already on rails where they are unless a card you\n" +
  "are placing forces a reorder — and if it does, say which and why.\n\n" +
  "Organizing means parallelizing: spread the work as wide as it can safely go. Prefer a new rail\n" +
  "over a longer one, and give each rail that must run at the same time its own isolation — create\n" +
  "the worktree and the branch yourself with git, then send worktreePath and branch on the rail.\n" +
  "An unbound rail is not isolated, and a worktreePath nothing created is a stalled rail.\n\n" +
  "{{read_first}}\n" +
  "{{carry_through}}";

export const DEFAULT_REORGANIZE =
  "{{name_tab_first}}\n\n" +
  'Use the gavin-orchestrate skill to reorganize the rail "{{rail_name}}" — that rail only.\n\n' +
  "{{rail_body}}\n\n" +
  "{{conflicts_block}}\n\n" +
  "Reorganize this rail's stages: reorder them, split a stage whose steps would collide in one\n" +
  "checkout, merge stages that are genuinely independent. Keep the steps it already holds — this\n" +
  "is not the place to add or drop work — and send every OTHER rail back exactly as you read it.\n\n" +
  "{{read_first}}\n" +
  "{{carry_through}}";

export const DEFAULT_CRITICAL_REVIEW_SUFFIX =
  "\n\nYou are one of {{reviewer_total}} reviewers critiquing this work side by side in the " +
  "same checkout. You are “{{reviewer_label}}”. This shell already starts where the " +
  "work lives — review only; change no files, switch no branches, and do not merge.\n\n" +
  "Begin your tab name with “{{reviewer_label}} ” so the panes stay tellable apart." +
  "{{findings_rail_note}}";

export const DEFAULT_BEST_OF_N_SUFFIX =
  "\n\nYou are one of {{total}} agents running this card side by side, each in a git worktree " +
  "of its own. You are “{{label}}”, and this shell already starts in your worktree — work only " +
  "in it, and do not switch branches or merge: another candidate's work and the human's own " +
  "checkout are what you would be editing.\n\n" +
  "Begin your tab name with “{{label}} ” so the panes stay tellable apart. Leave this card's " +
  "status alone — a human compares the candidates and picks one, and that pick is what " +
  "records the outcome.";

export const DEFAULT_UNTIL_RETRY_PREFIX =
  "The previous attempt failed this check:\n" +
  "```\n" +
  "{{check_output}}\n" +
  "```\n" +
  "Fix it, then finish.";

export const DEFAULT_NAME_TAB_FIRST =
  "First, before anything else: call gavin_name_session to name this tab — " +
  "two to four words for the work itself, not for you.";

/// Review-with-agent template. Dynamic subject / placement / folder lines
/// are filled by composeReviewPrompt; `{{base}}` and `{{rules_path}}` are
/// also what the rail tool body keeps as tool params.
export const DEFAULT_CODE_REVIEW =
  "{{name_tab_first}}\n\n" +
  "Review {{subject}} against `{{base}}`. Change nothing: this is a review, and the " +
  "cards you file are its whole output.\n\n" +
  "First read `{{rules_path}}`. It is this workspace's review rules, and where it says " +
  "something your own habits do not, it wins. If it is not there, review by your own " +
  "judgement and do not create it.\n" +
  "{{card_read_line}}\n" +
  "Look for correctness bugs first, then reuse and simplification opportunities. Before " +
  "you write a finding down, establish the case that actually breaks: inputs, state, and " +
  "the wrong output or crash they produce. A finding you cannot make fail is a guess, and " +
  "a board full of guesses costs more to clear than the review saved.\n\n" +
  "File each finding you keep as its own card, with `gavin_create_plan`:\n\n" +
  "{{context_folder_line}}\n" +
  "- `file_name`: kebab-case, prefixed `review-`\n" +
  "- `title`: the defect in one line — what is wrong, not which file it is in\n" +
  "- `kind`: `task` when the fix is work an agent could execute, and then the body IS that " +
  "agent's prompt; `note` when it is an observation for a human to judge\n" +
  "{{placement}}\n" +
  "- the body always gives `file:line`, what breaks, and the concrete case that breaks it\n\n" +
  "Create them most severe first, so the column reads in that order. If the gavin tools are " +
  "unreachable, write the same cards by hand as markdown files in " +
  "{{plans_folder}} — same frontmatter, one file per finding — rather than reporting them only in this " +
  "terminal.\n\n" +
  "If you find nothing worth a card, say so plainly and file none. A clean review is a " +
  "result, not a failure to produce output.";
