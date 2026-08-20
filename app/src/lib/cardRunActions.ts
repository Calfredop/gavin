// The run flow for executable cards (card-model spec §3): spawn a
// visible agent session with a generated prompt, land it on the Agents
// page (D19 posture via handleAgentSessionSpawned), bind it to the card,
// and write In Progress. One live session per card: Run with a live
// binding jumps instead of double-spawning. The app never auto-completes.

import { get } from "svelte/store";
import * as backend from "./backend";
import { layoutState, handleAgentSessionSpawned, switchWorkspaceView, switchToSessionInPage } from "./layoutState";
import { findSessionLocation } from "./workspace";
import { kanbanState, cardSessionFor, linkCardSessionAction } from "./kanbanState";
import { patchPlanField } from "./gavinState";
import { composeTaskPrompt, composePlanPrompt, buildRunCommand, runStatusNeeded } from "./cardRun";
import { stripFrontmatter } from "./planChecklist";
import type { CardView } from "./planBoard";

// Returns an error string for the board's error strip, or null.
export async function runCard(workspaceId: string, card: CardView): Promise<string | null> {
  if (card.kind === "note") return "Notes are not runnable";

  const state = get(layoutState);
  const binding = cardSessionFor(get(kanbanState)[workspaceId], card.id);
  if (binding) {
    const location = findSessionLocation(state, binding.sessionId);
    if (location) {
      await switchWorkspaceView(location.workspaceId, "terminal");
      await switchToSessionInPage(location.workspaceId, location.pageId, binding.sessionId);
      return null;
    }
  }

  let prompt: string;
  if (card.kind === "task") {
    const file = await backend.readFileForViewer(card.id);
    if (!file.exists) return `Card file not found: ${card.id}`;
    prompt = composeTaskPrompt(card.id, card.title, stripFrontmatter(file.content).trim());
  } else {
    prompt = composePlanPrompt(card.id);
  }

  const workspace = state.workspaces.find((w) => w.id === workspaceId);
  const agentCommand = workspace?.agentCommand?.trim() || "claude";
  const command = buildRunCommand(agentCommand, prompt);
  const cwd = card.contextFolder;

  let sessionId: string;
  try {
    sessionId = await backend.createSession(cwd, command);
  } catch (e) {
    return `Couldn't start the agent: ${e instanceof Error ? e.message : e}`;
  }
  handleAgentSessionSpawned(workspaceId, sessionId);
  await linkCardSessionAction(workspaceId, { path: card.id, sessionId, cwd, command });
  // A nested task gaining In Progress frees itself from its plan --
  // deliberate: it is actively being worked (spec §3).
  if (runStatusNeeded(card.status)) {
    try {
      await backend.setPlanFrontmatterField(card.id, "status", "In Progress");
      patchPlanField(workspaceId, card.id, "status", "In Progress");
    } catch (e) {
      return `Agent started, but couldn't set In Progress: ${e instanceof Error ? e.message : e}`;
    }
  }
  return null;
}

// Re-launch from the remembered binding (same cwd/command), replacing
// the stored session id -- the old modal's behavior, file-card edition.
export async function relaunchCard(workspaceId: string, path: string): Promise<string | null> {
  const binding = cardSessionFor(get(kanbanState)[workspaceId], path);
  if (!binding) return "No session remembered for this card";
  let sessionId: string;
  try {
    sessionId = await backend.createSession(binding.cwd, binding.command ?? undefined);
  } catch (e) {
    return `Couldn't re-launch: ${e instanceof Error ? e.message : e}`;
  }
  handleAgentSessionSpawned(workspaceId, sessionId);
  await linkCardSessionAction(workspaceId, { ...binding, sessionId });
  return null;
}
