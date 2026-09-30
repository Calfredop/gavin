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
import {
  agentDefaultsStore,
  agentModelDefaultsStore,
  agentProfilesStore,
  armFailureDetection,
  customResumeArgsDefault,
  layoutState,
  profileIdForLaunch,
  resolvedAgentFor,
} from "$lib/core/layoutState";

export type SessionKind = "terminal" | "agent";

/// The sessions this Device started, and the workspace each is in.
const startedHereStore = writable<Record<string, string>>({});
export const startedHere: Readable<Record<string, string>> = { subscribe: startedHereStore.subscribe };

/// Whether the tables an agent is resolved from are in hand. An agent
/// resolved without them would be a guess at the desk's answer, so a new
/// agent waits for them; a terminal needs none.
export type LaunchTables = "unread" | "reading" | "ready";
const tablesStore = writable<LaunchTables>("unread");
export const launchTables: Readable<LaunchTables> = { subscribe: tablesStore.subscribe };

/// Reads the agent tables the desk's bootstrap reads, once per visit. A
/// failed read leaves them unread, so the next showing of the list tries
/// again.
export async function loadLaunchTables(): Promise<void> {
  if (get(tablesStore) !== "unread") return;
  tablesStore.set("reading");
  const [profiles, models, defaults, resumeArgs] = await Promise.all([
    backend.agentProfiles().catch(() => null),
    backend.getAgentModelDefaults().catch(() => null),
    backend.getAgentDefaults().catch(() => null),
    backend.getCustomResumeArgs().catch(() => null),
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
  tablesStore.set("ready");
}

/// Opens a session in a workspace: in its folder, or where a new
/// session opens when it has none. Resolves with the session's id.
export async function startSession(workspaceId: string, kind: SessionKind): Promise<string> {
  const ws = get(layoutState).workspaces.find((w) => w.id === workspaceId);
  if (!ws) throw new Error("this workspace is no longer on the Workstation");
  const root = ws.rootPath || undefined;
  let id: string;
  if (kind === "agent") {
    if (get(tablesStore) !== "ready") throw new Error("the Workstation's agent settings are still being read");
    const agent = resolvedAgentFor(workspaceId);
    id = await backend.createSession(root, agent.launchCommand, root, profileIdForLaunch(agent));
    void armFailureDetection(id, agent.failurePatterns);
  } else {
    id = await backend.createSession(root, undefined, root);
  }
  startedHereStore.update((started) => ({ ...started, [id]: workspaceId }));
  return id;
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
}

/// What this module knows belongs to one visit to one Workstation.
export function resetSessions(): void {
  startedHereStore.set({});
  tablesStore.set("unread");
}
