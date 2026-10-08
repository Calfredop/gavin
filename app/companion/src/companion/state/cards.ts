// Acting on a card from the phone (spec, stories 46 to 48, 51 and 52).
//
// Every action is the desk's own, through the desk's own modules: a move
// asks what the board's drag asks before a plan takes its tasks into
// `done/` (`guardCompletion`), an answer is the Decisions tab's
// (`answerHumanItem`), archiving is the card menu's (`executeArchive`), a
// new card is the composer's arguments (`buildCreatePlanArgs`), and a run
// is the desk's one launch flow (`cardRunActions.ts`). What a Device must
// not do is what those desk actions do to the DESK -- place a session as
// a tab, jump the desk to one, close a tab showing an archived card, hold
// a launch in a queue only the desk's window drains -- so each of those
// steps is handed in here as the phone's own.
import { get } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { nowStore } from "$lib/agents/agentPauseState";
import { launchBlockedReason, type NewLaunchIntent } from "$lib/agents/launchQueue";
import { cardSessionState } from "$lib/board/columnRunAction";
import type { Column } from "$lib/board/kanban";
import { cardSessionFor, kanbanState } from "$lib/board/kanbanState";
import { buildCreatePlanArgs, type ComposeKind } from "$lib/cards/cardCompose";
import { guardCompletion, subjectFromCard } from "$lib/cards/cardCompletion";
import {
  relaunchCard,
  resumeCard,
  runCard,
  type CardLaunchHost,
} from "$lib/cards/cardRunActions";
import type { ChecklistItem } from "$lib/cards/planChecklist";
import * as backend from "$lib/core/backend";
import type { HumanItem, HumanItemOutcome, PlanFileInfo } from "$lib/core/gavin";
import { gavinTrees, patchPlanCreated, patchPlanField, patchPlanPath } from "$lib/core/gavinState";
import { layoutState, stampCardReview } from "$lib/core/layoutState";
import { mergePlanCards, type CardView } from "$lib/core/planBoard";
import { answerHumanItem, type AnswerResult } from "$lib/decisions/decisionsActions";
import { placeCardAtColumnEnd } from "$lib/files/planDrop";
import { executeArchive, executeUnarchive } from "$lib/files/archiveActions";
import type { ArchiveClosables } from "$lib/files/archiveClose";
import type { OrchestrationLaunchHost } from "$lib/orchestration/orchestrationState";
import { launchTables, loadLaunchTables, recordStarted } from "$companion/state/sessions";
import { followCard, openTerminal } from "$companion/state/workstation";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---- Launching -------------------------------------------------------

/// A card launch as a Device makes it (`CardLaunchHost`).
///
/// - A card's live session is shown by opening its terminal HERE; the
///   desk's tabs stay where the desk left them.
/// - The launch wall refuses rather than queues: a queue drains only in
///   the window holding it, and that is the desk's. Its inputs -- the
///   machine's memory, the fleet in flight -- are the desk's pollers',
///   which a phone does not run, so it holds only when the phone has
///   heard enough to know.
/// - The session is the desk's to place, as a tab on the workspace's
///   Agents page labelled with this Device (companion-16). The phone only
///   notes that it started it, which lists it until the desk has.
export const DEVICE_LAUNCH_HOST: CardLaunchHost = {
  async jump(workspaceId, path) {
    const binding = cardSessionFor(get(kanbanState)[workspaceId], path);
    if (!binding) return "none";
    const state = cardSessionState(get(layoutState), binding);
    if (state !== "live") return state;
    openTerminal(binding.sessionId);
    return "jumped";
  },
  hold(_intent: NewLaunchIntent) {
    const why = launchBlockedReason();
    return why ? { go: false, error: `The Workstation is holding new agents: ${why}` } : { go: true };
  },
  place(workspaceId, sessionId) {
    recordStarted(sessionId, workspaceId);
  },
};

/// A launch with no card behind it -- Organize, a rail's Reorganize, a
/// clean of stale decisions or tests -- as a Device starts one: the card
/// launch's wall and placing (`DEVICE_LAUNCH_HOST`), refused rather than
/// queued and the session the desk's to place, and the run shown in the
/// phone's own terminal rather than by moving the desk's tabs.
export const DEVICE_AGENT_HOST: OrchestrationLaunchHost = {
  hold: DEVICE_LAUNCH_HOST.hold,
  place: DEVICE_LAUNCH_HOST.place,
  reveal: async (sessionId) => openTerminal(sessionId),
};

