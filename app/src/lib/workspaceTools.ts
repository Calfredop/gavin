// The Tools hub tab, as pure functions. What the library offers when a
// tool is run on its OWN -- with no rail behind it -- and what the last
// run of each one means.
//
// The tab is a launcher over the library that already exists
// (orchestrationTools.ts): no second store, no second dialog, no second
// set of built-ins. Everything here is a rule about STANDALONE running,
// which is the only thing that is new.
//
// Three rules run through the file.
//
// **Only three kinds run alone.** `gavin`, `until` and `pr` are
// completion rules, not work: an `until` step's verdict SENDS THE RAIL
// BACKWARDS and a `pr` step is nothing but waiting, so both are
// meaningless without a rail to act on, and a `gavin` tool's whole body
// is the name of a rail action. They are filtered out here rather than
// disabled in the view, because "you cannot run this" is a fact about
// the tool and not about the button.
//
// **A verdict is what somebody observed.** A shell tool's exit code and
// an agent's turn ending are both events gavin watched; `abandoned` is
// gavin admitting it did not. None of the three is ever rendered as
// another, and a run with no end has no duration rather than one
// measured against now.
//
// **Shape and tone come from ui/indicators.ts.** The run axis already
// exists -- it is what a card's run history draws -- so a tool run
// borrows it whole rather than inventing a fourth badge for "how did
// that go". `toolRunAxis` below says WHICH state of that axis a run is,
// and the view calls `runIndicator` with it. The composition is in the
// view rather than here for one hard reason: `ui/indicators.ts` pulls in
// the whole `@lucide/svelte` barrel, and this module is reached from
// `layoutState.bootstrap` (via workspaceToolsActions) where that import
// costs seconds. So the RULE lives here and the glyph is looked up where
// glyphs already are.

import { relativeTime } from "./appHub";
import { featureBlockedReason, type DaemonCompat } from "./daemonCompat";
import { resolveToolCwd, type Tool, type ToolKind } from "./orchestrationTools";

/// One standalone run of a tool. Mirrors `ToolRun` in the protocol crate.
export interface ToolRun {
  id: number;
  toolId: string;
  sessionId: string;
  command: string | null;
  launchCwd: string | null;
  conversationId: string | null;
  /// Epoch SECONDS, not milliseconds -- the daemon's clock. Everything
  /// here converts at the edge rather than carrying two units around.
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  outcome: string;
}

/// The kinds that mean anything on their own. Deliberately the same
/// three the library dialog lets a human AUTHOR: a tool somebody can
/// write is a tool they can run, and the three that are missing are the
/// three that are built-in-only for the same underlying reason -- their
/// bodies are completion rules rather than work.
export const RUNNABLE_TOOL_KINDS: ToolKind[] = ["agent", "command", "script"];

/// A type predicate, not just a boolean: every caller's next move is to
/// branch on `agent` versus the two shell kinds, and without the narrow
/// type each of them would need a second check the compiler could not
/// tie to this one.
export function isRunnableStandalone<T extends Pick<Tool, "kind">>(
  tool: T
): tool is T & { kind: "agent" | "command" | "script" } {
  return RUNNABLE_TOOL_KINDS.includes(tool.kind);
}

/// The tools the tab lists, in the order it draws them: this workspace's
/// own first, then global, then the built-ins, and alphabetical within
/// each block.
///
/// Scope-first because that is the order of ownership -- a tool the
/// human wrote for this repository is the one they came here to run, and
/// sixteen built-ins above it would bury it. Alphabetical within a block
/// rather than by the library's own order, because that order is a
/// stored `position` the Tools tab has no way to change and would look
/// arbitrary from here.
export function runnableTools(library: Tool[]): Tool[] {
  const rank: Record<Tool["scope"], number> = { workspace: 0, global: 1, builtin: 2 };
  return library
    .filter(isRunnableStandalone)
    .slice()
    .sort((a, b) => rank[a.scope] - rank[b.scope] || a.name.localeCompare(b.name));
}

/// The last run of each tool, by tool id. The daemon already answers
/// with one row per tool, so this is a lookup rather than a reduction --
/// but it is written to survive a list that carries more than one, by
/// keeping the HIGHEST id: row ids ascend with time, and two runs of one
/// tool can share a `startedAt` second.
export function lastRunByTool(runs: ToolRun[]): Map<string, ToolRun> {
  const byTool = new Map<string, ToolRun>();
  for (const run of runs) {
    const held = byTool.get(run.toolId);
    if (!held || run.id > held.id) byTool.set(run.toolId, run);
  }
  return byTool;
}

/// The last run of each tool in a workspace, off the store's own shape.
/// Empty for a workspace nothing has been fetched for, which is the same
/// answer as a workspace that has run nothing -- the tab draws no chip
/// either way, and a chip is not the place to explain a fetch.
export function lastRunsFor(
  all: Record<string, { runs: ToolRun[] }>,
  workspaceId: string
): Map<string, ToolRun> {
  return lastRunByTool(all[workspaceId]?.runs ?? []);
}

/// Whether a run is still open. The one state the tab has to know
/// without reading words, because it is what makes Run say "running".
export function isRunOpen(run: ToolRun | undefined): boolean {
  return run?.outcome === "running";
}

