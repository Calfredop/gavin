// Which Device a session takes input from, as a window reads it (v68,
// `docs/superpowers/specs/2026-10-09-session-ownership.md`).
//
// A session has at most one Owner: a Device, or the desk when nobody is
// named. Everyone else sees it Locked -- they can read and scroll it, and
// the daemon refuses their input -- until they Take over (Take back, at the
// desk). The daemon keeps the records and pushes each change whole
// (`session-owner-changed`); this module is every rule a window applies to
// them: whether a session is locked for whoever is looking, what the lock
// says, what a refusal means, and who a session can be handed to. The same
// rules serve the desk (viewer `null`) and a Device (viewer its own id), so
// the desk's lock and the phone's say the same thing.
// `sessionOwnershipState.ts` holds the stores and the listener.

/// Mirrors `protocol::session_owner`.
export const OWNER_REFUSED_PREFIX = "gavin-daemon: session owner refused: ";
export const OWNER_GRACE_SECS = 30;
export const OWNER_BUSY_SECS = 5;

export interface SessionOwner {
  deviceId: string;
  name: string;
  /// Epoch seconds, as every time here.
  since: number;
  typedAt?: number | null;
  /// Set while the Device has no connection; the session goes back to the
  /// desk at `releasesAt` unless it reconnects.
  awaySince?: number | null;
  releasesAt?: number | null;
}

export type OwnerChange =
  | "claimed"
  | "started"
  | "tookOver"
  | "handedOver"
  | "released"
  | "revoked"
  | "lapsed"
  | "ended"
  | "other";

export interface SessionOwnership {
  sessionId: string;
  /// Absent: the desk's.
  owner?: SessionOwner | null;
  changedBy?: string | null;
  reason: OwnerChange;
  at: number;
}

export interface LiveDevice {
  deviceId: string;
  name: string;
}

/// `list_session_owners`'s answer.
export interface SessionOwnersList {
  owners: SessionOwnership[];
  devices: LiveDevice[];
  /// The asking Device; absent at the desk.
  you?: string | null;
}

export type OwnerRefusal =
  | { kind: "owned"; sessionId: string; owner: SessionOwner }
  | { kind: "busy"; sessionId: string; owner?: SessionOwner | null; typedAt: number }
  | { kind: "changed"; sessionId: string; owner?: SessionOwner | null }
  | { kind: "notConnected"; sessionId: string; deviceId: string };

/// Who owns what: only the sessions a Device owns, by session id.
export type Owners = Record<string, SessionOwner>;

/// Who is looking. `null` is the desk; a string is that Device. `undefined`
/// is a Device that has not yet learned its own id, which locks nothing:
/// better a lock missed for a moment than the Device locked out of its own
/// session.
export type Viewer = string | null | undefined;

export function ownersFromList(owners: SessionOwnership[]): Owners {
  let out: Owners = {};
  for (const o of owners) out = withOwnership(out, o);
  return out;
}

/// A pushed change applied: each carries the whole of one session's
/// ownership, so the latest one is the truth.
export function withOwnership(owners: Owners, ownership: SessionOwnership): Owners {
  const { [ownership.sessionId]: _was, ...rest } = owners;
  return ownership.owner ? { ...rest, [ownership.sessionId]: ownership.owner } : rest;
}

/// The owner refusal an error carries, or null for any other error. The
/// daemon's message may arrive with words in front of it (a Tauri command's,
/// the shell's), so the prefix is searched for, not anchored.
export function ownerRefusalFrom(error: unknown): OwnerRefusal | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : null;
  if (message === null) return null;
  const at = message.indexOf(OWNER_REFUSED_PREFIX);
  if (at < 0) return null;
  try {
    const parsed = JSON.parse(message.slice(at + OWNER_REFUSED_PREFIX.length));
    return parsed && typeof parsed.kind === "string" ? (parsed as OwnerRefusal) : null;
  } catch {
    return null;
  }
}

/// The owner `viewer` is locked out by, or null when `viewer` may type: the
/// session is nobody's (the desk's, which locks nobody), or it is the
/// viewer's own.
export function lockFor(owners: Owners, sessionId: string, viewer: Viewer): SessionOwner | null {
  if (viewer === undefined) return null;
  const owner = owners[sessionId];
  if (!owner || owner.deviceId === viewer) return null;
  return owner;
}

