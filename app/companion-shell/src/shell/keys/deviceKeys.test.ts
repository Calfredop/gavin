import { describe, expect, it } from "vitest";
import type { DeviceKeysStatus } from "$shell/native/deviceKeys";
import {
  UNLOCK_CONTEXT,
  derToP1363,
  errorCode,
  fromHex,
  publicKeysProblem,
  readiness,
  refusalText,
  toHex,
  unlockMessage,
  verifyHandshakeSignature,
} from "./deviceKeys";
import { toDer } from "./standIn";

function status(over: Partial<DeviceKeysStatus> = {}): DeviceKeysStatus {
  return {
    platform: "ios",
    passcodeSet: true,
    hardwareKeystore: true,
    softwareFallback: false,
    keys: null,
    debugBuild: false,
    checkRequested: false,
    ...over,
  };
}

describe("readiness", () => {
  it("is ready with a passcode and a hardware keystore", () => {
    expect(readiness(status())).toEqual({ ready: true });
  });

  it("refuses a phone with no passcode, whatever else it has", () => {
    expect(readiness(status({ passcodeSet: false }))).toEqual({ ready: false, refusal: "no-passcode" });
    expect(readiness(status({ passcodeSet: false, hardwareKeystore: false }))).toEqual({
      ready: false,
      refusal: "no-passcode",
    });
    expect(readiness(status({ passcodeSet: false, softwareFallback: true }))).toEqual({
      ready: false,
      refusal: "no-passcode",
    });
  });

  it("refuses a phone with no hardware keystore", () => {
    expect(readiness(status({ hardwareKeystore: false }))).toEqual({
      ready: false,
      refusal: "no-hardware-keystore",
    });
  });

  it("lets a debug build on a Simulator or emulator stand in with a software key", () => {
    expect(readiness(status({ hardwareKeystore: false, softwareFallback: true }))).toEqual({ ready: true });
  });

  it("says why, in words the owner can act on", () => {
    expect(refusalText("no-passcode")).toMatch(/no passcode.*set a passcode/s);
    expect(refusalText("no-hardware-keystore")).toMatch(/no hardware keystore.*cannot be copied/s);
  });
});

describe("errorCode", () => {
  it("reads the code Capacitor puts on a rejection", () => {
    expect(errorCode(Object.assign(new Error("x"), { code: "no-passcode" }))).toBe("no-passcode");
    expect(errorCode({ code: "cancelled" })).toBe("cancelled");
  });

  it("calls anything else a failure", () => {
    expect(errorCode(new Error("x"))).toBe("failed");
    expect(errorCode({ code: "UNIMPLEMENTED" })).toBe("failed");
    expect(errorCode(null)).toBe("failed");
    expect(errorCode("no-keys")).toBe("failed");
  });
});

describe("hex", () => {
  it("round-trips", () => {
    const bytes = new Uint8Array([0, 1, 0x7f, 0x80, 0xff]);
    expect(toHex(bytes)).toBe("00017f80ff");
    expect(fromHex("00017F80ff")).toEqual(bytes);
    expect(fromHex("")).toEqual(new Uint8Array());
  });

  it("refuses what is not hex", () => {
    expect(fromHex("abc")).toBeNull();
    expect(fromHex("zz")).toBeNull();
    expect(fromHex("0x00")).toBeNull();
  });
});

describe("the unlock message", () => {
  it("is the wire's context followed by the handshake hash", () => {
    const hash = new Uint8Array(32).fill(7);
    const message = unlockMessage(hash);
    expect(new TextDecoder().decode(message.subarray(0, 22))).toBe("gavin-device-unlock-v1");
    expect(message.subarray(22)).toEqual(hash);
    expect(message.length).toBe(22 + 32);
  });

  /// Both plugins build the message themselves, so that the hardware key
  /// can never be asked to sign anything else. The bytes they prepend and
  /// the hash length they accept are held to this module's.
  it("is what both native plugins sign", () => {
    const sources = import.meta.glob(
      ["../../../ios/App/App/DeviceKeysPlugin.swift", "../../../android/app/src/main/java/com/gavin/companion/DeviceKeysPlugin.java"],
      { query: "?raw", import: "default", eager: true }
    ) as Record<string, string>;
    expect(Object.keys(sources)).toHaveLength(2);
    for (const [path, source] of Object.entries(sources)) {
      expect(source, path).toContain(`"${UNLOCK_CONTEXT}"`);
      expect(source, path).toMatch(/HASH_BYTES = 32|handshakeHashBytes = 32/);
    }
  });
});