/// The agent tables, read before a launch as a card's run reads them; the
/// pause window judged against the time now, since a phone runs no ticker.
export async function readyToLaunch(): Promise<string | null> {
  await loadLaunchTables();
  nowStore.set(Date.now());
  return get(launchTables) === "ready" ? null : "Couldn't read the Workstation's agent settings — try again";
}

/// The launch a card's bar offers, by the bar's own action id. Resolves
/// with what to tell the human, or null. The agent tables are read first,
/// as a New agent reads them: a card's agent resolved without them would
/// be a guess at the desk's answer. The pause window is judged against
/// the time now -- the desk ticks that clock, and a phone runs no ticker
/// -- while an agent's usage against its limit is the desk's probes' to
/// measure, and its own launches hold on it.
export async function launch(
  workspaceId: string,
  card: CardView,
  action: "run" | "resume" | "relaunch"
): Promise<string | null> {
  await loadLaunchTables();
  nowStore.set(Date.now());
  try {
    switch (action) {
      case "run":
        return await runCard(workspaceId, card, DEVICE_LAUNCH_HOST);
      case "resume":
        return await resumeCard(workspaceId, card, { host: DEVICE_LAUNCH_HOST });
      case "relaunch":
        return await relaunchCard(workspaceId, card.id, { host: DEVICE_LAUNCH_HOST });
    }
  } catch (e) {
    return `Couldn't start the agent: ${message(e)}`;
  }
}

/// The terminal of the agent bound to a card, when it is live.
export async function jumpToAgent(workspaceId: string, card: CardView): Promise<void> {
  await DEVICE_LAUNCH_HOST.jump(workspaceId, card.id);
}

// ---- Writing the card ------------------------------------------------

/// Takes the path a write landed on: the tree follows it at once, as the
/// desk's modal does, and so does a card open on the phone.
function landed(workspaceId: string, from: string, to: string): void {
  if (!to || to === from) return;
  patchPlanPath(workspaceId, from, to);
  followCard(from, to);
}

/// Moves a card to a column, asking first where the move files a plan's
/// nested tasks with it.
export async function moveCard(
  workspaceId: string,
  card: CardView,
  column: string,
  columns: Column[]
): Promise<string | null> {
  if (column === card.status) return null;
  const decision = await guardCompletion(workspaceId, subjectFromCard(card), column, columns);
  if (!decision.proceed) return decision.error;
  try {
    const moved = await backend.setPlanFrontmatterField(card.id, "status", column);
    patchPlanField(workspaceId, card.id, "status", column);
    landed(workspaceId, card.id, moved);
    return null;
  } catch (e) {
    return `Couldn't move the card: ${message(e)}`;
  }
}

/// Renames a card: its title, which is what every surface calls it. The
/// file keeps its name, as it does when the desk renames one.
export async function renameCard(workspaceId: string, card: CardView, title: string): Promise<string | null> {
  const next = title.trim();
  if (!next || next === card.title) return null;
  try {
    const moved = await backend.setPlanFrontmatterField(card.id, "title", next);
    patchPlanField(workspaceId, card.id, "title", next);
    landed(workspaceId, card.id, moved);
    return null;
  } catch (e) {
    return `Couldn't rename the card: ${message(e)}`;
  }
}

/// Ticks or unticks one checklist item. Refused when the line no longer
/// reads what the phone showed -- an agent rewrote the card meanwhile --
/// and the card is read again for the next try.
export async function tickItem(path: string, item: ChecklistItem): Promise<string | null> {
  try {
    await backend.setChecklistItem(path, item.lineIndex, item.rawText, !item.checked);
    return null;
  } catch (e) {
    return `The card changed on the Workstation, so it has been read again — try once more. (${message(e)})`;
  }
}

/// Answers a decision, or passes or fails a test, and tells the card's
/// agent -- the Decisions tab's own write, confirm and message.
export function answerItem(
  workspaceId: string,
  path: string,
  item: HumanItem,
  outcome: HumanItemOutcome
): Promise<AnswerResult> {
  const binding = cardSessionFor(get(kanbanState)[workspaceId], path);
  return answerHumanItem(workspaceId, path, item, outcome, binding?.sessionId ?? null);
}

