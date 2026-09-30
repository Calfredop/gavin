// The shell's end of the Companion core, against the real module: the
// `.wasm` `scripts/core.mjs` built, which `companion-shell:test` builds
// first. What is proved here is the carrying -- bytes in, JSON across,
// events out, one instance per exchange. The handshake itself is the
// crate's own tests' (`crates/companion-wasm`), and the whole pairing
// against a real daemon is `scripts/pair.sh`'s.
import { beforeAll, describe, expect, it } from "vitest";
import { fromBase64 } from "$shell/bundle/fetch";
import { CONNECT_ENTROPY, CoreError, loadCore, PAIRING_ENTROPY, type CoreModule } from "$shell/core/core";
import { coreWasm, readFixture } from "$shell/testing/coreWasm";

const wasm = coreWasm();

/// A pairing QR, as the desk's daemon writes it. Any 32 bytes are an
/// X25519 public key.
function qr(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    daemonPublicKey: "42".repeat(32),
    secret: "17".repeat(32),
    rendezvous: ["ws://127.0.0.1:8443", "ws://relay.example", "wss://relay.example/gavin"],
    protocolVersion: 9999,
    relayAdmission: "let-me-in",
    ...overrides,
  });
}

const start = {
  noisePrivateKey: "11".repeat(32),
  hardwareKey: `04${"66".repeat(64)}`,
  deviceName: "Pocket",
  entropy: new Uint8Array(PAIRING_ENTROPY).fill(0x77),
};

let core: CoreModule;

beforeAll(async () => {
  core = await loadCore(wasm);
});

