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
import { patchPlanField, patchPlanPath } from "./gavinState";
import {
  composeTaskPrompt,
  composePlanPrompt,
  composeResumeTaskPrompt,
  composeResumePlanPrompt,
  buildRunCommand,
  runStatusNeeded,
} from "./cardRun";
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
export function runCard(workspaceId: string, card: CardView): Promise<string | null> {
  return launchCard(workspaceId, card, "run");
}

// Resume: the same launch, with the prompt that tells the agent work on
// this card already happened (columnRunAction.ts). Deliberately usable
// on a card whose bound session has EXITED -- picking that work back up
// is the whole point -- and the fresh session replaces the dead
// binding. A live session still just gets a jump: it is the work.
export function resumeCard(workspaceId: string, card: CardView): Promise<string | null> {
  return launchCard(workspaceId, card, "resume");
}

async function launchCard(
  workspaceId: string,
  card: CardView,
  mode: "run" | "resume"
): Promise<string | null> {
  if (card.kind === "note") return "Notes are not runnable";

  if ((await jumpToBoundSession(workspaceId, card.id)) === "jumped") return null;
  const state = get(layoutState);
  const binding = cardSessionFor(get(kanbanState)[workspaceId], card.id);
  if (binding && findSessionLocation(state, binding.sessionId)) return null;

  // Status FIRST: running a Done card un-archives it out of `plans/done/`,
  // and the prompt has to name where the file ends up, not where it was.
  // A nested task gaining In Progress frees itself from its plan --
  // deliberate: it is actively being worked (spec §3). A resume normally
  // writes nothing here: its card already sits In Progress.
  let path = card.id;
  if (runStatusNeeded(card.status)) {
    try {
      path = await backend.setPlanFrontmatterField(card.id, "status", "In Progress");
      patchPlanField(workspaceId, card.id, "status", "In Progress");
      if (path !== card.id) patchPlanPath(workspaceId, card.id, path);
    } catch (e) {
      return `Couldn't set In Progress: ${e instanceof Error ? e.message : e}`;
    }
  }

  let prompt: string;
  if (card.kind === "task") {
    const file = await backend.readFileForViewer(path);
    if (!file.exists) return `Card file not found: ${path}`;
    const body = stripFrontmatter(file.content).trim();
    prompt =
      mode === "resume"
        ? composeResumeTaskPrompt(path, card.title, body)
        : composeTaskPrompt(path, card.title, body);
  } else {
    prompt = mode === "resume" ? composeResumePlanPrompt(path) : composePlanPrompt(path);
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
  await linkCardSessionAction(workspaceId, { path, sessionId, cwd, command });
  return null;
}

const NO_MAIN_AGENT = "No workspace agent running — start it on the Home tab first";

/// The workspace's running main agent, or null. Exported so callers can
/// fail fast before doing work (composing a prompt reads a file).
export function mainAgentSessionId(workspaceId: string): string | null {
  return get(layoutState).workspaces.find((w) => w.id === workspaceId)?.mainSessionId ?? null;
}

/// Bracketed paste into the workspace's RUNNING main agent, then Enter.
/// Bracketed so a multi-line prompt arrives as one block instead of
/// line-by-line submissions. Returns an error string, or null.
///
/// Never starts the agent: agent launches cost money and attention, and
/// that is the human's call.
export async function pasteToMainAgent(
  workspaceId: string,
  prompt: string
): Promise<string | null> {
  const mainSessionId = mainAgentSessionId(workspaceId);
  if (!mainSessionId) return NO_MAIN_AGENT;
  try {
    await backend.writeInput(mainSessionId, `\x1b[200~${prompt}\x1b[201~\r`);
  } catch (e) {
    return `Couldn't reach the workspace agent: ${e instanceof Error ? e.message : e}`;
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
  // Checked before composing: composing reads the card file, and "no
  // agent" is the more useful message when both are true.
  if (!mainAgentSessionId(workspaceId)) return NO_MAIN_AGENT;
  // Status FIRST, for the same reason as launchCard: sending a Done card
  // un-archives it, and the agent must be handed the path it lands on.
  let path = card.id;
  if (runStatusNeeded(card.status)) {
    try {
      path = await backend.setPlanFrontmatterField(card.id, "status", "In Progress");
      patchPlanField(workspaceId, card.id, "status", "In Progress");
      if (path !== card.id) patchPlanPath(workspaceId, card.id, path);
    } catch (e) {
      return `Couldn't set In Progress: ${e instanceof Error ? e.message : e}`;
    }
  }
  let prompt: string;
  if (card.kind === "task") {
    const file = await backend.readFileForViewer(path);
    if (!file.exists) return `Card file not found: ${path}`;
    prompt = composeTaskPrompt(path, card.title, stripFrontmatter(file.content).trim());
  } else {
    prompt = composePlanPrompt(path);
  }
  const pasteError = await pasteToMainAgent(workspaceId, prompt);
  if (pasteError) return pasteError;
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
