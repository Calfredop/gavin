// The keys panel (debug builds only): the Device's keys by hand, on a real
// phone, for the human test -- create them, sign a test handshake (which
// prompts), delete them. Pairing creates and uses the keys for real
// (companion-21); until then this is the only way to reach them.
import type { DeviceKeysPlugin, DeviceKeysStatus } from "$shell/native/deviceKeys";
import { HANDSHAKE_HASH_BYTES, errorCode, readiness, refusalText, toHex, verifyHandshakeSignature } from "./deviceKeys";

export interface PanelLine {
  tone: "ok" | "problem" | "muted";
  text: string;
}

export type PanelAction = "create" | "sign" | "delete";

export const PANEL_REASON = "Sign a test handshake";

const BACKING_WORDS: Record<string, string> = {
  "secure-enclave": "in the Secure Enclave",
  strongbox: "in StrongBox",
  tee: "in the TEE",
  "software-debug": "in software, marked software-debug (a debug build on a Simulator or emulator)",
};

/// What the panel says about the phone before anything is done.
export function statusLines(status: DeviceKeysStatus): PanelLine[] {
  const ready = readiness(status);
  const lines: PanelLine[] = [];
  if (!ready.ready) {
    lines.push({ tone: "problem", text: refusalText(ready.refusal) });
  } else if (status.keys) {
    lines.push({ tone: "ok", text: `This phone holds a Device’s keys, the hardware key ${BACKING_WORDS[status.keys.backing]}.` });
  } else {
    lines.push({ tone: "muted", text: "This phone can be a Device. It holds no keys yet." });
  }
  lines.push({
    tone: "muted",
    text:
      `Passcode ${status.passcodeSet ? "set" : "not set"}; hardware keystore ` +
      `${status.hardwareKeystore ? "claimed" : "absent"}; software key ${status.softwareFallback ? "allowed" : "not allowed"}.`,
  });
  return lines;
}

/// Runs one of the panel's buttons and says what happened.
export async function panelAction(keys: DeviceKeysPlugin, action: PanelAction): Promise<PanelLine> {
  try {
    switch (action) {
      case "create": {
        const made = await keys.createKeys();
        const attested = made.attestation.length > 0 ? `, with ${made.attestation.length} attestation certificates` : "";
        return { tone: "ok", text: `Created: the hardware key ${BACKING_WORDS[made.backing]}${attested}.` };
      }
      case "sign": {
        const { hardwareKey } = await keys.publicKeys();
        const handshakeHash = toHex(crypto.getRandomValues(new Uint8Array(HANDSHAKE_HASH_BYTES)));
        const { signature } = await keys.sign({ handshakeHash, reason: PANEL_REASON });
        const verified = await verifyHandshakeSignature({ hardwareKey, handshakeHash, signature });
        return verified
          ? { tone: "ok", text: `Signed, and the signature verifies against the hardware key.` }
          : { tone: "problem", text: "Signed, but the signature does not verify against the hardware key." };
      }
      case "delete":
        await keys.deleteKeys();
        return { tone: "ok", text: "Deleted." };
    }
  } catch (e) {
    const code = errorCode(e);
    const why = e instanceof Error ? e.message : String(e);
    switch (code) {
      case "no-passcode":
      case "no-hardware-keystore":
        return { tone: "problem", text: `Refused: ${refusalText(code)}` };
      case "cancelled":
        return { tone: "muted", text: "Not signed: the prompt was dismissed." };
      case "keys-exist":
        return { tone: "problem", text: "Refused: this phone already holds a Device’s keys. Delete them first." };
      case "no-keys":
        return { tone: "problem", text: "Refused: this phone holds no keys. Create them first." };
      default:
        return { tone: "problem", text: `Failed (${code}): ${why}` };
    }
  }
}
