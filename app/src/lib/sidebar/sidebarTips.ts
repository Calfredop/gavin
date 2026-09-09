// What the sidebar's rows SAY, spelled out.
//
// A sidebar row is 200px wide, so almost everything on it is a glyph and
// a number: three chips of tallies on a workspace, a dot and a branch
// mark on a tab. The tooltip is where those become sentences, which
// makes these strings the only words the sidebar has -- and every one of
// them was assembled inline in the template, where nothing could read
// them.
//
// The tallies themselves are sidebarSummary.ts's; this module only
// decides how they read. The rule they share, and the reason it is worth
// stating once: a bucket at ZERO drops out entirely rather than being
// named as zero. "0 repos" on a chip whose whole reason for existing is
// an agent mid-commit would be the loudest thing on it.

import type {
  KanbanSummary,
  PageAgentsSummary,
  PageTabKind,
  RailsSummary,
  WorkspaceGitSummary,
} from "$lib/sidebar/sidebarSummary";
import type { GitStatus } from "$lib/core/workspace";

/// `1 repo` / `2 repos`, with both forms given: several of the nouns
/// below do not pluralize by suffix ("file or board tab").
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/// The branch mark's sync half: `↑2 ↓1`, and only the non-zero sides.
///
/// Empty for a branch with no upstream, where ahead and behind are not
/// merely zero -- they are meaningless, and drawing `↑0 ↓0` would claim
/// a comparison that was never made.
export function formatAheadBehind(status: GitStatus): string {
  if (!status.hasUpstream) return "";
  const parts: string[] = [];
  if (status.ahead > 0) parts.push(`↑${status.ahead}`);
  if (status.behind > 0) parts.push(`↓${status.behind}`);
  return parts.join(" ");
}

/// The git chip. A run in flight LEADS: it is the only part of this chip
/// that is happening right now rather than merely true.
export function gitRecapTip(git: WorkspaceGitSummary): string {
  const parts: string[] = [];
  if (git.committing) parts.push("an agent is committing");
  if (git.repoCount > 0) parts.push(plural(git.repoCount, "repo", "repos"));
  if (git.dirtyCount > 0) parts.push(`${git.dirtyCount} with uncommitted changes`);
  if (git.ahead > 0) parts.push(`${git.ahead} ahead`);
  if (git.behind > 0) parts.push(`${git.behind} behind`);
  return `${parts.join(", ")} -- open Git`;
}

/// The card chip. Names EVERY column, so the three-slot tally on the row
/// never hides which custom column a card is actually sitting in.
export function cardRecapTip(cards: KanbanSummary): string {
  const detail = cards.columns
    .filter((c) => c.count > 0)
    .map((c) => `${c.name} ${c.count}`)
    .join(", ");
  return `${plural(cards.total, "card", "cards")}: ${detail} -- open Kanban`;
}

/// A page's tab chip. Names every bucket the row draws as a bare number
/// AND the two it does not: the waiting agents (they are the amber badge
/// further along the row, not part of the recap) and the file and board
/// tabs that make up the gap between the tab count and the agent count.
export function tabsRecapTip(tabs: PageAgentsSummary): string {
  const buckets: string[] = [];
  if (tabs.running > 0) buckets.push(`${tabs.running} running`);
  if (tabs.waiting > 0) buckets.push(`${tabs.waiting} waiting for input`);
  if (tabs.failed > 0) buckets.push(`${tabs.failed} stopped because something broke`);
  if (tabs.idle > 0) buckets.push(`${tabs.idle} idle`);
  const agents =
    tabs.agents === 0 ? "no agents" : `${plural(tabs.agents, "agent", "agents")}: ${buckets.join(", ")}`;
  const others = tabs.tabs - tabs.agents;
  const rest = others > 0 ? `, ${plural(others, "file or board tab", "file or board tabs")}` : "";
  return `${plural(tabs.tabs, "tab", "tabs")} -- ${agents}${rest}`;
}

export function railRecapTip(rails: RailsSummary): string {
  const parts: string[] = [];
  if (rails.running > 0) parts.push(`${rails.running} running`);
  if (rails.attention > 0) parts.push(`${rails.attention} needing you`);
  if (rails.done > 0) parts.push(`${rails.done} done`);
  if (rails.idle > 0) parts.push(`${rails.idle} idle`);
  return `${plural(rails.total, "rail", "rails")}: ${parts.join(", ")} -- open Orchestration`;
}

/// What a non-agent tab row calls itself. A `session` row never reaches
/// this: pageTabRows gives every session a status (`?? "idle"`), and a
/// row with a status leads with the agent's own sentence instead.
export function tabRowKindWord(kind: PageTabKind, followUps: boolean): string {
  if (kind === "file") return "File";
  // The one card row with no card: its subject is a session.
  if (kind === "card") return followUps ? "Follow-ups" : "Card";
  return "Board";
}

export interface TabRowTip {
  /// The first line: the agent's own status sentence for a terminal row,
  /// else what kind of tab it is (tabRowKindWord).
  lead: string;
  /// Where the row points -- a context folder, a file, a card path, a
  /// cwd. Empty where the row has none, in which case no line is drawn
  /// rather than a blank one.
  where: string;
  /// The checkout this row's session sits in, when it is in one.
  git: GitStatus | null;
}

/// ONE bubble for the whole row: what it is, where it lives, and -- for a
/// session in a repo -- the checkout in full, spelled out where the row
/// itself can only afford glyphs.
///
/// Deliberately one and not two: mouseenter does not bubble, so a second
/// tooltip on the git line inside the row would take the row's own over
/// and never hand it back.
export function tabRowTip(input: TabRowTip): string {
  const lines = [input.lead];
  if (input.where) lines.push(input.where);
  const status = input.git;
  if (status) {
    // Arrows spelled out: the row already draws them, and a tooltip that
    // repeated the glyph would explain nothing.
    const sync = formatAheadBehind(status).replace("↑", "ahead ").replace("↓", "behind ");
    const parts = [status.repoRoot, `on ${status.branch}`, status.dirty ? "uncommitted changes" : "clean"];
    if (sync) parts.push(sync);
    lines.push(parts.join(" -- "));
  }
  return lines.join("\n");
}
