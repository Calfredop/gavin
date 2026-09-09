/// Auto commit: the sentence a card carries when it wants the agent that
/// executes it to commit the result, and the two-level setting that says
/// whether a new card starts with it.
///
/// The state lives in the card's BODY, not in frontmatter. A card's body
/// is already the prompt -- `composeTaskPrompt` inlines it, a plan agent
/// is told to read the file, a rail step and an MCP caller both get the
/// same bytes -- so a sentence in the body reaches every route to an
/// agent with nothing wired up per route. A frontmatter field would have
/// to be re-synthesised into a prompt block at each of them, and it would
/// need a protocol bump, a `FEATURE_MIN_VERSION` entry and a
/// `featureBlockedReason` on all four surfaces before it did anything at
/// all. This works against the daemon already running.
///
/// It also means the card says what it means in plain English to whoever
/// reads the file in git, which `auto_commit: true` would not.
///
/// Pure and unit-tested, so the two `.svelte` surfaces that own the
/// gesture (the ⌘N composer and the card detail modal) stay templates.

import { bodyStart } from "$lib/planChecklist";

/// The fence. HTML comments, so markdown renders them as nothing: the
/// human reads the sentence, in the modal's preview and in the file, and
/// never sees the markers. They exist so the toggle can find and remove
/// exactly the block it wrote, rather than string-matching prose that
/// someone may since have reworded.
export const AUTO_COMMIT_OPEN = "<!-- gavin:auto-commit -->";
export const AUTO_COMMIT_CLOSE = "<!-- /gavin:auto-commit -->";

/// What the card actually asks for. Three clauses, and the middle one is
/// the load-bearing one in this repo: several agents edit one checkout at
/// once, so an agent that commits everything it finds staged sweeps up
/// other sessions' work (CLAUDE.md's shared-worktree rule). Pushing is
/// left out on purpose -- the PRD's "the human keeps the wheel" makes
/// publishing a decision, and a commit is still local and reversible.
///
/// One line: a card's body is markdown, and a paragraph that wraps is a
/// paragraph either way.
export const AUTO_COMMIT_INSTRUCTION =
  "When the implementation is done, commit it. Commit only the files you touched — " +
  "never `git add -A`. Do not push.";

export const AUTO_COMMIT_BLOCK = `${AUTO_COMMIT_OPEN}\n${AUTO_COMMIT_INSTRUCTION}\n${AUTO_COMMIT_CLOSE}`;

/// Matches a whole block, markers included, wherever it sits and however
/// its sentence has been reworded. Global, so a body that somehow ended
/// up with two cannot keep one through an "off". Non-greedy, so two
/// blocks are two matches rather than one span swallowing the prose
/// between them.
const BLOCK_RE = /<!--\s*gavin:auto-commit\s*-->[\s\S]*?<!--\s*\/gavin:auto-commit\s*-->/g;

/// Whether this text -- a body or a whole card file, both work -- carries
/// the block.
///
/// The FENCE is the state, not the wording. Someone who rewrites the
/// sentence to suit their project has not turned the flag off, and a
/// toggle that read the prose would answer "off" and then weld a second
/// block on beside theirs.
export function hasAutoCommit(text: string | null | undefined): boolean {
  if (!text) return false;
  // Fresh lastIndex every call: BLOCK_RE is global and shared.
  BLOCK_RE.lastIndex = 0;
  return BLOCK_RE.test(text);
}

