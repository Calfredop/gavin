// A stand-in for the DeviceKeys plugin, for the keys tests: the native
// contract in memory -- what `DeviceKeysPlugin.swift` and
// `DeviceKeysPlugin.java` promise -- with WebCrypto as the hardware, and
// faults to switch on, each one a way a plugin could be wrong.
import type { DeviceKeysPlugin, DeviceKeysStatus, KeyBacking, KeysErrorCode } from "$shell/native/deviceKeys";
import { HANDSHAKE_HASH_BYTES, fromHex, toHex, unlockMessage } from "./deviceKeys";

export function refused(code: KeysErrorCode, message = code): Error {
  return Object.assign(new Error(message), { code });
}

/// DER from WebCrypto's r || s, as a native signer writes it.
export function toDer(p1363: Uint8Array): Uint8Array {
  const integer = (value: Uint8Array): number[] => {
    let bytes = Array.from(value);
    while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.slice(1);
    if (bytes[0] & 0x80) bytes = [0, ...bytes];
    return [0x02, bytes.length, ...bytes];
  };
  const body = [...integer(p1363.subarray(0, 32)), ...integer(p1363.subarray(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

export interface Phone {
  passcodeSet?: boolean;
  hardwareKeystore?: boolean;
  softwareFallback?: boolean;
  /// What the key turns out to be once made (an emulator claims hardware).
  backing?: KeyBacking;
  /// Deliberate faults, each one a way a plugin could be wrong.
  faults?: {
    createsWithoutPasscode?: boolean;
    keepsSoftwareKey?: boolean;
    signsTheBareHash?: boolean;
    signsAnyLength?: boolean;
    replacesKeys?: boolean;
  };
}

/// The plugin, and a count of the prompts it has shown.
export function standIn(phone: Phone = {}): DeviceKeysPlugin & { prompts: number } {
  const passcodeSet = phone.passcodeSet ?? true;
  const hardwareKeystore = phone.hardwareKeystore ?? true;
  const softwareFallback = phone.softwareFallback ?? false;
  const faults = phone.faults ?? {};
  let held: { pair: CryptoKeyPair; publicKey: string; backing: KeyBacking; noise: string } | null = null;
  const plugin = {
    prompts: 0,
    async status(): Promise<DeviceKeysStatus> {
      return {
        platform: "ios",
        passcodeSet,
        hardwareKeystore,
        softwareFallback,
        keys: held ? { backing: held.backing } : null,
        debugBuild: true,
        checkRequested: true,
      };
    },
    async createKeys() {
      if (!passcodeSet && !faults.createsWithoutPasscode) throw refused("no-passcode");
      if (held && !faults.replacesKeys) throw refused("keys-exist");
      const backing = phone.backing ?? (hardwareKeystore ? "secure-enclave" : "software-debug");
      if (backing === "software-debug" && !softwareFallback && !faults.keepsSoftwareKey) {
        throw refused("no-hardware-keystore");
      }
      const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      const publicKey = toHex(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
      held = { pair, publicKey, backing, noise: toHex(crypto.getRandomValues(new Uint8Array(32))) };
      return { hardwareKey: publicKey, backing, attestation: [] };
    },
    async publicKeys() {
      if (!held) throw refused("no-keys");
      return { hardwareKey: held.publicKey, backing: held.backing, attestation: [] };
    },
    async noiseKey() {
      if (!held) throw refused("no-keys");
      return { privateKey: held.noise };
    },
    async sign({ handshakeHash }: { handshakeHash: string; reason: string }) {
      const hash = fromHex(handshakeHash);
      if (!hash || (hash.length !== HANDSHAKE_HASH_BYTES && !faults.signsAnyLength)) throw refused("bad-hash");
      if (!held) throw refused("no-keys");
      plugin.prompts++;
      const message = faults.signsTheBareHash ? hash : unlockMessage(hash);
      const p1363 = new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, held.pair.privateKey, message)
      );
      return { signature: toHex(toDer(p1363)) };
    },
    async deleteKeys() {
      held = null;
    },
  };
  return plugin;
}