/// What became of a run, in a sentence. Every branch names something
/// observed -- there is no branch for "probably fine".
export function toolRunSentence(run: ToolRun): string {
  switch (run.outcome) {
    case "running":
      return "Still running.";
    case "passed":
      return run.exitCode === 0
        ? "Finished — it exited cleanly."
        : "Finished — the agent's turn ended without an error.";
    case "failed":
      return run.exitCode === null || run.exitCode === undefined
        ? "Failed — the agent stopped with an error."
        : `Failed — it exited with code ${run.exitCode}.`;
    case "abandoned":
      return (
        "Gavin stopped watching this run — the daemon restarted, or nothing was attached " +
        "when it ended. Its end was not recorded."
      );
    default:
      return "Gavin has no record of how this run ended.";
  }
}

/// The word on the chip. Short enough to sit beside an age, and the same
/// four words the daemon stores, so what the row says and what the
/// database holds cannot drift.
export function toolRunVerdict(run: ToolRun): string {
  switch (run.outcome) {
    case "running":
      return "running";
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "abandoned":
      return "not recorded";
    default:
      return "unknown";
  }
}

/// Which state of the app's RUN axis a tool run draws as, and the exit
/// code that splits that axis's `exited` into a clean finish and a
/// crash. Fed straight to `runIndicator` by the view.
///
/// The four tool outcomes map onto the run axis exactly once each --
/// `passed` is its clean `exited`, `failed` its non-zero one -- so a
/// tool run is drawn in the same glyph and the same tone as the card run
/// beside it. `failed` with no code of its own is handed a 1: an agent
/// that broke has no exit code, and the axis needs a non-zero one to
/// pick the danger tone.
export function toolRunAxis(run: ToolRun): { outcome: string; exitCode: number | null } {
  switch (run.outcome) {
    case "running":
      return { outcome: "running", exitCode: null };
    case "passed":
      return { outcome: "exited", exitCode: 0 };
    case "failed":
      return { outcome: "exited", exitCode: run.exitCode ?? 1 };
    default:
      return { outcome: "abandoned", exitCode: null };
  }
}

/// The badge's tooltip. The one thing NOT borrowed from the run axis:
/// its danger tip reads "ended with a non-zero exit code", which is
/// false about an agent that stopped talking, and a badge asserting
/// evidence nobody read is worse than no badge. Leads with the axis
/// name, like every other tooltip in the vocabulary.
export function toolRunTip(run: ToolRun): string {
  return `Run · ${toolRunSentence(run)}`;
}

/// "passed · 4m ago". Null when the tool has never been run, which the
/// row draws as nothing at all rather than as an empty chip.
///
/// `nowMs` in milliseconds and `startedAt` in seconds is the conversion
/// this module promised to do at the edge: `relativeTime` is the app's
/// one age formatter and it thinks in the browser's clock.
export function toolRunChip(run: ToolRun | undefined, nowMs: number): string | null {
  if (!run) return null;
  const at = run.endedAt ?? run.startedAt;
  return `${toolRunVerdict(run)} · ${relativeTime(at * 1000, nowMs)}`;
}

/// Where the row says this tool runs, or null when there is nothing
/// worth saying -- which is the common case, because a tool with no
/// directory of its own runs at the workspace root like everything else.
///
/// The tool's OWN spelling, not the resolved absolute path: the human
/// typed `apps/web`, and a row that answered `/Users/…/repo/apps/web`
/// would be wider and say less.
export function toolCwdLabel(tool: Pick<Tool, "cwd">): string | null {
  const own = tool.cwd?.trim() ?? "";
  return own && own !== "." ? own : null;
}

/// Why this tool cannot be run right now, or null.
///
/// Ordered by what the human can do about it. The daemon comes first
/// because no amount of editing the tool fixes it; the root second
/// because a workspace with no folder has nowhere to run ANY tool; and
/// the open run last, because that one is not an error at all -- it is
/// the tool doing what it was asked.
export function runBlockedReason(input: {
  compat: DaemonCompat | null;
  rootPath: string | null;
  tool: Tool;
  lastRun: ToolRun | undefined;
}): string | null {
  const gated = featureBlockedReason(input.compat, "toolRuns");
  if (gated) return gated;
  if (!isRunnableStandalone(input.tool)) {
    return `A ${input.tool.kind} tool is a rail's completion rule — it only means something as a step.`;
  }
  if (resolveToolCwd(input.tool, input.rootPath) === null) {
    return "This workspace has no root folder, so there is nowhere to run a tool.";
  }
  if (isRunOpen(input.lastRun)) {
    return "This tool is already running — open its session, or wait for it to finish.";
  }
  return null;
}

/// The tab's own one-line state, for the empty and the loading case.
/// Null while the library is still being fetched -- `renderLibraryFor`
/// hands the view the built-ins meanwhile, so there is always something
/// to draw and never a reason to say "loading".
export function toolsEmptyMessage(runnable: Tool[], search: string): string | null {
  if (runnable.length > 0) return null;
  return search.trim()
    ? `No tool matches “${search.trim()}”.`
    : "No tools yet — open Manage tools… to write one.";
}

/// Free-text match over the fields a human would type: the name, the
/// description and the kind's own label. Not the body -- a search that
/// hit inside a prompt would match half the library on the word "the".
export function matchesToolSearch(tool: Tool, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return (
    tool.name.toLowerCase().includes(needle) ||
    tool.description.toLowerCase().includes(needle) ||
    tool.kind.includes(needle)
  );
}