describe("the Companion core in the shell", () => {
  it("imports nothing, so it runs with an empty import object", () => {
    expect(WebAssembly.Module.imports(new WebAssembly.Module(wasm))).toEqual([]);
  });

  it("starts a pairing: the first frame, the Relays to dial and the hello for each", async () => {
    const exchange = await core.exchange();
    const started = exchange.pairingStart({ qr: qr(), ...start });

    const length = (started.send[0] << 8) | started.send[1];
    expect(started.send.length).toBe(2 + length);
    // -> e: the ephemeral key, and the tag on an empty payload (a psk
    // pattern has a key from its first token on).
    expect(length).toBe(32 + 16);
    expect(started.workstationKey).toBe("42".repeat(32));
    // ws:// to a public host is not one this build may dial.
    expect(started.dials.map((d) => d.url)).toEqual(["ws://127.0.0.1:8443", "wss://relay.example/gavin"]);
    const hello = JSON.parse(started.dials[0].hello);
    expect(hello).toMatchObject({ role: "device", token: "let-me-in", purpose: "pair", v: 1 });
    expect(hello.rendezvous).toMatch(/^[0-9a-f]{64}$/);
  });

  it("draws its ephemeral key from the entropy it is handed", async () => {
    const first = (await core.exchange()).pairingStart({ qr: qr(), ...start }).send;
    const same = (await core.exchange()).pairingStart({ qr: qr(), ...start }).send;
    const other = (await core.exchange()).pairingStart({
      qr: qr(),
      ...start,
      entropy: new Uint8Array(PAIRING_ENTROPY).fill(0x78),
    }).send;
    expect(same).toEqual(first);
    expect(other).not.toEqual(first);
  });

  it("refuses a Workstation too old to pair with, in words the phone can show", async () => {
    const exchange = await core.exchange();
    const refused = (() => {
      try {
        exchange.pairingStart({ qr: qr({ protocolVersion: 1 }), ...start });
      } catch (e) {
        return e;
      }
    })();
    expect(refused).toBeInstanceOf(CoreError);
    expect((refused as CoreError).kind).toBe("offer");
    expect((refused as CoreError).message).toContain("update Gavin at the desk");
  });

  it("refuses what is not a pairing code, and entropy that is too short", async () => {
    const exchange = await core.exchange();
    expect(() => exchange.pairingStart({ qr: "https://example.com", ...start })).toThrow(
      expect.objectContaining({ kind: "offer" })
    );
    const again = await core.exchange();
    expect(() => again.pairingStart({ qr: qr(), ...start, entropy: new Uint8Array(8) })).toThrow(
      expect.objectContaining({ kind: "entropy" })
    );
  });

  it("gives each exchange an instance of its own", async () => {
    const one = await core.exchange();
    const two = await core.exchange();
    one.pairingStart({ qr: qr(), ...start });
    expect(() => one.pairingStart({ qr: qr(), ...start })).toThrow(expect.objectContaining({ kind: "request" }));
    expect(() => two.pairingStart({ qr: qr(), ...start })).not.toThrow();
  });

  it("ends an exchange whose handshake fails, and says so again after", async () => {
    const exchange = await core.exchange();
    exchange.pairingStart({ qr: qr(), ...start });
    const junk = new Uint8Array([0, 32, ...new Array(32).fill(0xab)]);
    expect(() => exchange.pairingReceive(junk)).toThrow(expect.objectContaining({ kind: "handshake" }));
    expect(() => exchange.pairingReceive(new Uint8Array())).toThrow(expect.objectContaining({ kind: "handshake" }));
  });

  it("reads the Relay's replies by the Relay's own contract", async () => {
    const exchange = await core.exchange();
    expect(exchange.relayReply('{"type":"ready"}')).toEqual({ reply: "ready" });
    expect(exchange.relayReply('{"type":"refused","reason":"admission"}')).toEqual({
      reply: "refused",
      reason: "admission",
      message: "the Relay did not accept the admission token",
    });
    expect(() => exchange.relayReply("not json")).toThrow(expect.objectContaining({ kind: "request" }));
  });

  describe("a connection to a paired Workstation", () => {
    const kept = {
      workstationKey: "42".repeat(32),
      relays: ["ws://relay.example", "ws://127.0.0.1:8443"],
      relayAdmission: "let-me-in",
      noisePrivateKey: "11".repeat(32),
      entropy: new Uint8Array(CONNECT_ENTROPY).fill(0x79),
    };

    it("starts: the first frame, and the Relays to dial with a hello to connect", async () => {
      const started = (await core.exchange()).connectStart(kept);
      const length = (started.send[0] << 8) | started.send[1];
      expect(started.send.length).toBe(2 + length);
      // -> e, es, s, ss: the ephemeral key, the static key sealed, and
      // the tag on an empty payload.
      expect(length).toBe(32 + 32 + 16 + 16);
      expect(started.dials.map((d) => d.url)).toEqual(["ws://127.0.0.1:8443"]);
      expect(JSON.parse(started.dials[0].hello)).toMatchObject({ role: "device", token: "let-me-in", purpose: "connect" });
    });

    it("sends nothing before the Workstation has said connected", async () => {
      const exchange = await core.exchange();
      exchange.connectStart(kept);
      expect(() => exchange.connectSend('{"type":"GetAttention","version":1}')).toThrow(
        expect.objectContaining({ kind: "not-ready" })
      );
    });

    it("is an exchange of its own, and refuses a key of the wrong shape", async () => {
      const exchange = await core.exchange();
      exchange.connectStart(kept);
      expect(() => exchange.connectStart(kept)).toThrow(expect.objectContaining({ kind: "request" }));
      const other = await core.exchange();
      expect(() => other.connectStart({ ...kept, workstationKey: "42".repeat(31) })).toThrow(
        expect.objectContaining({ kind: "offer" })
      );
    });
  });

  describe("a bundle", () => {
    // The fixture the Rust reader and the Node packer are pinned to:
    // its archive, signed by the Node signer under the fixture's seed.
    const fixture = readFixture();

    function archiveBytes(): Uint8Array {
      return fromBase64(fixture.archiveBase64);
    }

    it("opens under its signer into its files, base64", async () => {
      const opened = (await core.exchange()).bundleOpen({
        archive: archiveBytes(),
        manifest: fixture.manifest,
        trustedKeys: ["00".repeat(32), fixture.manifest.signer],
      });
      expect(opened.hash).toBe(fixture.manifest.hash);
      expect(opened.files.map((f) => f.path)).toEqual(fixture.files);
      const page = opened.files.find((f) => f.path === "index.html")!;
      expect(atob(page.data)).toContain("<!doctype html>");
      expect(opened.files.find((f) => f.path === "empty.txt")!.data).toBe("");
    });

    it("is refused under keys that did not sign it, with a bad signature, and when the archive changed", async () => {
      const untrusted = await core.exchange();
      expect(() =>
        untrusted.bundleOpen({ archive: archiveBytes(), manifest: fixture.manifest, trustedKeys: ["00".repeat(32)] })
      ).toThrow(expect.objectContaining({ kind: "bundle", message: expect.stringMatching(/does not trust/) }));

      const forged = await core.exchange();
      const signature = `${fixture.manifest.signature.slice(0, -2)}${fixture.manifest.signature.endsWith("00") ? "01" : "00"}`;
      expect(() =>
        forged.bundleOpen({ archive: archiveBytes(), manifest: { ...fixture.manifest, signature }, trustedKeys: [fixture.manifest.signer] })
      ).toThrow(expect.objectContaining({ kind: "bundle", message: expect.stringMatching(/signature/) }));

      const changed = archiveBytes();
      changed[600] ^= 1;
      const altered = await core.exchange();
      expect(() =>
        altered.bundleOpen({ archive: changed, manifest: fixture.manifest, trustedKeys: [fixture.manifest.signer] })
      ).toThrow(expect.objectContaining({ kind: "bundle", message: expect.stringMatching(/not the one/) }));
    });
  });
});
