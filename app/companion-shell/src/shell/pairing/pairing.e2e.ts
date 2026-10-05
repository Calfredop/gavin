// The scripted pairing, in Node: the shell's own pairing module and the
// real Companion core (`static/companion-core.wasm`), over Node's
// WebSocket, against a real daemon through a real Relay
// (`scripts/devstack.mjs`). Not part of `companion-shell:test` -- it needs
// the two binaries built and takes seconds -- but `scripts/pair.sh node`:
//
//   GAVIN_E2E=1 npx vitest run src/shell/pairing/pairing.e2e.ts
//
// What stands in for the phone is its hardware key alone: a P-256 key in
// WebCrypto, which signs what the Secure Enclave would, in the format it
// would. Everything else is what runs on the phone.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCore, type CoreModule } from "$shell/core/core";
import { keepPairing, readRecord } from "$shell/hub/paired";
import { fromHex, toHex, unlockMessage } from "$shell/keys/deviceKeys";
import { pair, type PairingKeys, type PairingPhase } from "$shell/pairing/pairing";
import { webSocketOpener, type WebSocketConstructor } from "$shell/pairing/relaySocket";
import { coreWasm } from "$shell/testing/coreWasm";

interface Desk {
  offer(): Promise<string>;
  asked(timeoutMs?: number): Promise<{ device_id: string; name: string; sas: string }>;
  confirm(deviceId: string): Promise<void>;
  reject(deviceId: string): Promise<void>;
  /// `DeviceInfo`, camelCase on the wire.
  devices(): Promise<Array<{ deviceId: string; name: string; role: string }>>;
}
interface Stack {
  desk: Desk;
  registered(qr: string): Promise<void>;
  daemonLog(): string;
  stop(): Promise<void>;
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

/// A phone that can be a Device, with its hardware key in WebCrypto.
async function softwarePhone(): Promise<PairingKeys & { signed: string[] }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const hardwareKey = toHex(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const noise = toHex(crypto.getRandomValues(new Uint8Array(32)));
  let made = false;
  const signed: string[] = [];
  const keys = { hardwareKey, backing: "software-debug" as const, attestation: [] };
  return {
    signed,
    status: async () => ({
      platform: "ios",
      passcodeSet: true,
      hardwareKeystore: false,
      softwareFallback: true,
      keys: made ? { backing: "software-debug" } : null,
      debugBuild: true,
      checkRequested: false,
    }),
    createKeys: async () => {
      made = true;
      return keys;
    },
    publicKeys: async () => keys,
    noiseKey: async () => ({ privateKey: noise }),
    sign: async ({ handshakeHash }) => {
      const hash = fromHex(handshakeHash);
      if (!hash || hash.length !== 32) throw Object.assign(new Error("bad hash"), { code: "bad-hash" });
      const raw = new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, unlockMessage(hash))
      );
      const signature = toHex(p1363ToDer(raw));
      signed.push(handshakeHash);
      return { signature };
    },
  };
}

let stack: Stack;
let core: CoreModule;

beforeAll(async () => {
  // Loaded by URL: a script of the shell's, not a module the checker reads.
  const devstack = new URL("../../../scripts/devstack.mjs", import.meta.url).href;
  const { startDevStack } = (await import(/* @vite-ignore */ devstack)) as { startDevStack(): Promise<Stack> };
  stack = await startDevStack();
  core = await loadCore(coreWasm());
}, 60_000);

afterAll(async () => {
  await stack?.stop();
});

function pairing(qr: string, keys: PairingKeys, name: string) {
  const phases: PairingPhase[] = [];
  let showCode!: (code: string) => void;
  const code = new Promise<string>((resolve) => (showCode = resolve));
  const outcome = pair(qr, {
    core,
    keys,
    open: webSocketOpener(WebSocket as unknown as WebSocketConstructor),
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    deviceName: name,
    onPhase: (phase) => {
      phases.push(phase);
      if (phase.phase === "comparing") showCode(phase.code);
    },
  });
  return { phases, code, outcome };
}

describe("the shell pairs with a real Workstation", () => {
  it("pairs through the Relay: the codes match, the desk confirms, and both ends keep the other", async () => {
    const qr = await stack.desk.offer();
    await stack.registered(qr);
    const phone = await softwarePhone();

    const run = pairing(qr, phone, "Scripted phone");
    const asked = await stack.desk.asked(30_000);
    const code = await run.code;
    expect(asked.name).toBe("Scripted phone");
    expect(code).toMatch(/^\d{6}$/);
    expect(code).toBe(asked.sas);

    await stack.desk.confirm(asked.device_id);
    const outcome = await run.outcome;
    if (outcome.outcome !== "paired") throw new Error(`${JSON.stringify(outcome)}\n${stack.daemonLog()}`);
    expect(outcome.workstation.deviceId).toBe(asked.device_id);
    expect(outcome.workstation.workstationKey).toBe(JSON.parse(qr).daemonPublicKey);
    expect(outcome.workstation.notificationKey).toMatch(/^[0-9a-f]{64}$/);
    expect(run.phases.map((p) => p.phase)).toEqual(["preparing", "connecting", "confirming", "connecting", "comparing"]);

    // The hardware key signed one handshake -- and the daemon verified
    // that signature, or it would not have asked the desk.
    expect(phone.signed).toHaveLength(1);
    expect(await stack.desk.devices()).toEqual(
      expect.arrayContaining([expect.objectContaining({ deviceId: asked.device_id, name: "Scripted phone", role: "remote" })])
    );

    // What the hub keeps reads back whole.
    const record = keepPairing(outcome.workstation, [], Date.now());
    expect(readRecord(JSON.stringify(record))).toEqual(record);
  }, 60_000);

  it("keeps nothing when the desk says no", async () => {
    const qr = await stack.desk.offer();
    await stack.registered(qr);
    const run = pairing(qr, await softwarePhone(), "Refused phone");
    const asked = await stack.desk.asked(30_000);
    await run.code;
    await stack.desk.reject(asked.device_id);
    expect(await run.outcome).toEqual({
      outcome: "failed",
      problem: "The desk declined this pairing. Nothing was paired.",
    });
    expect((await stack.desk.devices()).map((d) => d.name)).not.toContain("Refused phone");
  }, 60_000);

  it("cannot pair twice on one code", async () => {
    const qr = await stack.desk.offer();
    await stack.registered(qr);
    const first = pairing(qr, await softwarePhone(), "First phone");
    const asked = await stack.desk.asked(30_000);
    await first.code;
    await stack.desk.confirm(asked.device_id);
    expect((await first.outcome).outcome).toBe("paired");

    const second = pairing(qr, await softwarePhone(), "Second phone");
    const outcome = await second.outcome;
    expect(outcome.outcome).toBe("failed");
    expect((await stack.desk.devices()).map((d) => d.name)).not.toContain("Second phone");
  }, 60_000);
});
