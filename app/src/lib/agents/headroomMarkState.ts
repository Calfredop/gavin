// What the Headroom exception mark is drawn from: per session, what the
// daemon decided about routing it through Headroom, and what Headroom was
// later found to have seen of it.
//
// Three writers, one per way the facts arrive:
//
// - `noteSessionCompression`, from the host's `session-compression`
//   event, which it sends for every session the app creates and every
//   one another agent spawns over MCP, before the tab paints.
// - `seedSessionCompression`, from the session baselines a frontend reads
//   when it loads or reloads -- the events above arrived once per app
//   process and a reload missed them.
// - `noteHeadroomReach`, from the driver that asks when a turn ends
//   (headroomReachDriver.ts).
//
// A leaf: it imports nothing of the app's state, so layoutState,
// orchestrationState and cardRunActions can all import it statically.
// The rules are in headroomMark.ts.

import { writable } from "svelte/store";
import {
  sessionCompressionFrom,
  withReach,
  type HeadroomReach,
  type SessionCompression,
} from "$lib/agents/headroomMark";

/// By session id. Entries are never removed on exit, like the other
/// per-session maps: one small record per session an app run has seen.
export const sessionCompressionById = writable<Record<string, SessionCompression>>({});

/// What the host said about a session it just created or relayed.
/// Always written: it is the newest word there is about that session.
export function noteSessionCompression(
  sessionId: string,
  raw: { compressed?: unknown; uncompressedReason?: unknown }
): void {
  sessionCompressionById.update((all) => ({ ...all, [sessionId]: sessionCompressionFrom(raw) }));
}

/// What the baselines say about sessions this frontend has not heard
/// about. Never over an entry that is already here: a push that landed
/// is newer than this snapshot, the rule every baseline follows.
export function seedSessionCompression(
  baselines: readonly {
    id: string;
    compressed?: unknown;
    uncompressedReason?: unknown;
    headroomReach?: unknown;
  }[]
): void {
  sessionCompressionById.update((all) => {
    const fresh = baselines.filter((b) => all[b.id] === undefined);
    if (fresh.length === 0) return all;
    const next = { ...all };
    for (const b of fresh) next[b.id] = sessionCompressionFrom(b);
    return next;
  });
}

/// An answer about a session's reach. `unknown` changes nothing that was
/// known (`withReach`).
export function noteHeadroomReach(sessionId: string, reach: HeadroomReach | "unknown"): void {
  sessionCompressionById.update((all) => {
    const next = withReach(all[sessionId], reach);
    return next === all[sessionId] || next === undefined ? all : { ...all, [sessionId]: next };
  });
}

/// Sessions that reopened a conversation (resume, review) and have not
/// been SUBMITTED to yet. Until then every quiet is the human at the
/// prompt -- the history being painted, then a pause mid-sentence -- and
/// none of it is a turn (`reachCheckDue`).
const reopened = new Set<string>();

/// Called by the launches that reopen a conversation rather than hand an
/// agent a prompt.
export function noteReopenedConversation(sessionId: string): void {
  reopened.add(sessionId);
}

/// Whether this reopened conversation is still waiting for its first
/// submitted line. A peek: only `noteInputSubmitted` ends it.
export function isAwaitingFirstSubmit(sessionId: string): boolean {
  return reopened.has(sessionId);
}

/// What the human typed or pasted into a session ended in Enter: the
/// model has been asked something, so the next quiet is a turn.
export function noteInputSubmitted(sessionId: string): void {
  reopened.delete(sessionId);
}

/// @internal - for testing only
export function __resetForTesting(): void {
  sessionCompressionById.set({});
  reopened.clear();
}