describe("derToP1363", () => {
  it("reads r and s back to fixed width", () => {
    const r = new Uint8Array(32).fill(0x11);
    const s = new Uint8Array(32).fill(0x22);
    const fixed = new Uint8Array([...r, ...s]);
    expect(derToP1363(toDer(fixed))).toEqual(fixed);
  });

  it("drops the zero byte ahead of a high bit", () => {
    const fixed = new Uint8Array(64).fill(0x80);
    const der = toDer(fixed);
    expect(der.length).toBe(2 + 2 * (2 + 33));
    expect(derToP1363(der)).toEqual(fixed);
  });

  it("pads a short component back out", () => {
    const fixed = new Uint8Array(64).fill(0x33);
    fixed.fill(0, 0, 3);
    const der = toDer(fixed);
    expect(der[3]).toBe(29);
    expect(derToP1363(der)).toEqual(fixed);
  });

  it("refuses what is not a signature", () => {
    const good = toDer(new Uint8Array(64).fill(0x44));
    expect(derToP1363(new Uint8Array())).toBeNull();
    expect(derToP1363(good.subarray(0, good.length - 1))).toBeNull();
    expect(derToP1363(new Uint8Array([...good, 0]))).toBeNull();
    expect(derToP1363(new Uint8Array([0x31, ...good.subarray(1)]))).toBeNull();
    // A component wider than the curve.
    expect(derToP1363(new Uint8Array([0x30, 38, 0x02, 33, 1, ...new Uint8Array(32), 0x02, 1, 1]))).toBeNull();
    // A negative component.
    expect(derToP1363(new Uint8Array([0x30, 6, 0x02, 1, 0x80, 0x02, 1, 1]))).toBeNull();
  });
});

async function hardwareKeyStandIn(): Promise<{ publicKey: string; sign(message: Uint8Array): Promise<string> }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    publicKey: toHex(raw),
    async sign(message) {
      const p1363 = new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, message)
      );
      return toHex(toDer(p1363));
    },
  };
}

describe("verifyHandshakeSignature", () => {
  const hash = new Uint8Array(32).map((_, i) => i);

  it("accepts the key's signature over the unlock message", async () => {
    const key = await hardwareKeyStandIn();
    const signature = await key.sign(unlockMessage(hash));
    expect(
      await verifyHandshakeSignature({ hardwareKey: key.publicKey, handshakeHash: toHex(hash), signature })
    ).toBe(true);
  });

  it("refuses a signature over another handshake", async () => {
    const key = await hardwareKeyStandIn();
    const signature = await key.sign(unlockMessage(hash));
    const other = toHex(hash.map((b) => b ^ 1));
    expect(await verifyHandshakeSignature({ hardwareKey: key.publicKey, handshakeHash: other, signature })).toBe(false);
  });

  it("refuses a signature over the bare hash: the context is part of what is signed", async () => {
    const key = await hardwareKeyStandIn();
    const signature = await key.sign(hash);
    expect(
      await verifyHandshakeSignature({ hardwareKey: key.publicKey, handshakeHash: toHex(hash), signature })
    ).toBe(false);
  });

  it("refuses another key's signature", async () => {
    const key = await hardwareKeyStandIn();
    const other = await hardwareKeyStandIn();
    const signature = await other.sign(unlockMessage(hash));
    expect(
      await verifyHandshakeSignature({ hardwareKey: key.publicKey, handshakeHash: toHex(hash), signature })
    ).toBe(false);
  });

  it("refuses what is malformed, without throwing", async () => {
    const key = await hardwareKeyStandIn();
    const signature = await key.sign(unlockMessage(hash));
    const handshakeHash = toHex(hash);
    expect(await verifyHandshakeSignature({ hardwareKey: "04", handshakeHash, signature })).toBe(false);
    expect(await verifyHandshakeSignature({ hardwareKey: "zz", handshakeHash, signature })).toBe(false);
    expect(
      await verifyHandshakeSignature({ hardwareKey: key.publicKey, handshakeHash, signature: signature.slice(2) })
    ).toBe(false);
    const offCurve = "04" + "00".repeat(64);
    expect(await verifyHandshakeSignature({ hardwareKey: offCurve, handshakeHash, signature })).toBe(false);
  });
});

describe("publicKeysProblem", () => {
  it("accepts an uncompressed point and names anything else", () => {
    const point = "04" + "ab".repeat(64);
    expect(publicKeysProblem({ hardwareKey: point, backing: "tee", attestation: [] })).toBeNull();
    expect(publicKeysProblem({ hardwareKey: "02" + "ab".repeat(32), backing: "tee", attestation: [] })).toMatch(
      /33 bytes/
    );
  });
});
