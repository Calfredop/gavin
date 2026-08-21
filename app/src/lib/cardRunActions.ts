// The run flow for executable cards (card-model spec §3): spawn a
// visible agent session with a generated prompt, land it on the Agents
// page (D19 posture via handleAgentSessionSpawned), bind it to the card,
// and write In Progress. One live session per card: Run with a live
// binding jumps instead of double-spawning. The app never auto-completes.

import { get } from "svelte/store";
import * as backend from "./backend";
import { resolvedAgentFor, layoutState, handleAgentSessionSpawned, switchWorkspaceView, switchToSessionInPage } from "./layoutState";
import { findSessionLocation } from "./workspace";
import { kanbanState, cardSessionFor, linkCardSessionAction } from "./kanbanState";
import { patchPlanField } from "./gavinState";
import { composeTaskPrompt, composePlanPrompt, buildRunCommand, runStatusNeeded } from "./cardRun";
import { stripFrontmatter } from "./planChecklist";
import type { CardView } from "./planBoard";

// Focus a card's bound live session (card-model spec §3): "jumped" on
// success, "exited" when the binding's session is gone (Re-launch lives
// in the card detail), "none" when nothing is bound.
export async function jumpToBoundSession(
  workspaceId: string,
  path: string
): Promise<"jumped" | "exited" | "none"> {
  const binding = cardSessionFor(get(kanbanState)[workspaceId], path);
  if (!binding) return "none";
  const location = findSessionLocation(get(layoutState), binding.sessionId);
  if (!location) return "exited";
  await switchWorkspaceView(location.workspaceId, "terminal");
  await switchToSessionInPage(location.workspaceId, location.pageId, binding.sessionId);
  return "jumped";
}

// Returns an error string for the board's error strip, or null.
export async function runCard(workspaceId: string, card: CardView): Promise<string | null> {
  if (card.kind === "note") return "Notes are not runnable";

  if ((await jumpToBoundSession(workspaceId, card.id)) === "jumped") return null;
  const state = get(layoutState);
  const binding = cardSessionFor(get(kanbanState)[workspaceId], card.id);
  if (binding && findSessionLocation(state, binding.sessionId)) return null;

  let prompt: string;
  if (card.kind === "task") {
    const file = await backend.readFileForViewer(card.id);
    if (!file.exists) return `Card file not found: ${card.id}`;
    prompt = composeTaskPrompt(card.id, card.title, stripFrontmatter(file.content).trim());
  } else {
    prompt = composePlanPrompt(card.id);
  }

  // The launch command lives in .gavin-root/config.toml now (D41), so it
  // comes from the same resolver the main agent and the settings panel
  // use rather than a per-workspace field.
  const command = buildRunCommand(resolvedAgentFor(workspaceId).command, prompt);
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

// Hands a card to the RUNNING workspace agent (the Home panel's main
// session, D12) instead of spawning a dedicated one: the same prompt is
// bracketed-pasted into its terminal and submitted, the card gets In
// Progress, and the view jumps to Home to watch. No card_sessions
// binding -- the main agent serves many cards; the card's status
// lifecycle is the tracking. Never starts the agent (sub-6 invariant:
// agent launches cost money and attention).
export async function sendToMainAgent(workspaceId: string, card: CardView): Promise<string | null> {
  if (card.kind === "note") return "Notes are not runnable";
  const workspace = get(layoutState).workspaces.find((w) => w.id === workspaceId);
  const mainSessionId = workspace?.mainSessionId ?? null;
  if (!mainSessionId) return "No workspace agent running — start it on the Home tab first";

  let prompt: string;
  if (card.kind === "task") {
    const file = await backend.readFileForViewer(card.id);
    if (!file.exists) return `Card file not found: ${card.id}`;
    prompt = composeTaskPrompt(card.id, card.title, stripFrontmatter(file.content).trim());
  } else {
    prompt = composePlanPrompt(card.id);
  }
  try {
    // Bracketed paste so a multi-line prompt arrives as one block
    // instead of line-by-line submissions, then Enter.
    await backend.writeInput(mainSessionId, `\x1b[200~${prompt}\x1b[201~\r`);
  } catch (e) {
    return `Couldn't reach the workspace agent: ${e instanceof Error ? e.message : e}`;
  }
  if (runStatusNeeded(card.status)) {
    try {
      await backend.setPlanFrontmatterField(card.id, "status", "In Progress");
      patchPlanField(workspaceId, card.id, "status", "In Progress");
    } catch (e) {
      return `Sent, but couldn't set In Progress: ${e instanceof Error ? e.message : e}`;
    }
  }
  await switchWorkspaceView(workspaceId, "home");
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
