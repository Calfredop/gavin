// "Commit via agent" from the phone.
//
// The phone asks and the desk runs it: the window that runs the workspace
// starts its own hidden commit agent, writes it down and watches it to a
// verdict, exactly as its own button does (`$lib/companion/deviceCommit`).
// So the run the phone draws is the desk's record of it
// (`gitView.agentCommit`, which arrives with the workspaces), put into the
// phone's own Git view through the desk's `showAgentCommit` -- and the
// desk's phase, elapsed time and blocker then read it as they read a run
// of the desk's own, and the commit box holds while the agent commits.
//
// What this module keeps is only what the phone asked that the record
// does not say yet: a press waiting for the desk's answer, and a Stop.
import { get, writable } from "svelte/store";
import * as backend from "$lib/core/backend";
import { layoutState } from "$lib/core/layoutState";
import type { AgentConfig } from "$lib/core/gavin";
import { resolveAgentConfig, type AgentProfileInfo } from "$lib/core/settings";
import type { Workspace } from "$lib/core/workspace";
import { concludeShownAgentCommit, gitStore, noteError, showAgentCommit, type GitViewState } from "$lib/git/gitState";
import type { LaunchTables } from "$companion/state/sessions";
import { readWorkspacesAgain } from "$companion/state/workstation";

type Run = NonNullable<GitViewState["agentCommit"]>;

interface Asked {
  /// When a press of this phone's went out, while the desk has not
  /// answered it: drawn as the desk draws the gap between its own click
  /// and the session.
  starting: number | null;
  /// The run this phone asked to stop.
  stopping: string | null;
}

const NOTHING_ASKED: Asked = { starting: null, stopping: null };

const askedStore = writable<Record<string, Asked>>({});

function ask(workspaceId: string, patch: Partial<Asked>): void {
  askedStore.update((all) => ({ ...all, [workspaceId]: { ...(all[workspaceId] ?? NOTHING_ASKED), ...patch } }));
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/// The run the desk has written down for a workspace's root checkout: the
/// only checkout the phone's Git surface reads. One in a worktree the
/// desk's tab is on is the desk's alone.
export function recordedRun(ws: Workspace | undefined): { sessionId: string; startedAt: number | null } | null {
  const record = ws?.gitView?.agentCommit;
  if (!record || !ws?.rootPath || record.cwd !== ws.rootPath) return null;
  return { sessionId: record.sessionId, startedAt: record.startedAt ?? null };
}

/// What the phone's Git view shows: the desk's run with this phone's Stop
/// on it, else a press of this phone's still waiting for its answer.
export function shownRun(
  recorded: { sessionId: string; startedAt: number | null } | null,
  asked: Asked | undefined
): Run | null {
  if (recorded) return { ...recorded, stopping: asked?.stopping === recorded.sessionId };
  if (asked?.starting != null) return { sessionId: null, startedAt: asked.starting, stopping: false };
  return null;
}

/// The headless arguments of the agent a workspace's commit runs,
/// resolved as the desk's Git toolbar resolves them -- or null until the
/// Workstation's agent settings are in hand, because "not read yet" is not
/// "no headless mode". Handed the stores' values by the component that
/// draws the button: a store derived here would be built at import.
export function commitAgentArgs(
  tables: LaunchTables,
  trusted: AgentConfig | null,
  profiles: AgentProfileInfo[],
  models: Record<string, string>,
  defaultAgent: string | undefined
): string | null {
  if (tables !== "ready") return null;
  return resolveAgentConfig(trusted, profiles, models, undefined, undefined, undefined, defaultAgent).headlessArgs;
}

/// Asks the desk to commit the workspace's root checkout. The run is then
/// the desk's, and arrives as its record; a refusal goes in the Git view's
/// banner in the desk's words.
export async function askDeskToCommit(workspaceId: string): Promise<void> {
  const ws = get(layoutState).workspaces.find((w) => w.id === workspaceId);
  if (!ws?.rootPath) return;
  ask(workspaceId, { starting: Date.now() });
  try {
    await backend.agentCommitForDevice(workspaceId, { action: "start", cwd: ws.rootPath });
    // The desk wrote its record before it answered, but the record and
    // the answer travel apart: read the workspaces again, so the run is in
    // hand before the press stops standing in for it.
    await readWorkspacesAgain();
  } catch (e) {
    noteError(workspaceId, message(e));
  } finally {
    ask(workspaceId, { starting: null });
  }
}

/// Asks the desk to stop the run the phone shows. Through the desk's own
/// Stop: the window watching the run then reads its exit as the human's
/// doing, where a bare kill from here would read as a failure.
export async function askDeskToStop(workspaceId: string): Promise<void> {
  const run = get(gitStore)[workspaceId]?.agentCommit;
  if (!run?.sessionId || run.stopping) return;
  ask(workspaceId, { stopping: run.sessionId });
  try {
    await backend.agentCommitForDevice(workspaceId, { action: "stop", sessionId: run.sessionId });
  } catch (e) {
    ask(workspaceId, { stopping: null });
    noteError(workspaceId, message(e));
  }
}

/// Draws the desk's run in the workspace's Git view for as long as the
/// Git surface is up, and tells its end: when the record goes, the tree
/// it left is read and judged. A record that names another session -- the
/// desk's automatic retry, or a run started at the desk -- is simply the
/// next run to draw.
export function followAgentCommit(workspaceId: string): () => void {
  let drawn: string | null = null;
  const apply = (): void => {
    const ws = get(layoutState).workspaces.find((w) => w.id === workspaceId);
    const asked = get(askedStore)[workspaceId];
    const run = shownRun(recordedRun(ws), asked);
    const now = run?.sessionId ?? null;
    const ended = drawn;
    drawn = now;
    // A Stop left on a run that has ended marks nothing: `shownRun` only
    // reads it against the run it names.
    if (ended && now === null) {
      void concludeShownAgentCommit(workspaceId, asked?.stopping === ended);
      return;
    }
    showAgentCommit(workspaceId, run);
  };
  // The Git view too: one made after this started -- the surface's first
  // read -- starts with no run, and has to be shown the desk's.
  const stops = [layoutState.subscribe(apply), askedStore.subscribe(apply), gitStore.subscribe(apply)];
  return () => {
    for (const stop of stops) stop();
  };
}

/// What this module knows belongs to one visit to one Workstation.
export function resetAgentCommits(): void {
  askedStore.set({});
}
