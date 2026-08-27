/// The delete-workspace wizard, as pure data.
///
/// Deleting a workspace is the one gesture in this app that removes
/// somebody's files, so it is built the way the rest of the UI logic here
/// is built and then some: this module holds the whole machine -- which
/// screens exist, what each answer means, and exactly what a given set of
/// answers would remove -- and touches nothing. `WorkspaceDeleteWizard`
/// renders it; Rust executes the plan it produces; neither of them
/// decides anything.
///
/// The rule the design turns on: NOTHING is removed until the last
/// screen. Every screen stores an answer and moves on, so a user who
/// changes their mind on screen five has destroyed nothing on screens one
/// through four.

/// What a scan of a workspace root actually found. Produced by Rust's
/// `scan_gavin_footprint`; every path in it is absolute, and every entry
/// exists on disk at scan time. A category the scan reports nothing for
/// has no screen at all -- an empty screen asking permission to remove
/// nothing is a step that can only be answered wrong.
export interface GavinFootprint {
  /// The workspace root the scan ran against.
  root: string;
  /// `.gavin-root/` and what is in it, or null when there is none.
  gavinRoot: GavinRootFootprint | null;
  /// Installed gavin skill directories (`.claude/skills/gavin*`).
  skills: string[];
  /// The agent's MCP config, but only when it actually carries gavin's
  /// server entry. A config file that never mentioned gavin is not this
  /// wizard's business.
  mcp: McpFootprint | null;
  /// The instructions file, but only when it carries the marker block --
  /// same rule as `mcp`.
  instructions: string | null;
  /// Nested gavin contexts: every `.gavin/` under the root, plus the
  /// `extra_contexts` folders registered from outside it.
  contexts: ContextFootprint[];
}

export interface GavinRootFootprint {
  path: string;
  /// Cards on the board (`plans/`, including `plans/done/`).
  cards: number;
  /// Cards taken off the board (`plans/archive/`). Counted separately
  /// because they are the ones nobody has looked at in a while, and so
  /// the ones nobody will notice are gone.
  archived: number;
}

export interface McpFootprint {
  path: string;
  /// The key gavin's entry hangs off -- `gavin` for every stock profile,
  /// but read from the profile table rather than assumed.
  serverKey: string;
}

export interface ContextFootprint {
  path: string;
  /// Registered through `extra_contexts` and living beyond the root.
  /// These are the only paths this wizard can touch outside the root,
  /// they are named one by one, and they start unticked.
  outside: boolean;
}

/// One screen of the wizard. `rows` is not a category on disk: it is the
/// daemon's own state for this workspace, which no amount of file removal
/// reaches.
export type DeleteStep =
  | "plans"
  | "skills"
  | "mcp"
  | "instructions"
  | "contexts"
  | "rows"
  | "confirm";

/// Every screen, in the order the wizard walks them. `confirm` is last
/// and is the only one that does anything.
export const DELETE_STEPS: DeleteStep[] = [
  "plans",
  "skills",
  "mcp",
  "instructions",
  "contexts",
  "rows",
  "confirm",
];

/// The screens this particular workspace gets. A file category the scan
/// found nothing for is dropped; `rows` and `confirm` always stay, since
/// neither is a question about the filesystem.
export function applicableSteps(footprint: GavinFootprint): DeleteStep[] {
  return DELETE_STEPS.filter((step) => {
    switch (step) {
      case "plans":
        return footprint.gavinRoot !== null;
      case "skills":
        return footprint.skills.length > 0;
      case "mcp":
        return footprint.mcp !== null;
      case "instructions":
        return footprint.instructions !== null;
      case "contexts":
        return footprint.contexts.length > 0;
      case "rows":
      case "confirm":
        return true;
    }
  });
}

