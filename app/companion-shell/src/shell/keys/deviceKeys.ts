// The Device's keys, as the shell decides over them (ADR 0001, ADR 0004).
//
// The keys are native (`$shell/native/deviceKeys`). What is decided here:
//
// - **Whether this phone can be a Device.** Pairing is refused without a
//   passcode and without a hardware keystore (spec, "Pairing and trust"
//   story 4): every Device carries the same guarantees. The native side
//   refuses to create the keys on such a phone too; this is the answer
//   the hub can give before anyone tries.
// - **Whether a signature is the hardware key's over a handshake.** The
//   daemon is what verifies it for real (`unlock::verify` on the wire);
//   the keys check runs the same check here to prove the plugin end to
//   end, with the same message, key and signature formats.
import type { DevicePublicKeys, DeviceKeysStatus, KeysErrorCode } from "$shell/native/deviceKeys";

/// A Noise handshake hash: BLAKE2s, so 32 bytes, in both the pairing
/// and the connection handshake.
export const HANDSHAKE_HASH_BYTES = 32;

/// The uncompressed SEC1 point of a P-256 key: `04 || X || Y`.
export const HARDWARE_KEY_BYTES = 65;

export const NOISE_KEY_BYTES = 32;

/// What the hardware key signs, ahead of the handshake hash
/// (`device_wire::unlock_message`). Both native plugins carry the same
/// bytes; a test holds all three to it.
export const UNLOCK_CONTEXT = "gavin-device-unlock-v1";

export type Refusal = Extract<KeysErrorCode, "no-passcode" | "no-hardware-keystore">;

export type Readiness = { ready: true } | { ready: false; refusal: Refusal };

/// Whether this phone can hold a Device's keys. The passcode comes first:
/// it is the one the owner can fix.
export function readiness(status: DeviceKeysStatus): Readiness {
  if (!status.passcodeSet) return { ready: false, refusal: "no-passcode" };
  if (!status.hardwareKeystore && !status.softwareFallback) {
    return { ready: false, refusal: "no-hardware-keystore" };
  }
  return { ready: true };
}

/// What the hub says when it refuses.
export function refusalText(refusal: Refusal): string {
  switch (refusal) {
    case "no-passcode":
      return (
        "This phone has no passcode, so it cannot be a Device. A Device’s key signs only after you " +
        "unlock with your face, a fingerprint or the passcode: set a passcode, then pair."
      );
    case "no-hardware-keystore":
      return (
        "This phone has no hardware keystore, so it cannot be a Device. A Device’s key must be one " +
        "that cannot be copied off the phone."
      );
  }
}

const CODES: ReadonlySet<string> = new Set<KeysErrorCode>([
  "no-passcode",
  "no-hardware-keystore",
  "keys-exist",
  "no-keys",
  "cancelled",
  "bad-hash",
  "locked",
  "unlock-expired",
  "background",
  "failed",
]);

/// The code a plugin call was refused with. Capacitor puts it on the
/// rejection's `code`; anything unrecognised is `failed`.
export function errorCode(error: unknown): KeysErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && CODES.has(code) ? (code as KeysErrorCode) : "failed";
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/// Hex to bytes, or null when it is not an even run of hex digits.
export function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/// `UNLOCK_CONTEXT || handshakeHash`: the bytes the hardware key signs.
export function unlockMessage(handshakeHash: Uint8Array): Uint8Array {
  const context = new TextEncoder().encode(UNLOCK_CONTEXT);
  const out = new Uint8Array(context.length + handshakeHash.length);
  out.set(context);
  out.set(handshakeHash, context.length);
  return out;
}

/// Whether `key` has the shape of a hardware public key.
export function isHardwareKey(key: Uint8Array): boolean {
  return key.length === HARDWARE_KEY_BYTES && key[0] === 0x04;
}

/// An ASN.1 DER ECDSA signature -- `SEQUENCE { INTEGER r, INTEGER s }`,
/// what both platforms produce and the daemon reads -- as WebCrypto's
/// fixed-width `r || s`. Null when it is not one.
export function derToP1363(der: Uint8Array, width = 32): Uint8Array | null {
  let at = 0;
  const length = (): number | null => {
    const first = der[at++];
    if (first === undefined) return null;
    if (first < 0x80) return first;
    if (first !== 0x81) return null; // a P-256 signature is never longer than 255 bytes
    const second = der[at++];
    return second === undefined || second < 0x80 ? null : second;
  };
  const integer = (): Uint8Array | null => {
    if (der[at++] !== 0x02) return null;
    const n = length();
    if (n === null || n === 0 || at + n > der.length) return null;
    let bytes = der.subarray(at, at + n);
    at += n;
    if (bytes[0] & 0x80) return null; // negative: not a signature component
    while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1);
    if (bytes.length > width) return null;
    const fixed = new Uint8Array(width);
    fixed.set(bytes, width - bytes.length);
    return fixed;
  };
  if (der[at++] !== 0x30) return null;
  const total = length();
  if (total === null || at + total !== der.length) return null;
  const r = integer();
  const s = integer();
  if (!r || !s || at !== der.length) return null;
  const out = new Uint8Array(width * 2);
  out.set(r);
  out.set(s, width);
  return out;
}

/// Whether `signature` (DER, hex) is `hardwareKey`'s over the unlock
/// message for `handshakeHash` -- the daemon's check, in WebCrypto.
export async function verifyHandshakeSignature(options: {
  hardwareKey: string;
  handshakeHash: string;
  signature: string;
}): Promise<boolean> {
  const key = fromHex(options.hardwareKey);
  const hash = fromHex(options.handshakeHash);
  const der = fromHex(options.signature);
  const signature = der && derToP1363(der);
  if (!key || !isHardwareKey(key) || !hash || !signature) return false;
  try {
    const publicKey = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signature,
      unlockMessage(hash)
    );
  } catch {
    return false;
  }
}

/// Whether what `createKeys` or `publicKeys` answered is well formed.
export function publicKeysProblem(keys: DevicePublicKeys): string | null {
  const key = fromHex(keys.hardwareKey);
  if (!key || !isHardwareKey(key)) {
    return `the hardware key is not an uncompressed P-256 point (${keys.hardwareKey.length / 2} bytes)`;
  }
  return null;
}