/// Whether `viewer` owns the session itself (a Device; the desk never
/// "owns" one, it holds what nobody owns).
export function ownsSession(owners: Owners, sessionId: string, viewer: Viewer): boolean {
  return typeof viewer === "string" && owners[sessionId]?.deviceId === viewer;
}

/// "12s ago", "3m ago", "2h ago" -- or "just now" inside five seconds.
export function agoText(seconds: number): string {
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

/// The lock's heading: "iPhone is working on this".
export function lockTitle(owner: SessionOwner): string {
  return `${owner.name} is working on this`;
}

/// The lock's second line: when the owner last typed, or that it is away
/// and when the session comes back to the desk.
export function lockDetail(owner: SessionOwner, nowMs: number): string {
  const now = nowMs / 1000;
  if (owner.releasesAt != null) {
    const left = Math.max(0, Math.ceil(owner.releasesAt - now));
    return left > 0 ? `Not connected · back to the desk in ${left}s` : "Not connected · back to the desk now";
  }
  if (owner.typedAt != null) return `Typed ${agoText(now - owner.typedAt)}`;
  return `Took it ${agoText(now - owner.since)}`;
}

/// What the lock's button says: the desk takes a session BACK, a Device
/// takes it over.
export function takeLabel(viewer: Viewer): string {
  return viewer === null ? "Take back" : "Take over";
}

/// Whether the holder typed within `OWNER_BUSY_SECS`, by the clock here --
/// what a lock bar can say before anyone presses. The daemon decides for
/// real (`busy`).
export function ownerTypingNow(owner: SessionOwner, nowMs: number): boolean {
  return owner.typedAt != null && nowMs / 1000 - owner.typedAt < OWNER_BUSY_SECS;
}

/// The confirm a busy refusal asks before taking: "iPhone is typing right
/// now" -- or the desk, for a session nobody owns.
export function busyQuestion(refusal: Extract<OwnerRefusal, { kind: "busy" }>): string {
  return `${refusal.owner?.name ?? "The desk"} is typing right now. Take over anyway?`;
}

/// What a refused write or change says, for the line under a compose field
/// or a lock bar, to `viewer` -- whose button is "Take back" at the desk.
export function refusalText(refusal: OwnerRefusal, viewer?: Viewer): string {
  switch (refusal.kind) {
    case "owned":
      return `${refusal.owner.name} is working on this session. ${takeLabel(viewer)} to type here.`;
    case "busy":
      return `${refusal.owner?.name ?? "The desk"} is typing in this session right now.`;
    case "changed":
      return refusal.owner
        ? `${refusal.owner.name} took this session first.`
        : "This session went back to the desk first.";
    case "notConnected":
      return "That Device is no longer connected, so it cannot take this session.";
  }
}

/// Who `viewer` can hand `sessionId` to: every other live Device, and the
/// desk unless the session is already the desk's. `null` stands for the
/// desk in the list.
export function handOverTargets(
  devices: LiveDevice[],
  owners: Owners,
  sessionId: string,
  viewer: Viewer
): (LiveDevice | null)[] {
  const owner = owners[sessionId]?.deviceId ?? null;
  const others = devices.filter((d) => d.deviceId !== viewer && d.deviceId !== owner);
  return owner === null ? others : [...others, null];
}

/// How many sessions each Device owns: the Devices panel's "owns 2".
export function ownedCountByDevice(owners: Owners): Record<string, number> {
  const out: Record<string, number> = {};
  for (const owner of Object.values(owners)) out[owner.deviceId] = (out[owner.deviceId] ?? 0) + 1;
  return out;
}

/// "owns 1 session" / "owns 3 sessions", or null for none.
export function ownsText(count: number | undefined): string | null {
  if (!count) return null;
  return `owns ${count} session${count === 1 ? "" : "s"}`;
}

/// When a lock's second line next changes on its own, epoch ms, or null
/// when no session is owned: the moment the shared clock should tick. Once
/// a second while any owner is away (the countdown), otherwise when the
/// "ago" text could next change.
export function ownersChangeAt(owners: Owners, nowMs: number): number | null {
  const all = Object.values(owners);
  if (all.length === 0) return null;
  if (all.some((o) => o.releasesAt != null)) return nowMs + 1000;
  return nowMs + 5000;
}
