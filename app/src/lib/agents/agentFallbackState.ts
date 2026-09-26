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
  setAgentArmDeclined,
  workspaceComplexityTable,
} from "$lib/core/layoutState";
import { COMPLEXITY_LEVELS, complexityEntry } from "$lib/cards/complexity";

export interface ArmRequest {
  workspaceId: string;
  profileId: string;
}

export const armRequest = writable<ArmRequest | null>(null);

/// Profile ids the human dismissed this session, so cancelling the
/// wizard does not immediately reopen it on the same focus. Only this
/// process remembers a Cancel; "Don't ask again" is the persisted
/// answer (`Workspace.declinedAgents`), since a Set that dies with the
/// process asks again on every launch of the app.
const dismissed = new Set<string>();

function key(workspaceId: string, profileId: string): string {
  return `${workspaceId}\0${profileId}`;
}

function declinedIn(workspaceId: string): Set<string> {
  const workspace = get(layoutState).workspaces.find((w) => w.id === workspaceId);
  return new Set(workspace?.declinedAgents ?? []);
}

export function requestArm(workspaceId: string, profileId: string): void {
  const id = profileId.trim();
  if (!workspaceId || !id) return;
  if (dismissed.has(key(workspaceId, id))) return;
  if (declinedIn(workspaceId).has(id)) return;
  const current = get(armRequest);
  if (current?.workspaceId === workspaceId && current.profileId === id) return;
  armRequest.set({ workspaceId, profileId: id });
}

export function dismissArmRequest(): void {
  const current = get(armRequest);
  if (current) dismissed.add(key(current.workspaceId, current.profileId));
  armRequest.set(null);
}

/// "Don't ask again": record the answer on the workspace, so neither a
/// later focus nor an app restart reopens the wizard for this agent here.
export async function declineArmRequest(): Promise<void> {
  const current = get(armRequest);
  armRequest.set(null);
  if (!current) return;
  dismissed.add(key(current.workspaceId, current.profileId));
  await setAgentArmDeclined(current.workspaceId, current.profileId, true);
}

/// Undo a "Don't ask again" and open the wizard for that agent now.
export async function askAgainToArm(workspaceId: string, profileId: string): Promise<void> {
  const id = profileId.trim();
  if (!workspaceId || !id) return;
  dismissed.delete(key(workspaceId, id));
  await setAgentArmDeclined(workspaceId, id, false);
  requestArm(workspaceId, id);
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
    declined: new Set(workspace.declinedAgents ?? []),
    workspaceProfileId: resolvedAgentFor(workspaceId).profileId,
  });
}

/// After a workspace chain edit, arm profiles that just appeared. Adding
/// an agent to this workspace's chain by hand is a fresh answer, so it
/// overrides an earlier "Don't ask again" for it.
export async function armNewlyAdded(
  workspaceId: string,
  before: string[],
  after: string[]
): Promise<void> {
  const added = newlyAddedToChain(before, after);
  if (!added[0]) return;
  if (declinedIn(workspaceId).has(added[0])) {
    await askAgainToArm(workspaceId, added[0]);
    return;
  }
  requestArm(workspaceId, added[0]);
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
