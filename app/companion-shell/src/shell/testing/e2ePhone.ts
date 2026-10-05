// The phone a Node end-to-end test plays (`hub.e2e.ts`, `bundle.e2e.ts`):
// its hardware key and its Unlock -- a P-256 key in WebCrypto that signs a
// pairing when asked and a connection only while "unlocked", counting how
// often the owner was asked -- and the dev stack's desk as those tests
// see it. Everything else in those tests is what runs on the phone.
import { fromHex, toHex, unlockMessage } from "$shell/keys/deviceKeys";
import type { UnlockKeys } from "$shell/hub/unlockedHub";
import type { LifecyclePhase } from "$shell/native/deviceKeys";
import type { PairingKeys } from "$shell/pairing/pairing";

export interface App {
  setItems(items: unknown[]): void;
  setBundle(bundle: { manifest: unknown; archive: Uint8Array } | null): void;
  received(): Array<{ command: string; args: unknown }>;
  offer(event: string, payload: unknown): Promise<void>;
  quit(): void;
}

export interface Stack {
  desk: {
    offer(): Promise<string>;
    asked(timeoutMs?: number): Promise<{ device_id: string; name: string; sas: string }>;
    confirm(deviceId: string): Promise<void>;
    startApp(
      items?: unknown[],
      options?: {
        bundle?: { manifest: unknown; archive: Uint8Array } | null;
        commands?: (command: string, args: unknown) => unknown;
      }
    ): Promise<App>;
    remoteAccess(enabled: boolean): Promise<void>;
  };
  registered(qr: string): Promise<void>;
  daemonLog(): string;
  stop(): Promise<void>;
}

export async function startStack(): Promise<Stack> {
  const devstack = new URL("../../../scripts/devstack.mjs", import.meta.url).href;
  const { startDevStack } = (await import(/* @vite-ignore */ devstack)) as { startDevStack(): Promise<Stack> };
  return startDevStack();
}

/// ECDSA's fixed-width `r || s`, as WebCrypto signs, in the ASN.1 DER a
/// phone's hardware returns and the daemon reads.
function p1363ToDer(signature: Uint8Array): Uint8Array {
  const integer = (half: Uint8Array): number[] => {
    let bytes = Array.from(half);
    while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.slice(1);
    if (bytes[0] & 0x80) bytes = [0, ...bytes];
    return [0x02, bytes.length, ...bytes];
  };
  const body = [...integer(signature.subarray(0, 32)), ...integer(signature.subarray(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

/// A phone that can be a Device, whose hardware key signs a pairing when
/// asked and a connection only under a held Unlock.
export async function softwarePhone() {
  const pairKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const hardwareKey = toHex(new Uint8Array(await crypto.subtle.exportKey("raw", pairKeys.publicKey)));
  const noise = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const made = { hardwareKey, backing: "software-debug" as const, attestation: [] };
  let created = false;
  let held = false;
  let listener: ((e: { phase: LifecyclePhase }) => void) | null = null;
  const counts = { prompts: 0, silentSigns: 0 };

  const signHash = async (handshakeHash: string): Promise<string> => {
    const hash = fromHex(handshakeHash);
    if (!hash || hash.length !== 32) throw Object.assign(new Error("bad hash"), { code: "bad-hash" });
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pairKeys.privateKey, unlockMessage(hash))
    );
    return toHex(p1363ToDer(raw));
  };

  const pairing: PairingKeys = {
    status: async () => ({
      platform: "ios",
      passcodeSet: true,
      hardwareKeystore: false,
      softwareFallback: true,
      keys: created ? { backing: "software-debug" } : null,
      debugBuild: true,
      checkRequested: false,
    }),
    createKeys: async () => {
      created = true;
      return made;
    },
    publicKeys: async () => made,
    noiseKey: async () => ({ privateKey: noise }),
    sign: async ({ handshakeHash }) => ({ signature: await signHash(handshakeHash) }),
  };

  const unlock: UnlockKeys = {
    noiseKey: async () => ({ privateKey: noise }),
    unlock: async () => {
      counts.prompts += 1;
      held = true;
    },
    signUnlocked: async ({ handshakeHash }) => {
      if (!held) throw Object.assign(new Error("no Unlock is held"), { code: "locked" });
      counts.silentSigns += 1;
      return { signature: await signHash(handshakeHash) };
    },
    lock: async () => {
      held = false;
    },
    unlockState: async () => ({ unlocked: held, foreground: true }),
    addListener: async (_event, fn) => {
      listener = fn;
      return { remove: async () => void (listener = null) };
    },
  };

  return {
    pairing,
    unlock,
    counts,
    /// The app's lifecycle, as the native side reports it -- having ended
    /// its own Unlock first.
    emit(phase: LifecyclePhase) {
      if (phase !== "foreground") held = false;
      listener?.({ phase });
    },
  };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until<T>(what: string, check: () => T | null | undefined | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

