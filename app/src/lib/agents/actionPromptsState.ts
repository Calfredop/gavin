// Reactive half of action prompt overrides: app-wide (config.json via
// AgentDefaults) and per-workspace (Workspace.actionPromptOverrides).
// Resolution stays in actionPrompts.ts.

import { derived, get } from "svelte/store";
import {
  EMPTY_AGENT_DEFAULTS,
  type AgentDefaults,
} from "$lib/cards/complexity";
import {
  actionPromptById,
  applyToolBodyOverrides,
  bodySource,
  effectiveBody,
  pruneOverrides,
  resolveActionPrompt,
  withOverride,
  type ActionPromptSource,
} from "$lib/agents/actionPrompts";
import { layoutState, agentDefaultsStore, setAgentDefaults } from "$lib/core/layoutState";
import type { Tool } from "$lib/orchestration/orchestrationTools";

/// App-wide overrides, mirrored from agentDefaultsStore so the Tools
/// explorer and composers share one reading.
export const appPromptOverrides = derived(agentDefaultsStore, ($d) =>
  pruneOverrides($d.actionPromptOverrides ?? {})
);

export function workspacePromptOverrides(workspaceId: string | null | undefined): Record<string, string> {
  if (!workspaceId) return {};
  const ws = get(layoutState).workspaces.find((w) => w.id === workspaceId);
  return pruneOverrides(ws?.actionPromptOverrides ?? {});
}

export function promptBodyFor(
  id: string,
  workspaceId: string | null | undefined
): string | null {
  return resolveActionPrompt(id, get(appPromptOverrides), workspacePromptOverrides(workspaceId));
}

export function promptSourceFor(
  id: string,
  workspaceId: string | null | undefined
): ActionPromptSource {
  return bodySource(id, get(appPromptOverrides), workspacePromptOverrides(workspaceId));
}

export function libraryWithPromptOverrides(
  library: Tool[],
  workspaceId: string | null | undefined
): Tool[] {
  return applyToolBodyOverrides(library, get(appPromptOverrides), workspacePromptOverrides(workspaceId));
}

/// Persist an app-level override (or clear with null).
export async function setAppPromptOverride(id: string, body: string | null): Promise<void> {
  if (!actionPromptById(id)) throw new Error(`unknown action prompt ${id}`);
  const current = get(agentDefaultsStore);
  const actionPromptOverrides = withOverride(current.actionPromptOverrides, id, body);
  await setAgentDefaults({ ...current, actionPromptOverrides });
}

/// Persist a workspace-level override. `persistWorkspaceField` is injected
/// so this module does not import the whole workspace mutator graph at
/// load time in unit tests.
let persistWorkspaceOverrides:
  | ((workspaceId: string, overrides: Record<string, string>) => Promise<void>)
  | null = null;

export function bindWorkspacePromptPersistence(
  fn: (workspaceId: string, overrides: Record<string, string>) => Promise<void>
): void {
  persistWorkspaceOverrides = fn;
}

export async function setWorkspacePromptOverride(
  workspaceId: string,
  id: string,
  body: string | null
): Promise<void> {
  if (!actionPromptById(id)) throw new Error(`unknown action prompt ${id}`);
  if (!persistWorkspaceOverrides) {
    throw new Error("workspace prompt persistence is not bound");
  }
  const current = workspacePromptOverrides(workspaceId);
  await persistWorkspaceOverrides(workspaceId, withOverride(current, id, body));
}

/** Effective body for a known id, falling back to its default. */
export function mustPromptBody(id: string, workspaceId: string | null | undefined): string {
  const prompt = actionPromptById(id);
  if (!prompt) throw new Error(`unknown action prompt ${id}`);
  return effectiveBody(
    id,
    prompt.defaultBody,
    get(appPromptOverrides),
    workspacePromptOverrides(workspaceId)
  );
}

/** @internal */
export function __resetPromptPersistenceForTesting(): void {
  persistWorkspaceOverrides = null;
}

/** Ensure AgentDefaults always carries the map (older configs omit it). */
export function withActionPromptOverrides(defaults: AgentDefaults): AgentDefaults {
  return {
    ...EMPTY_AGENT_DEFAULTS,
    ...defaults,
    actionPromptOverrides: pruneOverrides(defaults.actionPromptOverrides ?? {}),
  };
}
