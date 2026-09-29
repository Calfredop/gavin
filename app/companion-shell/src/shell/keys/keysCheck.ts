// The keys check (debug builds only): proof, on a Simulator, an emulator
// or a phone, that the DeviceKeys plugin does what ADR 0001 asks of it.
//
// It drives the plugin the way pairing and connecting will: on a phone
// that can be a Device, it creates both keys, reads them back, has the
// hardware key sign a handshake hash -- the one step that prompts -- and
// verifies that signature exactly as the daemon does, then deletes the
// keys and sees them gone. On a phone that cannot, it checks that the
// plugin refuses to create them too, for the same reason, and leaves
// nothing behind. `scripts/keys.sh` launches it, answers the prompt, and
// reads the verdict from the device log.
//
// It starts by deleting whatever keys the phone holds, and ends with none:
// run on a phone that has paired, it leaves a Device that must pair again.
import type { DeviceKeysPlugin, DevicePublicKeys, KeysErrorCode } from "$shell/native/deviceKeys";
import {
  HANDSHAKE_HASH_BYTES,
  NOISE_KEY_BYTES,
  errorCode,
  fromHex,
  publicKeysProblem,
  readiness,
  refusalText,
  toHex,
  verifyHandshakeSignature,
} from "./deviceKeys";

/// The mark on every line the keys check logs.
export const KEYS_MARK = "[gavin-keys]";

/// Logged just before the one call that puts a prompt on screen, so the
/// script knows when to answer it.
export const PROMPTING = `${KEYS_MARK} prompting`;

/// What the prompt says during the check.
export const CHECK_REASON = "Sign a test handshake (keys check)";

export interface KeysCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface KeysVerdict {
  /// `ready: <backing>` or `refused: <refusal>`.
  outcome: string;
  passed: boolean;
  checks: KeysCheck[];
}

type Attempt<T> = { ok: true; value: T } | { ok: false; code: KeysErrorCode; message: string };

async function attempt<T>(call: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (e) {
    return { ok: false, code: errorCode(e), message: e instanceof Error ? e.message : String(e) };
  }
}

function said<T>(result: Attempt<T>): string {
  return result.ok ? "it was not refused" : `refused ${result.code}: ${result.message}`;
}

function refusedWith<T>(result: Attempt<T>, code: KeysErrorCode): boolean {
  return !result.ok && result.code === code;
}

function randomHash(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(HANDSHAKE_HASH_BYTES));
}

