// What is configured PER AGENT besides its launch fields -- its complexity
// table, its pause cycle, its two add/remove lists -- read and written the
// same way wherever it is drawn: the desk's app page and workspace tab
// (`AgentPrimaryPanel.svelte`) and the Companion's two settings screens.
//
// Two scopes, one rule. In the "app" scope the value IS the app-wide one
// for that agent. In the "workspace" scope a key the workspace does not
// hold INHERITS the app-wide value, and a key it holds -- even an empty
// list, even a table with no rows, even a cycle that is switched off --
// replaces it whole. That is why every "own" question below is a key-is-
// present check and never a truthiness one: absent and empty are
// different answers.
//
// Pure reads (`primaryView`) and thin writes over the layoutState setters.
// The templates stay templates over this.

import {
  setAgentDefaults,
  setWorkspaceComplexityTable,
  setWorkspacePause,
  setWorkspacePromptParams,
} from "$lib/core/layoutState";
import { saveAgentPauseFor } from "$lib/agents/agentPauseState";
import {
  complexityTableForPrimary,
  withComplexityTableForPrimary,
  type AgentDefaults,
  type ComplexityTable,
} from "$lib/cards/complexity";
import { DEFAULT_CYCLE, pauseCycleForPrimary, type PauseCycle } from "$lib/agents/agentPause";
import {
  effectiveListForPrimary,
  listForPrimary,
  withListForPrimary,
  workspaceOwnsList,
} from "$lib/agents/promptParams";
import type { AgentsHubScope } from "$lib/agents/agentsHub";
import type { Workspace } from "$lib/core/workspace";

/// The two add/remove lists an agent carries.
export type ListKind = "promptExtras" | "extraCliArgs";

export interface PrimaryView {
  /// The app-wide table for this agent (what a workspace inherits).
  appTable: ComplexityTable;
  /// Whether the table shown is one this scope owns -- always in the app
  /// scope, only once the workspace took one of its own there.
  ownsTable: boolean;
  /// The table the editor shows: the owned one, else the inherited one.
  table: ComplexityTable;
  /// The app-wide cycle for this agent, or null (never held).
  appCycle: PauseCycle | null;
  /// The cycle this scope owns for the agent, or null.
  ownCycle: PauseCycle | null;
  /// Whether the pause fields edit a value this scope owns.
  ownsCycle: boolean;
  /// The cycle the fields start from: the owned one, else the shipped
  /// default (disabled), so an editor always has values to put on screen.
  cycleOrDefault: PauseCycle;
  promptLines: string[];
  cliArgs: string[];
  ownsPromptLines: boolean;
  ownsCliArgs: boolean;
}

function has(map: Record<string, unknown> | null | undefined, key: string): boolean {
  return Boolean(map && Object.prototype.hasOwnProperty.call(map, key));
}

/// Everything the per-agent blocks show for one agent in one scope.
/// `ws` is the workspace in the workspace scope and ignored in the app's.
export function primaryView(
  scope: AgentsHubScope,
  primaryId: string,
  defaults: AgentDefaults,
  ws: Pick<Workspace, "complexityTables" | "pauseCycles" | "promptExtras" | "extraCliArgs"> | null
): PrimaryView {
  const inWorkspace = scope === "workspace" && ws !== null;
  const appTable = complexityTableForPrimary(defaults.complexityTables, primaryId);
  const ownsTable = scope === "app" || (inWorkspace && has(ws?.complexityTables, primaryId));
  const table =
    scope === "app" ? appTable : ownsTable ? (ws?.complexityTables?.[primaryId] ?? {}) : appTable;

  const appCycle = pauseCycleForPrimary(defaults.pauseCycles, primaryId);
  const ownCycle =
    scope === "app"
      ? appCycle
      : inWorkspace && has(ws?.pauseCycles, primaryId)
        ? (ws?.pauseCycles?.[primaryId] ?? null)
        : null;
  const ownsCycle = scope === "app" || ownCycle !== null;

  const list = (kind: ListKind): string[] =>
    scope === "app"
      ? listForPrimary(defaults[kind], primaryId)
      : effectiveListForPrimary(ws?.[kind], defaults[kind], primaryId);
  const ownsList = (kind: ListKind): boolean =>
    scope === "app" || workspaceOwnsList(ws?.[kind], primaryId);

  return {
    appTable,
    ownsTable,
    table,
    appCycle,
    ownCycle,
    ownsCycle,
    cycleOrDefault: ownCycle ?? { ...DEFAULT_CYCLE, anchorMs: 0 },
    promptLines: list("promptExtras"),
    cliArgs: list("extraCliArgs"),
    ownsPromptLines: ownsList("promptExtras"),
    ownsCliArgs: ownsList("extraCliArgs"),
  };
}

// ---- writes -------------------------------------------------------------

/// Saves one agent's complexity table in the given scope. App scope
/// strips an empty table (absent and empty are one state there); a
/// workspace keeps it (empty = "no routing here", absent = inherit) and
/// `null` hands the agent back to the app-wide table.
export async function saveComplexityTable(
  scope: AgentsHubScope,
  workspaceId: string,
  primaryId: string,
  defaults: AgentDefaults,
  table: ComplexityTable | null
): Promise<void> {
  if (scope === "app") {
    await setAgentDefaults({
      ...defaults,
      complexityTables: withComplexityTableForPrimary(defaults.complexityTables, primaryId, table),
    });
  } else {
    await setWorkspaceComplexityTable(workspaceId, primaryId, table);
  }
}

/// Saves one agent's pause cycle. The app scope stamps an anchor on a
/// fresh cycle (`saveAgentPauseFor`), the workspace scope likewise
/// (`setWorkspacePause`); `null` removes the key -- never held in the app
/// scope, inheriting in a workspace.
export async function savePauseCycle(
  scope: AgentsHubScope,
  workspaceId: string,
  primaryId: string,
  cycle: PauseCycle | null
): Promise<void> {
  if (scope === "app") await saveAgentPauseFor(primaryId, cycle);
  else await setWorkspacePause(workspaceId, primaryId, cycle);
}

/// What a workspace's OWN cycle starts as when somebody takes one: a copy
/// of what it inherits, anchor included, so the phase lines up with the
/// app-wide cycle until it is changed on purpose.
export function ownCycleSeed(view: PrimaryView): PauseCycle {
  return { ...(view.appCycle ?? { ...DEFAULT_CYCLE, anchorMs: 0 }) };
}

/// Saves one agent's prompt lines or CLI arguments. The app scope keeps no
/// key for an emptied list (nothing inherits from it); a workspace keeps
/// an empty list as an explicit "none" and `null` as inherit.
export async function saveList(
  scope: AgentsHubScope,
  workspaceId: string,
  primaryId: string,
  defaults: AgentDefaults,
  kind: ListKind,
  list: string[] | null
): Promise<void> {
  if (scope === "app") {
    await setAgentDefaults({
      ...defaults,
      [kind]: withListForPrimary(defaults[kind], primaryId, list && list.length > 0 ? list : null),
    });
  } else {
    await setWorkspacePromptParams(workspaceId, primaryId, kind, list);
  }
}

/// What a workspace's OWN list starts as when somebody takes one.
export function ownListSeed(defaults: AgentDefaults, kind: ListKind, primaryId: string): string[] {
  return [...listForPrimary(defaults[kind], primaryId)];
}