/// The body with the block on or off. Idempotent both ways, so a caller
/// may write the answer back unconditionally.
export function setAutoCommitInBody(body: string, on: boolean): string {
  if (on) {
    // A block that is already there stays exactly as it is, edits and
    // all. Re-appending the canonical wording beside a reworded one
    // would give the agent two instructions and the human no clue which
    // it followed.
    if (hasAutoCommit(body)) return body;
    const prompt = body.trim();
    return prompt === "" ? AUTO_COMMIT_BLOCK : `${prompt}\n\n${AUTO_COMMIT_BLOCK}`;
  }
  if (!hasAutoCommit(body)) return body;
  // A blank line in the block's place, not nothing: the block is
  // normally last, but a human may have moved it between two paragraphs,
  // and splicing it out cleanly must not weld those two into one.
  return body.replace(BLOCK_RE, "\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/// The same, for a whole card file: the frontmatter comes back byte for
/// byte and only the body is spliced.
///
/// Written this way because the detail modal's only write seam is
/// `writeFileForEditor`, which replaces the file. Losing or reflowing the
/// frontmatter there would not fail loudly -- it would turn `status: To
/// Do` into a paragraph and drop the card off its column.
///
/// A file whose frontmatter opens and never closes is returned untouched.
/// Every line of it is still frontmatter as far as any parser is
/// concerned, so there is no body to append to and adding one would be a
/// guess about where the human meant the block to end.
export function setAutoCommitInFile(text: string, on: boolean): string {
  const lines = text.split("\n");
  const start = bodyStart(lines);
  if (start === null) return text;
  const body = setAutoCommitInBody(lines.slice(start).join("\n"), on);
  const head = start === 0 ? "" : `${lines.slice(0, start).join("\n")}\n`;
  // Exactly one trailing newline either way: the file is watched, and a
  // write that only changed trailing whitespace would still wake every
  // watcher and re-render every card.
  return body === "" ? head : `${head}${body}\n`;
}

/// Which kinds can carry it. A note is a reminder -- nothing ever
/// executes one -- so the instruction would be text no agent will read,
/// on a card with no implementation to finish.
export function autoCommitAppliesTo(kind: string | null | undefined): boolean {
  return kind === "task" || kind === "plan";
}

/// What a new card gets when nobody has chosen. Off: the PRD's "the human
/// keeps the wheel" makes committing something that stops and asks, so
/// handing an agent the commit has to be something you turn on.
export const DEFAULT_AUTO_COMMIT = false;

/// A stored setting, or null for "nothing chosen here" -- which is what
/// both an absent value and an unusable one mean. Null rather than the
/// default so the caller can still fall through to the next level: a
/// workspace with no setting of its own must land on the app-wide one,
/// not jump straight past it to off.
export function normalizeAutoCommit(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/// Whether a card filed in this workspace starts with the block: the
/// workspace's own choice, else the app-wide one, else gavin's default.
/// Expressed once so the composer, the global panel's "Default (off)"
/// label and the workspace panel's can never disagree about what
/// inheriting currently means.
export function resolveAutoCommit(workspaceValue: unknown, appValue: unknown): boolean {
  return normalizeAutoCommit(workspaceValue) ?? normalizeAutoCommit(appValue) ?? DEFAULT_AUTO_COMMIT;
}

/// The `<select>` vocabulary. Strings because that is what a select hands
/// back; "" is the inherit row, and every writer reads it as "clear my
/// override".
export const AUTO_COMMIT_INHERIT = "";
export const AUTO_COMMIT_ON = "on";
export const AUTO_COMMIT_OFF = "off";

export function autoCommitFromSelect(value: string): boolean | null {
  if (value === AUTO_COMMIT_ON) return true;
  if (value === AUTO_COMMIT_OFF) return false;
  return null;
}

export function autoCommitToSelect(value: unknown): string {
  const normalized = normalizeAutoCommit(value);
  if (normalized === null) return AUTO_COMMIT_INHERIT;
  return normalized ? AUTO_COMMIT_ON : AUTO_COMMIT_OFF;
}

export interface AutoCommitOption {
  value: string;
  label: string;
}

/// The rows a workspace picker renders. The inherit row is labelled with
/// what it inherits, following the model and font-size pickers' rule -- a
/// panel never shows a box whose selected row is secretly doing
/// something.
export function autoCommitOptions(inherited: boolean): AutoCommitOption[] {
  return [
    { value: AUTO_COMMIT_INHERIT, label: `Default (${inherited ? "on" : "off"})` },
    { value: AUTO_COMMIT_ON, label: "On" },
    { value: AUTO_COMMIT_OFF, label: "Off" },
  ];
}
