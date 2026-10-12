// Decrypt contract the shell's native handlers implement.
//
// Ciphertext on the wire is `nonce (12) || chacha20poly1305(plaintext)`.
// Plaintext is: version u8=1, counter u64 BE, issued_at u64 BE, JSON,
// PKCS#7-padded to a 256-byte bucket (a whole bucket of padding is written
// as 0). JSON matches NotifyPlaintext in crates/daemon/src/notify_crypto.rs.
//
// Native code owns the actual open: on iOS the Notification Service
// Extension (ios/App/NotificationService/NotifyOpen.swift), held to the
// daemon's seal by test-fixtures/companion-notify; on Android, an FCM
// handler not yet written. This module is the shape for the TypeScript
// side, and the link a tap lands on, read back by the hub.

export const NOTIFY_GENERIC_BODY = "Something on your Workstation changed.";

export const NOTIFY_KEY_LEN = 32;
export const NOTIFY_NONCE_LEN = 12;
export const NOTIFY_PAD_BUCKET = 256;
export const NOTIFY_PAYLOAD_VERSION = 1;

export type OpenedNotifyOp = "notify" | "resolve";

export interface OpenedNotifyBody {
  op: OpenedNotifyOp;
  id: string;
  kind?: string;
  text?: string;
  workspace_id?: string;
  target?:
    | { type: "session"; session_id: string }
    | { type: "card"; path: string };
}

/// Where a tap on a notification lands, as the extension writes it into the
/// delivered notification (`notifyLink` in
/// ios/App/NotificationService/NotifyOpen.swift, held to this by
/// test-fixtures/companion-notify): the item's session or card on its
/// Workstation, with the workspace it belongs to. A resolve, or a push
/// nothing opened, lands on the hub.
export function deepLinkFor(
  body: OpenedNotifyBody | null,
  workstationId: string | null,
): string {
  if (!body || !workstationId) return HUB_LINK;
  if (body.op === "resolve") return HUB_LINK;
  let link = `gavin://ws/${workstationId}`;
  const query: string[] = [];
  const target = body.target;
  if (target?.type === "session") link += `/session/${encodeURIComponent(target.session_id)}`;
  if (target?.type === "card") {
    link += "/card";
    query.push(`path=${encodeURIComponent(target.path)}`);
  }
  if (body.workspace_id !== undefined) query.push(`workspace=${encodeURIComponent(body.workspace_id)}`);
  return query.length ? `${link}?${query.join("&")}` : link;
}

export const HUB_LINK = "gavin://hub";

/// A tapped notification, read back from its link: the Workstation to
/// open, and where in it to land -- null when the link names no workspace
/// or no target, which opens the Workstation where it opens. Null for the
/// hub's link, and for one this build cannot read.
export interface NotifyLanding {
  workstationId: string;
  landing: {
    workspace: string;
    target: { kind: "session"; id: string } | { kind: "card"; path: string };
  } | null;
}

const LINK = /^gavin:\/\/ws\/([^/?#]+)(?:\/session\/([^/?#]+)|\/(card))?(?:\?([^#]*))?$/;

export function readNotifyLink(link: string): NotifyLanding | null {
  const m = LINK.exec(link);
  if (!m) return null;
  try {
    const query = new Map<string, string>();
    for (const pair of (m[4] ?? "").split("&")) {
      const at = pair.indexOf("=");
      if (at > 0) query.set(pair.slice(0, at), decodeURIComponent(pair.slice(at + 1)));
    }
    const workspace = query.get("workspace");
    const path = query.get("path");
    const target = m[2] !== undefined
      ? { kind: "session" as const, id: decodeURIComponent(m[2]) }
      : m[3] && path !== undefined
        ? { kind: "card" as const, path }
        : null;
    return {
      workstationId: decodeURIComponent(m[1]),
      landing: workspace !== undefined && target ? { workspace, target } : null,
    };
  } catch {
    // A malformed escape: the link is not one the extension wrote.
    return null;
  }
}
