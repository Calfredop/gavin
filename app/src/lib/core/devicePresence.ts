// Where each Device is and what it is doing, as the desk reads it
// (companion-16).
//
// The daemon reads a Device's presence off the commands the Device has the
// desktop run, and pushes the whole of it on every change
// (`DevicePresenceChanged`, v63) -- the workspace it last named, the session
// it is typing into, the sessions it started. This module is every rule the
// desk applies to that: which of the started sessions to place as tabs and
// where, which terminal is being typed into now, and what the Devices panel
// and a tab say about it. `devicesState.ts` holds the stores and the
// listener; the panel and the tab strip are templates over both.
//
// Imports only pure modules: `layoutState.ts` reads this one.

import type { DeviceInfo, DevicePresence, DeviceStartedSession } from "$lib/core/remoteAccess";
import {
  addToAgentsPage,
  sameRoot,
  workspaceIdForSession,
  type Workspace,
  type WorkspacesData,
} from "$lib/core/workspace";

/// How long after a Device's last recorded keystroke its terminal still reads
/// as being typed into. The daemon pushes continued typing into one session
/// every `DEVICE_TYPING_REPUSH_SECS` (2 s) and stamps it in whole seconds, so
/// while the Device is still typing the stamp the desk last heard can be up to
/// three seconds old. Six keeps the marker up through that, and takes it down
/// within a few seconds of the Device stopping.
export const TYPING_FRESH_MS = 6000;

/// Every Device's presence, by device id.
export type Presences = Record<string, DevicePresence>;

/// The presences a `ListDevices` read carries: the read-back that a window
/// which reloaded, or opened after the pushes, starts from.
export function presencesFromList(devices: DeviceInfo[]): Presences {
  const out: Presences = {};
  for (const d of devices) if (d.presence) out[d.deviceId] = d.presence;
  return out;
}

/// The sessions in a pushed presence this window should place as tabs: the
/// ones it has not already handled, started since it began listening.
///
/// `sinceSeconds` is the other half, and it is what keeps a window that
/// reloads from placing sessions again. The presence keeps the Device's last
/// few starts, so the first push a fresh window hears lists sessions started
/// long before it existed -- whose tabs the human may have closed since. A
/// start older than the window is history, not news.
export function sessionsToPlace(
  presence: DevicePresence,
  handled: ReadonlySet<string>,
  sinceSeconds: number
): DeviceStartedSession[] {
  return presence.started.filter((s) => !handled.has(s.sessionId) && s.at >= sinceSeconds);
}

/// Which of the desk's workspaces a Device-started session belongs in: the
/// one whose root the Device named, else the one whose root its cwd is under
/// (the deepest, when roots nest). Null for a session under no workspace the
/// desk holds.
export function workspaceForStarted(
  workspaces: Pick<Workspace, "id" | "rootPath">[],
  started: Pick<DeviceStartedSession, "workspaceRoot" | "cwd">
): string | null {
  const rooted = workspaces.filter((w) => w.rootPath?.trim());
  const root = started.workspaceRoot;
  if (root) {
    const named = rooted.find((w) => sameRoot(w.rootPath!, root));
    if (named) return named.id;
  }
  const cwd = started.cwd;
  if (!cwd) return null;
  let best: { id: string; depth: number } | null = null;
  for (const w of rooted) {
    const r = w.rootPath!.replace(/[/\\]+$/, "");
    if (cwd === r || cwd.startsWith(`${r}/`) || cwd.startsWith(`${r}\\`)) {
      if (!best || r.length > best.depth) best = { id: w.id, depth: r.length };
    }
  }
  return best?.id ?? null;
}

/// A Device-started session placed as a tab: on its workspace's Agents page,
/// where a card run at the desk lands, so the human finds it where the card
/// lives. Null when there is nothing to do -- the workspace is not held here,
/// or the session is already showing somewhere (a second push, or a window
/// that placed it before a reload) -- and a null is never a kill: the session
/// is the Device's.
export function placeDeviceSession(
  data: WorkspacesData,
  workspaceId: string,
  sessionId: string,
  newPageId: string
): WorkspacesData | null {
  if (!data.workspaces.some((w) => w.id === workspaceId)) return null;
  if (workspaceIdForSession(data, sessionId) !== null) return null;
  return addToAgentsPage(data, workspaceId, sessionId, newPageId);
}

/// Which Device started each session, by name: what a tab is labelled with.
/// A later start of the same session id (never, in practice) wins.
export function deviceNameBySession(devices: DeviceInfo[], presences: Presences): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of devices) {
    for (const s of presences[d.deviceId]?.started ?? []) out[s.sessionId] = d.name;
  }
  return out;
}

/// Whether a Device's last keystroke is recent enough to read as typing now.
function typingNow(presence: DevicePresence | undefined, nowMs: number): boolean {
  const at = presence?.typing?.at;
  return typeof at === "number" && nowMs - at * 1000 < TYPING_FRESH_MS;
}

/// The Devices typing into each session right now, by name: the terminal
/// marker. Two Devices in one session is rare and still said.
export function typingBySession(
  devices: DeviceInfo[],
  presences: Presences,
  nowMs: number
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const d of devices) {
    const p = presences[d.deviceId];
    if (!p?.typing || !typingNow(p, nowMs)) continue;
    (out[p.typing.sessionId] ??= []).push(d.name);
  }
  return out;
}

/// When the freshest typing now showing stops being fresh, epoch ms -- the
/// moment the markers next change on their own -- or null when nobody is
/// typing. What the state's one timer waits for.
export function typingChangesAt(presences: Presences, nowMs: number): number | null {
  let latest: number | null = null;
  for (const p of Object.values(presences)) {
    if (!typingNow(p, nowMs)) continue;
    const ends = p.typing!.at * 1000 + TYPING_FRESH_MS;
    if (latest === null || ends > latest) latest = ends;
  }
  return latest;
}

/// The marker's words: "Cosimo's iPhone is typing".
export function typingText(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are typing`;
}

/// What the panel names a session and a workspace by. Passed in, because the
/// names live in stores this module does not read.
export interface PresenceNaming {
  workspaceName: (workspaceId: string) => string | null;
  sessionName: (sessionId: string) => string;
}

/// How many started sessions a row names before it says "+N".
const STARTED_NAMED = 2;

/// The Devices panel's presence line for one Device, or null for nothing to
/// say: "in gavin · typing into fix login · started docs, tests +1".
///
/// Where the Device is and what it is typing into are said only while it is
/// connected -- a Device that hung up is in no workspace, and the "seen 3m
/// ago" beside it already says when it was. What it started is said either
/// way: that is the account of what the phone did while the human was away.
export function presenceLine(
  presence: DevicePresence | undefined,
  connected: boolean,
  naming: PresenceNaming,
  nowMs: number
): string | null {
  if (!presence) return null;
  const parts: string[] = [];
  if (connected && presence.workspaceId) {
    const name = naming.workspaceName(presence.workspaceId);
    if (name) parts.push(`in ${name}`);
  }
  if (connected && presence.typing && typingNow(presence, nowMs)) {
    parts.push(`typing into ${naming.sessionName(presence.typing.sessionId)}`);
  }
  const started = [...presence.started].reverse();
  if (started.length > 0) {
    const named = started.slice(0, STARTED_NAMED).map((s) => naming.sessionName(s.sessionId));
    const more = started.length - named.length;
    parts.push(`started ${named.join(", ")}${more > 0 ? ` +${more}` : ""}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
