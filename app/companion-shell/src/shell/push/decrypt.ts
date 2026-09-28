// Decrypt contract the shell's native handlers implement.
//
// Ciphertext on the wire is `nonce (12) || chacha20poly1305(plaintext)`.
// Plaintext is: version u8=1, counter u64 BE, issued_at u64 BE, JSON,
// PKCS#7-padded to a 256-byte bucket. JSON matches NotifyPlaintext in
// crates/daemon/src/notify_crypto.rs.
//
// Native code (iOS Notification Service Extension, Android FCM handler)
// owns the actual open; this module documents the shape for the TypeScript
// side and for unit tests that round-trip against a fixture.

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

/** Deep-link path after a successful decrypt, or the hub on failure. */
export function deepLinkFor(
  body: OpenedNotifyBody | null,
  workstationId: string | null,
): string {
  if (!body || !workstationId) return "gavin://hub";
  if (body.op === "resolve") return "gavin://hub";
  const target = body.target;
  if (!target) return `gavin://ws/${workstationId}`;
  if (target.type === "session") {
    return `gavin://ws/${workstationId}/session/${target.session_id}`;
  }
  return `gavin://ws/${workstationId}/card?path=${encodeURIComponent(target.path)}`;
}
