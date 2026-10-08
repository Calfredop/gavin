// Opening and ending sessions from the phone (spec, stories 43 and 44).
//
// Both are the desk's own launches, made through the desk's own modules:
// a terminal is `addTab`'s fresh session, an agent is the workspace's
// agent as `resolvedAgentFor` resolves it for a new page -- the same
// command, the same profile, the same failure patterns armed. What a
// phone must NOT do is what those desk actions do next, which is place
// the session in the desk's layout and save it. The desk places a
// session a Device started itself (companion-16); until it does, the
// phone keeps its own list of what it started, for this visit.
import { get, writable, type Readable } from "svelte/store";
import * as backend from "$lib/core/backend";
import { normalizeRequireReview } from "$lib/cards/cardReview";
import {
  agentDefaultsStore,
  agentModelDefaultsStore,
  agentProfilesStore,
  armFailureDetection,
  customResumeArgsDefault,
  layoutState,
  profileIdForLaunch,
  requireReviewDefault,
  resolvedAgentFor,
} from "$lib/core/layoutState";

/// `workspace-agent` is the workspace's own agent, the one the desk's
/// Home tab holds: the same agent a New agent starts, in the folder, asked
/// of the desk as that agent rather than as one more tab.
export type SessionKind = "terminal" | "agent" | "workspace-agent";

/// The sessions this Device started, and the workspace each is in.
const startedHereStore = writable<Record<string, string>>({});
export const startedHere: Readable<Record<string, string>> = { subscribe: startedHereStore.subscribe };

/// When this Device started each of those, epoch ms: how long the desk
/// has had to place it (`sessionList.ts`'s `DESK_PLACES_WITHIN_MS`).
const startedAtStore = writable<Record<string, number>>({});
export const startedAt: Readable<Record<string, number>> = { subscribe: startedAtStore.subscribe };

/// The workspace agent this Device started in each workspace, by
/// workspace: the agent the list shows until the desk records it as the
/// workspace's own, so a second press cannot start a second one.
const agentStartedHereStore = writable<Record<string, string>>({});
export const agentStartedHere: Readable<Record<string, string>> = { subscribe: agentStartedHereStore.subscribe };

/// Whether the tables an agent is resolved from are in hand. An agent
/// resolved without them would be a guess at the desk's answer, so a new
/// agent waits for them; a terminal needs none.
export type LaunchTables = "unread" | "reading" | "ready";
const tablesStore = writable<LaunchTables>("unread");
export const launchTables: Readable<LaunchTables> = { subscribe: tablesStore.subscribe };

/// Reads the agent tables the desk's bootstrap reads, once per visit. A
/// failed read leaves them unread, so the next showing of the list tries
/// again. Two of the desk's launch settings ride along, because a phone
/// that guessed at either would launch where the desk would not: whether a
/// card's first run asks the human to read it first, and the agents'
/// pause window.
export async function loadLaunchTables(): Promise<void> {
  if (get(tablesStore) !== "unread") return;
  tablesStore.set("reading");
  const [profiles, models, defaults, resumeArgs, requireReview] = await Promise.all([
    backend.agentProfiles().catch(() => null),
    backend.getAgentModelDefaults().catch(() => null),
    backend.getAgentDefaults().catch(() => null),
    backend.getCustomResumeArgs().catch(() => null),
    backend.getRequireReview().catch(() => null),
  ]);
  if (!profiles || !models || !defaults) {
    tablesStore.set("unread");
    return;
  }
  agentProfilesStore.set(profiles);
  agentModelDefaultsStore.set(models);
  // Over the empty defaults, as the bootstrap lays them: a field the
  // Workstation's config does not have yet reads as "nobody chose".
  agentDefaultsStore.update((empty) => ({ ...empty, ...defaults }));
  customResumeArgsDefault.set(resumeArgs);
  requireReviewDefault.set(normalizeRequireReview(requireReview));
  tablesStore.set("ready");
}

/// Opens a session in a workspace: in its folder, or where a new
/// session opens when it has none. Resolves with the session's id.
///
/// Every start names the workspace, which is what the desk places it by:
/// a workspace with no folder has no root to name, and its terminal opens
/// in the home folder, which is under none.
export async function startSession(workspaceId: string, kind: SessionKind): Promise<string> {
  const ws = get(layoutState).workspaces.find((w) => w.id === workspaceId);
  if (!ws) throw new Error("this workspace is no longer on the Workstation");
  const root = ws.rootPath || undefined;
  let id: string;
  if (kind === "workspace-agent" && !root) throw new Error("the workspace's agent works in its folder, and this workspace has none");
  if (kind === "terminal") {
    id = await backend.createSession(root, undefined, root, undefined, false, workspaceId);
  } else {
    if (get(tablesStore) !== "ready") throw new Error("the Workstation's agent settings are still being read");
    const agent = resolvedAgentFor(workspaceId);
    id = await backend.createSession(
      root,
      agent.launchCommand,
      root,
      profileIdForLaunch(agent),
      kind === "workspace-agent",
      workspaceId
    );
    void armFailureDetection(id, agent.failurePatterns);
  }
  recordStarted(id, workspaceId);
  if (kind === "workspace-agent") agentStartedHereStore.update((started) => ({ ...started, [workspaceId]: id }));
  return id;
}

/// A session this Device started in a workspace, by whatever launched it:
/// a New agent or terminal, or a card's run.
export function recordStarted(sessionId: string, workspaceId: string): void {
  startedHereStore.update((started) => ({ ...started, [sessionId]: workspaceId }));
  startedAtStore.update((at) => ({ ...at, [sessionId]: Date.now() }));
}

/// Ends a session. What it ran stops at the Workstation; the desk closes
/// its tab and says so, and `session-exited` tells the phone.
export async function endSession(sessionId: string): Promise<void> {
  await backend.killSession(sessionId);
}

/// A session is gone: it is no longer one this Device started.
export function forgetSession(sessionId: string): void {
  startedHereStore.update((started) => {
    if (!(sessionId in started)) return started;
    const rest = { ...started };
    delete rest[sessionId];
    return rest;
  });
  startedAtStore.update((at) => {
    if (!(sessionId in at)) return at;
    const rest = { ...at };
    delete rest[sessionId];
    return rest;
  });
  agentStartedHereStore.update((started) => {
    const kept = Object.entries(started).filter(([, id]) => id !== sessionId);
    return kept.length === Object.keys(started).length ? started : Object.fromEntries(kept);
  });
}

/// What this module knows belongs to one visit to one Workstation.
export function resetSessions(): void {
  startedHereStore.set({});
  startedAtStore.set({});
  agentStartedHereStore.set({});
  tablesStore.set("unread");
}