/// The heading each screen carries. Data rather than markup so the
/// wizard's shape is testable and so the order in DELETE_STEPS and the
/// words on screen cannot drift apart.
export function stepTitle(step: DeleteStep): string {
  switch (step) {
    case "plans":
      return "Plans and cards";
    case "skills":
      return "Agent skills";
    case "mcp":
      return "MCP server entry";
    case "instructions":
      return "Instructions block";
    case "contexts":
      return "Nested contexts";
    case "rows":
      return "Board, rails and tools";
    case "confirm":
      return "Confirm";
  }
}

/// What each screen asks, with the counts the scan actually found. Every
/// screen states what is at stake rather than what the category is
/// called: "12 cards" is a decision, ".gavin-root/" is a filename.
export function stepQuestion(step: DeleteStep, footprint: GavinFootprint): string {
  switch (step) {
    case "plans": {
      const root = footprint.gavinRoot;
      if (!root) return "";
      const cards = `${root.cards} card${root.cards === 1 ? "" : "s"}`;
      const archived =
        root.archived > 0 ? ` and ${root.archived} archived` : "";
      return `Remove the gavin root — ${cards}${archived}, the PRD, and this workspace's config. It goes to the Trash, so it can be put back.`;
    }
    case "skills":
      return "Remove the gavin skill files installed for this workspace's agent. Skills that are not gavin's are left alone.";
    case "mcp":
      return "Remove gavin's entry from the agent's MCP config. The file itself stays, along with every other server in it.";
    case "instructions":
      return "Cut gavin's marked block out of the agent's instructions file. Everything you wrote around it is kept, byte for byte.";
    case "contexts":
      return "Remove the nested gavin contexts. Each is a .gavin folder with its own plans — pick the ones that should go.";
    case "rows":
      return "Clear what gavin's daemon holds for this workspace: the board's columns and labels, the rails and their run state, this workspace's tools and group templates, and the card-to-session links.";
    case "confirm":
      return "This is everything that will happen. Type the workspace's name to enable Delete.";
  }
}

/// What the daemon-rows screen has to say about declining, because the
/// consequence is not obvious and cuts the other way from every other
/// screen: keeping something usually means keeping it USABLE, and here
/// it does not.
///
/// The rows are keyed by this workspace's id, and a delete -- unlike the
/// sidebar X -- deliberately leaves no record of that id behind. So
/// declining does not preserve the board for later; it strands it. The
/// note names the gesture that would have preserved it, since that is
/// the choice the user is actually weighing.
export const ROWS_DECLINE_NOTE =
  "Keeping them leaves rows in the daemon that nothing will reach again: they are keyed by this workspace's id, and a delete leaves no record of it. To be able to restore them later, close the workspace from the sidebar instead of deleting it.";

/// What the user has said so far. Every field is an answer, never an
/// action -- see this module's own doc comment.
export interface DeleteAnswers {
  plans: boolean;
  skills: boolean;
  mcp: boolean;
  instructions: boolean;
  /// The nested-context paths that are ticked. A list rather than a
  /// boolean because this screen is per-path: one repo's `.gavin/` may be
  /// worth keeping while another's is not.
  contexts: string[];
  rows: boolean;
}

/// The state every screen opens on: yes to everything inside the root,
/// and no to everything outside it.
///
/// A context beyond the root belongs to some other checkout that merely
/// registered itself here. Removing it is legitimate -- the user asked
/// for gavin to be gone -- but it is not what "delete this workspace"
/// means on its face, so it is the one answer that has to be given rather
/// than merely not withdrawn.
export function defaultAnswers(footprint: GavinFootprint): DeleteAnswers {
  return {
    plans: true,
    skills: true,
    mcp: true,
    instructions: true,
    contexts: footprint.contexts.filter((c) => !c.outside).map((c) => c.path),
    rows: true,
  };
}

