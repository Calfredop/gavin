/// The live side of fallback arming: one request the shell mounts a
/// setup-only wizard for, and a focus watcher that queues the next
/// unarmed chain/complexity agent.

import { get, writable } from "svelte/store";
import {
  agentsOwedArming,
  effectiveFallbackChain,
  newlyAddedToChain,
} from "$lib/agents/agentFallback";
import {
  agentDefaultsStore,
  layoutState,
  markAgentArmed,
  resolvedAgentFor,
  workspaceComplexityTable,
} from "$lib/core/layoutState";
import { COMPLEXITY_LEVELS, complexityEntry } from "$lib/cards/complexity";

export interface ArmRequest {
  workspaceId: string;
  profileId: string;
}

export const armRequest = writable<ArmRequest | null>(null);

/// Profile ids the human dismissed this session, so cancelling the
/// wizard does not immediately reopen it on the same focus.
const dismissed = new Set<string>();

function key(workspaceId: string, profileId: string): string {
  return `${workspaceId}\0${profileId}`;
}

export function requestArm(workspaceId: string, profileId: string): void {
  const id = profileId.trim();
  if (!workspaceId || !id) return;
  if (dismissed.has(key(workspaceId, id))) return;
  const current = get(armRequest);
  if (current?.workspaceId === workspaceId && current.profileId === id) return;
  armRequest.set({ workspaceId, profileId: id });
}

export function dismissArmRequest(): void {
  const current = get(armRequest);
  if (current) dismissed.add(key(current.workspaceId, current.profileId));
  armRequest.set(null);
}

export async function completeArmRequest(): Promise<void> {
  const current = get(armRequest);
  armRequest.set(null);
  if (!current) return;
  dismissed.delete(key(current.workspaceId, current.profileId));
  await markAgentArmed(current.workspaceId, current.profileId);
  const next = owedArming(current.workspaceId)[0];
  if (next) requestArm(current.workspaceId, next);
}

export function owedArming(workspaceId: string): string[] {
  const state = get(layoutState);
  const workspace = state.workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return [];
  const app = get(agentDefaultsStore);
  const chain = effectiveFallbackChain(workspace.agentFallback, app.agentFallback);
  const wsTable = workspaceComplexityTable(workspaceId);
  const complexityProfiles: string[] = [];
  for (const level of COMPLEXITY_LEVELS) {
    const entry = complexityEntry(level, app.complexity, wsTable);
    const profile = entry?.profile.trim();
    if (profile) complexityProfiles.push(profile);
  }
  return agentsOwedArming({
    chain,
    complexityProfiles,
    armed: new Set(workspace.armedAgents ?? []),
    workspaceProfileId: resolvedAgentFor(workspaceId).profileId,
  });
}

/// After a workspace chain edit, arm profiles that just appeared.
export function armNewlyAdded(workspaceId: string, before: string[], after: string[]): void {
  const added = newlyAddedToChain(before, after);
  if (added[0]) requestArm(workspaceId, added[0]);
}

let lastFocus: string | null = null;

/// Subscribe to workspace focus. Call once at bootstrap; a second call
/// is a no-op for the lastFocus tracker (the subscriber stacks).
export function startArmOnFocus(): () => void {
  return layoutState.subscribe((s) => {
    if (s.activeWorkspaceId === lastFocus) return;
    lastFocus = s.activeWorkspaceId;
    if (!lastFocus) return;
    const next = owedArming(lastFocus)[0];
    if (next) requestArm(lastFocus, next);
  });
}
