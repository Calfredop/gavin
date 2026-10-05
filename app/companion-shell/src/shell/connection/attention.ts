// The attention request: the one deliberately stable API between the
// shell and a Workstation (ADR 0005; `protocol::attention`).
//
// The shell asks `GetAttention` with the API version it reads; the
// Workstation answers with its state and what is waiting on the human.
// The answer only ever grows by optional fields, so this reads what it
// knows and passes over what it does not: an unknown field is ignored, an
// item of a kind this build has not heard of is kept under `other`, and a
// target it cannot land on is dropped from the item, which still opens its
// Workstation.
import type { Connection } from "$shell/connection/connection";

/// `protocol::ATTENTION_API_VERSION`: what this shell reads.
export const ATTENTION_API_VERSION = 1;

export type AttentionKind = "waiting" | "human-test" | "failed" | "interrupted" | "rail-stopped" | "other";

export type AttentionTarget = { kind: "session"; id: string } | { kind: "card"; path: string };

export interface AttentionItem {
  id: string;
  /// The workspace's id on its Workstation.
  workspace: string;
  kind: AttentionKind;
  text: string;
  /// Where tapping it lands, once the Workstation's UI can be opened
  /// there (companion-23); null when this build cannot read it.
  target: AttentionTarget | null;
}

export type AttentionAnswer =
  | { state: "ready"; items: AttentionItem[] }
  /// The Workstation is up, and its desktop app is not: nothing answers
  /// there for the waiting items (ADR 0003).
  | { state: "desktop-app-not-running" };

const KINDS = new Set<AttentionKind>(["waiting", "human-test", "failed", "interrupted", "rail-stopped"]);

/// How long a Workstation has to answer. It asks its desktop app, which
/// answers from what it already holds.
export const ATTENTION_TIMEOUT_MS = 10_000;

export class AttentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttentionError";
  }
}

/// Asks, and reads the answer. Rejects with `AttentionError` for an
/// answer this build cannot read, and with the connection's own error
/// when it fails or times out.
export async function askAttention(connection: Connection, timeoutMs = ATTENTION_TIMEOUT_MS): Promise<AttentionAnswer> {
  const reply = await connection.request(
    { type: "GetAttention", version: ATTENTION_API_VERSION },
    (r) => isObject(r) && (r.type === "Attention" || r.type === "Error" || r.type === "Unsupported"),
    timeoutMs
  );
  return readAttention(reply);
}

export function readAttention(reply: unknown): AttentionAnswer {
  if (!isObject(reply)) throw new AttentionError("The Workstation's answer is not one this Companion reads.");
  if (reply.type === "Unsupported") {
    throw new AttentionError("The Workstation's Gavin is too old to tell this phone what is waiting. Update Gavin at the desk.");
  }
  if (reply.type === "Error") {
    throw new AttentionError(
      `The Workstation did not answer what is waiting${typeof reply.message === "string" ? `: ${reply.message}` : ""}. Its Gavin may be older than this Companion.`
    );
  }
  if (reply.type !== "Attention") throw new AttentionError("The Workstation's answer is not one this Companion reads.");
  if (reply.state === "desktop-app-not-running") return { state: "desktop-app-not-running" };
  if (reply.state !== "ready") {
    throw new AttentionError("The Workstation reports a state this Companion does not know. Update the Companion.");
  }
  const items = Array.isArray(reply.items) ? reply.items : [];
  return { state: "ready", items: items.map(readItem).filter((item): item is AttentionItem => item !== null) };
}

function readItem(value: unknown): AttentionItem | null {
  if (!isObject(value)) return null;
  const { id, workspace, kind, text, target } = value;
  if (typeof id !== "string" || !id || typeof text !== "string" || typeof workspace !== "string") return null;
  return {
    id,
    workspace,
    kind: typeof kind === "string" && KINDS.has(kind as AttentionKind) ? (kind as AttentionKind) : "other",
    text,
    target: readTarget(target),
  };
}

function readTarget(value: unknown): AttentionTarget | null {
  if (!isObject(value)) return null;
  if (value.kind === "session" && typeof value.id === "string" && value.id) return { kind: "session", id: value.id };
  if (value.kind === "card" && typeof value.path === "string" && value.path) return { kind: "card", path: value.path };
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