/// Exactly what the answers add up to: the paths to trash, the files to
/// edit, and whether the daemon's rows go.
///
/// The two are kept apart because they are different acts. A path in
/// `trash` is gavin's own and leaves whole. A file in `stripMcpKey` or
/// `cutBlock` is SHARED -- someone else's `.mcp.json`, someone's own
/// CLAUDE.md -- and is only ever edited, never removed, however
/// thoroughly the user answered.
export interface RemovalPlan {
  /// Absolute paths to move to the OS Trash, in the order they were
  /// found. The Trash, not `rm`: an untracked card in `plans/done/` is
  /// then one Finder gesture away rather than gone.
  trash: string[];
  /// Config files to strip gavin's server entry out of, keeping every
  /// other server and the file's own formatting.
  stripMcpKey: McpFootprint[];
  /// Instructions files to cut the `<!-- gavin:start -->…<!-- gavin:end -->`
  /// block out of, leaving the human's own prose untouched.
  cutBlock: string[];
  /// Whether the daemon's rows for this workspace are cleared too. Not
  /// Rust's business -- the app clears them over the daemon connection --
  /// but it belongs in the plan because the final screen renders it.
  rows: boolean;
}

export function plannedRemovals(footprint: GavinFootprint, answers: DeleteAnswers): RemovalPlan {
  const trash: string[] = [];
  if (answers.plans && footprint.gavinRoot) trash.push(footprint.gavinRoot.path);
  if (answers.skills) trash.push(...footprint.skills);
  // Intersected with the scan rather than taken on trust: an answer is a
  // list of strings, and the only paths this wizard may ever remove are
  // the ones it found and showed. Rust checks this again on its side --
  // the two are not redundant, they are the same rule stated where each
  // half of the system can enforce it.
  const found = new Set(footprint.contexts.map((c) => c.path));
  trash.push(...answers.contexts.filter((p) => found.has(p)));

  return {
    trash,
    stripMcpKey: answers.mcp && footprint.mcp ? [footprint.mcp] : [],
    cutBlock: answers.instructions && footprint.instructions ? [footprint.instructions] : [],
    rows: answers.rows,
  };
}

/// What Rust reported back. One failure never aborts the rest, so this
/// is always a mix: `done` is what landed, `failed` is `[path, reason]`
/// for what did not.
export interface RemovalReport {
  done: string[];
  failed: Array<[string, string]>;
}

/// Whether a plan would touch the disk at all. A wizard answered "no" all
/// the way down still ends in removing the workspace from the app, so
/// Delete stays available -- this only decides whether the final screen
/// says anything about files.
export function touchesDisk(plan: RemovalPlan): boolean {
  return plan.trash.length > 0 || plan.stripMcpKey.length > 0 || plan.cutBlock.length > 0;
}

/// The gate on the final screen: the workspace's name, typed exactly.
/// Surrounding whitespace is forgiven (a paste picks it up, and nobody
/// means it); case and spelling are not.
export function confirmationMatches(typed: string, workspaceName: string): boolean {
  return typed.trim() === workspaceName.trim() && workspaceName.trim() !== "";
}

/// One line per thing that will happen, for the final screen to render.
/// Built here rather than in the template so that what the confirmation
/// screen PROMISES and what `plannedRemovals` returns cannot drift apart.
///
/// `sessionCount` comes from the app, not the scan -- the sessions that
/// will end are the workspace's live terminals, which no filesystem walk
/// can see.
export function summaryLines(
  footprint: GavinFootprint,
  answers: DeleteAnswers,
  sessionCount: number
): string[] {
  const plan = plannedRemovals(footprint, answers);
  const lines: string[] = [];
  for (const path of plan.trash) lines.push(`Move to Trash: ${path}`);
  for (const mcp of plan.stripMcpKey) lines.push(`Edit: remove the "${mcp.serverKey}" server from ${mcp.path}`);
  for (const path of plan.cutBlock) lines.push(`Edit: cut the gavin block from ${path}`);
  if (plan.rows) {
    lines.push("Clear this workspace's board, rails, tools and card links from the daemon");
  } else {
    lines.push("Keep this workspace's board, rails, tools and card links in the daemon");
  }
  if (sessionCount > 0) {
    lines.push(`End ${sessionCount} terminal session${sessionCount === 1 ? "" : "s"}`);
  }
  lines.push("Remove the workspace from gavin");
  return lines;
}