export async function runKeysCheck(options: {
  keys: DeviceKeysPlugin;
  log(line: string): void;
  /// The handshake hash to sign; a random one by default.
  hash?: Uint8Array;
}): Promise<KeysVerdict> {
  const { keys, log } = options;
  const checks: KeysCheck[] = [];
  const add = (name: string, passed: boolean, detail: string): void => {
    checks.push({ name, passed, detail });
  };
  const finish = (outcome: string): KeysVerdict => {
    const verdict = { outcome, passed: checks.every((c) => c.passed), checks };
    log(`${KEYS_MARK} ${JSON.stringify(verdict)}`);
    return verdict;
  };
  log(`${KEYS_MARK} started`);

  const status = await attempt(() => keys.status());
  if (!status.ok) {
    add("the plugin answers", false, said(status));
    return finish("no plugin");
  }
  const phone = status.value;
  const ready = readiness(phone);
  const facts =
    `passcode ${phone.passcodeSet ? "set" : "not set"}, ` +
    `hardware keystore ${phone.hardwareKeystore ? "claimed" : "absent"}, ` +
    `software fallback ${phone.softwareFallback ? "allowed" : "not allowed"}`;

  if (!ready.ready) {
    add(`the phone is refused: ${ready.refusal}`, true, `${facts}. ${refusalText(ready.refusal)}`);
    const created = await attempt(() => keys.createKeys());
    add(
      "creating the keys is refused natively too, for the same reason",
      refusedWith(created, ready.refusal),
      said(created)
    );
    const after = await attempt(() => keys.status());
    add("no keys are left behind", after.ok && after.value.keys === null, after.ok ? `keys: ${JSON.stringify(after.value.keys)}` : said(after));
    return finish(`refused: ${ready.refusal}`);
  }

  add("before any key is made, the phone looks able to be a Device", true, facts);
  await attempt(() => keys.deleteKeys());

  const created = await attempt(() => keys.createKeys());
  if (!created.ok) {
    // An emulator claims a hardware keystore it does not have; a build
    // that may not fall back is refused only once the key is made.
    const refusal = created.code === "no-hardware-keystore" || created.code === "no-passcode" ? created.code : null;
    add(
      refusal ? `the phone is refused when the key is made: ${refusal}` : "the keys are created",
      refusal !== null,
      refusal ? `${said(created)}. ${refusalText(refusal)}` : said(created)
    );
    const after = await attempt(() => keys.status());
    add("no keys are left behind", after.ok && after.value.keys === null, after.ok ? `keys: ${JSON.stringify(after.value.keys)}` : said(after));
    return finish(refusal ? `refused: ${refusal}` : "not created");
  }
  const made: DevicePublicKeys = created.value;
  const problem = publicKeysProblem(made);
  add("the keys are created", problem === null, problem ?? `hardware key ${made.hardwareKey.slice(0, 18)}…, ${made.backing}`);
  add(
    "the hardware key is hardware, or marked software-debug where only a debug build may use one",
    made.backing !== "software-debug" || phone.softwareFallback,
    `${made.backing}; ${made.attestation.length} attestation certificate(s)`
  );

  const again = await attempt(() => keys.createKeys());
  add("creating them again is refused while they exist", refusedWith(again, "keys-exist"), said(again));

  const read = await attempt(() => keys.publicKeys());
  add(
    "the public keys read back",
    read.ok && read.value.hardwareKey === made.hardwareKey && read.value.backing === made.backing,
    read.ok ? `${read.value.backing}, same key: ${read.value.hardwareKey === made.hardwareKey}` : said(read)
  );
  const now = await attempt(() => keys.status());
  add(
    "the status names them",
    now.ok && now.value.keys?.backing === made.backing,
    now.ok ? `keys: ${JSON.stringify(now.value.keys)}` : said(now)
  );

  const noise = await attempt(() => keys.noiseKey());
  const noiseBytes = noise.ok ? fromHex(noise.value.privateKey) : null;
  // Its length only: the key itself never goes into a log.
  add(
    `the Noise key reads back as ${NOISE_KEY_BYTES} bytes`,
    noiseBytes !== null && noiseBytes.length === NOISE_KEY_BYTES,
    noise.ok ? `${noiseBytes?.length ?? "not hex:"} bytes` : said(noise)
  );

  const short = await attempt(() => keys.sign({ handshakeHash: "00".repeat(HANDSHAKE_HASH_BYTES - 1), reason: CHECK_REASON }));
  add("a hash that is not 32 bytes is refused, before any prompt", refusedWith(short, "bad-hash"), said(short));

  const hash = options.hash ?? randomHash();
  log(PROMPTING);
  const signed = await attempt(() => keys.sign({ handshakeHash: toHex(hash), reason: CHECK_REASON }));
  if (signed.ok) {
    const good = await verifyHandshakeSignature({
      hardwareKey: made.hardwareKey,
      handshakeHash: toHex(hash),
      signature: signed.value.signature,
    });
    const other = await verifyHandshakeSignature({
      hardwareKey: made.hardwareKey,
      handshakeHash: toHex(hash.map((b) => b ^ 0xff)),
      signature: signed.value.signature,
    });
    add(
      "after the prompt, the hardware key signs the unlock message, and the signature verifies",
      good && !other,
      `${signed.value.signature.length / 2}-byte DER signature; verifies: ${good}; verifies for another hash: ${other}`
    );
    log(`${KEYS_MARK} signed ${JSON.stringify({ hardwareKey: made.hardwareKey, handshakeHash: toHex(hash), signature: signed.value.signature })}`);
  } else {
    add("after the prompt, the hardware key signs the unlock message, and the signature verifies", false, said(signed));
  }

  const deleted = await attempt(() => keys.deleteKeys());
  const gone = await attempt(() => keys.status());
  add(
    "the keys are deleted",
    deleted.ok && gone.ok && gone.value.keys === null,
    deleted.ok ? (gone.ok ? `keys: ${JSON.stringify(gone.value.keys)}` : said(gone)) : said(deleted)
  );
  const readGone = await attempt(() => keys.publicKeys());
  const noiseGone = await attempt(() => keys.noiseKey());
  const signGone = await attempt(() => keys.sign({ handshakeHash: toHex(hash), reason: CHECK_REASON }));
  add(
    "with no keys, reading or signing is refused, before any prompt",
    refusedWith(readGone, "no-keys") && refusedWith(noiseGone, "no-keys") && refusedWith(signGone, "no-keys"),
    `public keys: ${said(readGone)}; Noise key: ${said(noiseGone)}; sign: ${said(signGone)}`
  );

  return finish(`ready: ${made.backing}`);
}
