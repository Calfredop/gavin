// The Orchestration tab's two agent requests -- Organize and a rail's
// Reorganize -- as pure decisions: what a run is called, when it is over,
// and what each button does while one is going. No Svelte, no Tauri, no
// I/O; orchestrationState.ts owns every effect (launch, reveal, and the
// sweep that frees the slot), the same split orchestration.ts and
// orchestrationState.ts already use.
//
// Both requests spawn a DEDICATED session now (the shape "Develop into a
// plan…" uses) rather than pasting into the workspace's main agent. That
// buys a tab per run, an agent that starts with no other conversation in
// its context, and -- the reason this module exists -- a run with an
// identity, which is the only way a second press can be told there is a
// first one still thinking.

import type { SessionStatus } from "./notifications";
import type { OrchestrationAgentRecord, SessionLiveness } from "./workspace";

/// The name a whole-tab Organize wears wherever a run is named.
export const ORGANIZE_LABEL = "Organize";

/// The name one rail's Reorganize wears. The rail is quoted because rail
/// names are the human's own words and can be a whole sentence -- an
/// unquoted one runs straight into the rest of the message.
export function reorganizeLabel(railName: string): string {
  return `Reorganize “${railName}”`;
}

/// IS THE RUN OVER? The one rule, because three surfaces ask it: the
/// sweep that frees the slot, the buttons that read the slot, and the
/// adoption at startup -- which is the same question asked about a run
/// this window did not start.
///
/// Three ways a run ends, and none of them is an exit code: the agent is
/// interactive, so its session sits at a prompt forever once the work is
/// done (the fact that made every agent-kind rail tool unfinishable
/// before `agentTurnEnded`).
///
///  - `gone` -- the session left the layout, so the run left with it.
///  - `interrupted` -- a daemon restart killed the agent and put a bare
///    shell back wearing its id. The tree still holds the id, which is
///    exactly why liveness has to be asked rather than "is it in the
///    tree".
///  - `idle` -- the agent stopped talking, which for a one-shot request
///    like this is the finish line.
///
/// An ABSENT status is deliberately not idle. The daemon registers a new
/// session idle and only pushes on a CHANGE, so "nothing reported yet"
/// arrives here as `undefined` -- reading that as idle would end every
/// run in the same tick it launched, and the second press this module
/// exists to refuse would sail straight through.
///
/// `waiting_for_input` is not idle either: an agent asking the human a
/// question has not finished, and freeing the slot there would let a
/// second run start on top of a question nobody has answered.
export function orchestrationAgentOver(
  liveness: SessionLiveness,
  status: SessionStatus | undefined
): boolean {
  if (liveness !== "live") return true;
  return status === "idle";
}

/// What a press does. `jump` rather than a disabled button on purpose: a
/// disabled element fires no mouseenter, so its tooltip never opens and
/// the human is left with a dead control and no reason (the trap
/// tooltip.ts documents). A press that lands them in the tab already
/// doing the work answers the question instead of refusing it.
export type OrchestrationAgentAction =
  | { kind: "start"; tip: string }
  | { kind: "jump"; tip: string }
  | { kind: "blocked"; tip: string };

/// Why no orchestration agent can be started at all, before anything
/// about which button was pressed. Null when the workspace is ready.
function launchBlocker(hasRoot: boolean, daemonBlocked: string | null): string | null {
  if (daemonBlocked) return daemonBlocked;
  // The agent is spawned in the workspace ROOT -- never a rail's
  // worktree, which is a different checkout with a different (or no)
  // `.gavin-root`, and the gavin tools resolve the workspace by where
  // they are run. Without a root there is nowhere to start it.
  if (!hasRoot) return "This workspace has no root folder — set one on the Settings tab first";
  return null;
}

/// The run holding the workspace's one slot, phrased for a button that
/// is not the one that started it.
function busyTip(run: OrchestrationAgentRecord): string {
  return `${run.label} is already running — jump to its tab`;
}

export interface OrganizeInput {
  /// The workspace's in-flight orchestration agent, or null.
  run: OrchestrationAgentRecord | null;
  /// How many unplaced cards Organize would actually be handed. Measured
  /// over every unplaced card, never the search lens's view: Organize
  /// hands the agent the real set, so a filter that happens to hide them
  /// all must not claim there is nothing left to place.
  unplacedCount: number;
  hasRoot: boolean;
  /// featureBlockedReason for orchestration writes, or null.
  daemonBlocked: string | null;
}

/// The tab header's "Organize with agent…".
///
/// Note what is NOT here any more: whether the workspace's main agent is
/// running. Organize used to be paste-only, so a stopped main agent made
/// it impossible; it now starts an agent of its own, and a tab the human
/// never opened is no longer a precondition for organizing their work.
export function organizeAction(input: OrganizeInput): OrchestrationAgentAction {
  const blocked = launchBlocker(input.hasRoot, input.daemonBlocked);
  if (blocked) return { kind: "blocked", tip: blocked };
  if (input.run) return { kind: "jump", tip: busyTip(input.run) };
  if (input.unplacedCount === 0) {
    return {
      kind: "blocked",
      tip: "Nothing is left to place — every unfinished card is already on a rail",
    };
  }
  return {
    kind: "start",
    tip: "Hand the unplaced cards to a new agent — it spreads them across rails, worktrees and branches…",
  };
}

export interface ReorganizeInput {
  run: OrchestrationAgentRecord | null;
  /// The rail whose wand this is.
  railId: string;
  hasRoot: boolean;
  daemonBlocked: string | null;
}

/// A rail header's "Reorganize with agent…".
///
/// The slot is the WORKSPACE's, not the rail's, and every rail's wand
/// reads it. Both requests end in a write of the whole plan -- the
/// prompts tell the agent to send every rail it was not asked about back
/// exactly as it read it -- so two runs at once do not divide the work,
/// they overwrite each other, and the loser is whichever finishes first.
export function reorganizeAction(input: ReorganizeInput): OrchestrationAgentAction {
  const blocked = launchBlocker(input.hasRoot, input.daemonBlocked);
  if (blocked) return { kind: "blocked", tip: blocked };
  const run = input.run;
  if (run) {
    return {
      kind: "jump",
      tip:
        run.railId === input.railId
          ? "This rail's reorganize is already running — jump to its tab"
          : busyTip(run),
    };
  }
  return { kind: "start", tip: "Reorganize this rail with a new agent…" };
}

/// The header button's FACE. It stops saying "Organize" the moment a run
/// holds the slot, because pressing it then jumps to that run instead --
/// and a button whose word and whose effect disagree is worse than a dead
/// one. A rail's Reorganize gets the neutral wording: the header button
/// is not the thing that started it.
export function organizeButtonLabel(run: OrchestrationAgentRecord | null): string {
  if (!run) return "Organize with agent…";
  return run.railId ? "Agent running…" : "Organizing…";
}