/// What archiving a card ends, from away: its live agents, stopped at the
/// Workstation. A tab showing the card is the desk's layout and stays the
/// desk's to close.
async function endAway(closing: ArchiveClosables): Promise<void> {
  for (const id of closing.sessionIds) await backend.killSession(id).catch(() => {});
}

/// Takes a card off the board, into its context's archive -- or back out.
/// Resolves with what to tell the human, or null -- or an empty string,
/// which is falsy, when they backed out of ending its agents.
export async function archiveCard(
  workspaceId: string,
  card: CardView,
  archived: boolean
): Promise<string | null> {
  return archived ? executeUnarchive(workspaceId, [card]) : executeArchive(workspaceId, [card], endAway);
}

// ---- Filing a card ---------------------------------------------------

export interface CardDraft {
  kind: ComposeKind;
  title: string;
  /// A task's prompt, a plan's body; a note may have one or not.
  body: string;
  /// The column it is filed into.
  status: string;
  contextFolder: string;
}

/// Files a new card, as the desk's composer files one: its arguments
/// built the composer's way, read as already reviewed -- the human typed
/// it a moment ago, and asking them to review their own words before its
/// first run is how the review becomes a reflex -- and placed at the end
/// of its column. Resolves with the new card's path, and with why it is
/// not at the end of its column where that write failed.
export async function fileCard(
  workspaceId: string,
  draft: CardDraft
): Promise<{ path: string; warning: string | null } | { error: string }> {
  const tree = get(gavinTrees)[workspaceId];
  const context = tree?.contexts.find((c) => c.folderPath === draft.contextFolder);
  if (!context) return { error: "That context is no longer in this workspace." };
  const args = buildCreatePlanArgs(
    { kind: draft.kind, title: draft.title, body: draft.body, status: draft.status },
    context.plans.map((p) => p.fileName)
  );
  if ("error" in args) return args;
  let path: string;
  try {
    path = await backend.createPlan(
      draft.contextFolder,
      args.fileName,
      args.title,
      args.status,
      undefined,
      args.body,
      args.kind,
      undefined,
      args.attachments,
      args.complexity
    );
  } catch (e) {
    return { error: `Couldn't file the card: ${message(e)}` };
  }
  const created: PlanFileInfo = {
    path,
    fileName: args.fileName,
    title: args.title,
    status: args.status,
    priority: null,
    order: null,
    kind: args.kind,
    parent: null,
    labels: [],
    attachments: [],
    complexity: null,
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
  };
  patchPlanCreated(workspaceId, draft.contextFolder, created);
  void stampCardReview(workspaceId, path, { title: args.title, body: args.body ?? "", attachments: [] });
  const board = get(kanbanState)[workspaceId];
  const merged = board ? mergePlanCards(board, get(gavinTrees)[workspaceId]) : null;
  const warning = await placeCardAtColumnEnd(workspaceId, path, args.status, merged);
  return { path, warning: warning ? `Filed, but not at the end of its column: ${warning}` : null };
}

// ---- Reading a file ------------------------------------------------------

/// A card's file, or the PRD, read now and again whenever the Workstation
/// says it changed -- an agent ticking an item, the human editing at the
/// desk. `land` hears null for a file that is not there.
///
/// Every read takes a ticket and only the newest lands: a push's read and
/// an action's re-read can answer out of order, and the older landing last
/// would put back a tick the file no longer has. A counter, never an
/// identity (`$state` proxies objects).
export function followFile(
  path: string,
  land: (content: string | null) => void
): { reread(): Promise<void>; stop(): void } {
  let ticket = 0;
  let stopped = false;
  let unlisten: UnlistenFn | null = null;
  const reread = async (): Promise<void> => {
    const mine = ++ticket;
    try {
      const file = await backend.readFileForViewer(path);
      if (mine === ticket && !stopped) land(file.exists ? file.content : null);
    } catch {
      if (mine === ticket && !stopped) land(null);
    }
  };
  void reread();
  void backend.watchFileForViewer(path).catch(() => {});
  void listen<string>("file-changed", (event) => {
    if (event.payload === path) void reread();
  }).then((stop) => (stopped ? stop() : (unlisten = stop)));
  return {
    reread,
    stop() {
      stopped = true;
      unlisten?.();
      void backend.unwatchFileForViewer(path).catch(() => {});
    },
  };
}
