// The bundle channel's message set (spec "The Companion shell", ADR 0005).
//
// A Workstation's UI runs in a webview with no native bridge, and this is
// its one outlet: a closed, versioned set of typed messages, carried by
// the shell to that bundle's own Workstation and to nothing else. CLOSED
// is the property the store review rests on -- a bundle is downloaded
// code, and downloaded code that could name an arbitrary native call
// would be extending the app (Guideline 4.7.2). So a new capability is a
// new entry HERE, which ships as a store release, and never something a
// bundle can reach for by itself.
//
// Both ends read with the functions below and neither ever throws on
// what it is handed: the other end may be a build older or newer than
// this one, and "a type I have not heard of" is an ordinary thing for it
// to say.

/// Bumped when a message changes shape in a way an older reader would
/// misread. Adding a type, or an optional field to one, is not that:
/// the capabilities answer names the types, and an unknown field is
/// dropped on the way in.
export const CHANNEL_VERSION = 1;

export const MESSAGE_TYPES = [
  "capabilities",
  "invoke",
  "result",
  "listen",
  "event",
  "unlisten",
  "open-external",
  "return-to-hub",
  "connection",
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

/// What a bundle asks for. Every one carries an `id` and is answered by
/// exactly one `result` with the same id -- `listen` included, because a
/// listener that is not registered yet loses the events sent meanwhile,
/// and the only way to know it IS registered is to be told.
export type BundleMessage =
  | { v: number; type: "capabilities"; id: number }
  | { v: number; type: "invoke"; id: number; cmd: string; args: Record<string, unknown> }
  | { v: number; type: "listen"; id: number; event: string }
  /// `listener` is the id of the `listen` being ended.
  | { v: number; type: "unlisten"; id: number; listener: number }
  | { v: number; type: "open-external"; id: number; url: string }
  | { v: number; type: "return-to-hub"; id: number };

export type BundleMessageType = BundleMessage["type"];

/// Why a request was not carried out, where the reason is one the bundle
/// can act on rather than only show.
///
/// `unsupported`: this end does not know the message type -- the answer
/// that lets a bundle newer than its shell carry on without the feature.
///
/// `unreachable`: the request never reached the Workstation's desktop app
/// -- no connection, a connection that dropped or went quiet, or a desktop
/// app that is not there to ask. Not the Workstation's refusal, so a
/// surface that showed it clears it once the connection is back.
export type ErrorCode = "unsupported" | "unreachable";

/// What a request that could not reach the Workstation is answered with,
/// by the shell and by the Demo Workstation playing a dropped connection.
export const NOT_REACHABLE = "The Workstation cannot be reached right now.";

/// Why the Workstation cannot be reached: the hub's words for it
/// (`hub/live.ts` in the shell).
export type ConnectionReason = "unreachable" | "asleep" | "desktop-app-not-running";

const CONNECTION_REASONS: readonly ConnectionReason[] = ["unreachable", "asleep", "desktop-app-not-running"];

/// Whether the Workstation can be reached now, as the shell sees it. A
/// bundle starts from `up`, and is told each change after that.
export type ConnectionState = { state: "up" } | { state: "down"; reason: ConnectionReason };

export type ResultMessage =
  | { v: number; type: "result"; id: number; ok: true; value: unknown }
  | { v: number; type: "result"; id: number; ok: false; error: string; code?: ErrorCode };

/// What reaches a bundle: the answer to something it asked, an event for
/// a listener it registered (`listener` is that `listen`'s id), or -- the
/// one message nobody asked for -- the connection to the Workstation
/// going down or coming back up. `connection` carries no id: an older
/// bundle drops it as a type it does not know, and keeps working as it
/// did.
export type WorkstationMessage =
  | ResultMessage
  | { v: number; type: "event"; listener: number; event: string; payload: unknown }
  | ({ v: number; type: "connection" } & ConnectionState);

/// Where a bundle should land once open: the target of the inbox item
/// the human tapped in the hub, and the workspace it belongs to. The
/// shape is the attention item's (`protocol::attention`).
export interface Landing {
  workspace: string;
  target: { kind: "session"; id: string } | { kind: "card"; path: string };
}

/// The answer to `capabilities`, as a `result`'s value.
export interface Capabilities {
  /// The channel version the other end speaks.
  version: number;
  /// The message types it carries. A bundle asks before it uses anything
  /// beyond the ones it cannot work without.
  messages: string[];
  /// Which Workstation this channel reaches -- the only one it reaches.
  workstation: { id: string; name: string; demo: boolean };
  /// Where to land, when the shell opened this bundle for an inbox item.
  /// Optional, and read only by a bundle that knows it: an older shell
  /// sends none, an older bundle ignores it.
  landing?: Landing;
}

/// A landing as the wire carried it, or null for one this build cannot
/// land on -- a target kind it has never heard of is not a place.
export function readLanding(value: unknown): Landing | null {
  if (!isRecord(value) || typeof value.workspace !== "string" || !value.workspace) return null;
  const target = value.target;
  if (!isRecord(target)) return null;
  if (target.kind === "session" && typeof target.id === "string" && target.id) {
    return { workspace: value.workspace, target: { kind: "session", id: target.id } };
  }
  if (target.kind === "card" && typeof target.path === "string" && target.path) {
    return { workspace: value.workspace, target: { kind: "card", path: target.path } };
  }
  return null;
}

/// What a bundle may assume of any shell that answers at all, including
/// one whose `capabilities` answer it could not read.
export const CORE_MESSAGES: readonly MessageType[] = [
  "capabilities",
  "invoke",
  "result",
  "listen",
  "event",
  "unlisten",
];

export type Inbound<T> =
  | { kind: "message"; message: T }
  /// A type this build does not know. `id` is what to answer, when the
  /// sender asked for an answer.
  | { kind: "unknown"; type: string; id: number | null }
  /// Not a message, or a known type missing what it needs.
  | { kind: "malformed"; id: number | null; reason: string };

export function encode(message: BundleMessage | WorkstationMessage): string {
  return JSON.stringify(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/// An id is a non-negative whole number and nothing else: it is echoed
/// back as the key a promise is waiting under, and `"3"` is not `3`.
function readId(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

interface Envelope {
  v: number;
  type: string;
  body: Record<string, unknown>;
}

function readEnvelope(raw: string): Envelope | { reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reason: "not JSON" };
  }
  if (!isRecord(parsed)) return { reason: "not an object" };
  if (typeof parsed.type !== "string") return { reason: "no type" };
  // A missing version reads as this build's own: the type is what says
  // how to read a message, and the version only ever explains a failure.
  const v = typeof parsed.v === "number" ? parsed.v : CHANNEL_VERSION;
  return { v, type: parsed.type, body: parsed };
}

function malformed<T>(id: number | null, reason: string): Inbound<T> {
  return { kind: "malformed", id, reason };
}

/// Read by the Workstation's end. Every message a bundle sends needs an
/// id, so a known type without one is malformed and answered by nobody.
export function readBundleMessage(raw: string): Inbound<BundleMessage> {
  const envelope = readEnvelope(raw);
  if ("reason" in envelope) return malformed(null, envelope.reason);
  const { v, type, body } = envelope;
  const id = readId(body.id);
  switch (type) {
    case "capabilities":
    case "return-to-hub":
      if (id === null) return malformed(null, `${type} without an id`);
      return { kind: "message", message: { v, type, id } };
    case "invoke":
      if (id === null) return malformed(null, "invoke without an id");
      if (typeof body.cmd !== "string" || body.cmd === "") return malformed(id, "invoke without a command");
      // Absent args are an empty call; anything else that is not an
      // object (an array, a string) is a call this end cannot name the
      // parameters of.
      if (body.args !== undefined && !isRecord(body.args)) return malformed(id, "invoke args are not an object");
      return { kind: "message", message: { v, type, id, cmd: body.cmd, args: body.args ?? {} } };
    case "listen":
      if (id === null) return malformed(null, "listen without an id");
      if (typeof body.event !== "string" || body.event === "") return malformed(id, "listen without an event");
      return { kind: "message", message: { v, type, id, event: body.event } };
    case "unlisten": {
      if (id === null) return malformed(null, "unlisten without an id");
      const listener = readId(body.listener);
      if (listener === null) return malformed(id, "unlisten without a listener");
      return { kind: "message", message: { v, type, id, listener } };
    }
    case "open-external":
      if (id === null) return malformed(null, "open-external without an id");
      if (typeof body.url !== "string" || body.url === "") return malformed(id, "open-external without a url");
      return { kind: "message", message: { v, type, id, url: body.url } };
    default:
      return { kind: "unknown", type, id };
  }
}

/// Read by the bundle's end.
export function readWorkstationMessage(raw: string): Inbound<WorkstationMessage> {
  const envelope = readEnvelope(raw);
  if ("reason" in envelope) return malformed(null, envelope.reason);
  const { v, type, body } = envelope;
  switch (type) {
    case "result": {
      const id = readId(body.id);
      if (id === null) return malformed(null, "result without an id");
      if (body.ok === true) {
        return { kind: "message", message: { v, type, id, ok: true, value: body.value ?? null } };
      }
      if (body.ok !== false) return malformed(id, "result without an outcome");
      // A rejection with nothing to say would surface as a blank error
      // strip; refusing it here means the waiting call hears "malformed"
      // and says so.
      if (typeof body.error !== "string" || body.error === "") return malformed(id, "failure without an error");
      const failure = { v, type, id, ok: false as const, error: body.error };
      return {
        kind: "message",
        message: body.code === "unsupported" || body.code === "unreachable" ? { ...failure, code: body.code } : failure,
      };
    }
    case "event": {
      const listener = readId(body.listener);
      if (listener === null) return malformed(null, "event without a listener");
      if (typeof body.event !== "string" || body.event === "") return malformed(null, "event without a name");
      return {
        kind: "message",
        message: { v, type, listener, event: body.event, payload: body.payload ?? null },
      };
    }
    case "connection": {
      if (body.state === "up") return { kind: "message", message: { v, type, state: "up" } };
      if (body.state !== "down") return malformed(null, "connection without a state");
      // A reason a newer shell has and this build does not is still a
      // connection that is down.
      const reason = CONNECTION_REASONS.find((r) => r === body.reason) ?? "unreachable";
      return { kind: "message", message: { v, type, state: "down", reason } };
    }
    default:
      return { kind: "unknown", type, id: readId(body.id) };
  }
}
