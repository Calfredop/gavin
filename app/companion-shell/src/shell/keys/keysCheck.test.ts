import { describe, expect, it } from "vitest";
import { KEYS_MARK, PROMPTING, runKeysCheck } from "./keysCheck";
import { standIn, type Phone } from "./standIn";

async function check(phone: Phone) {
  const keys = standIn(phone);
  const log: string[] = [];
  const verdict = await runKeysCheck({ keys, log: (line) => log.push(line) });
  const failed = verdict.checks.filter((c) => !c.passed).map((c) => c.name);
  return { verdict, failed, log, keys };
}

describe("the keys check on a phone that can be a Device", () => {
  it("passes, prompting exactly once", async () => {
    const { verdict, failed, log, keys } = await check({});
    expect(failed).toEqual([]);
    expect(verdict).toMatchObject({ outcome: "ready: secure-enclave", passed: true });
    expect(keys.prompts).toBe(1);
    expect(log.filter((l) => l === PROMPTING)).toHaveLength(1);
  });

  it("logs the verdict on one marked line, last", async () => {
    const { verdict, log } = await check({});
    expect(log[0]).toBe(`${KEYS_MARK} started`);
    expect(log.at(-1)).toBe(`${KEYS_MARK} ${JSON.stringify(verdict)}`);
  });

  it("never logs the Noise key", async () => {
    const keys = standIn();
    const log: string[] = [];
    let noise = "";
    const spying = {
      ...keys,
      async noiseKey() {
        const answer = await keys.noiseKey();
        noise = answer.privateKey;
        return answer;
      },
    };
    await runKeysCheck({ keys: spying, log: (line) => log.push(line) });
    expect(noise).toHaveLength(64);
    expect(log.join("\n")).not.toContain(noise);
  });

  it("passes with a software key on a build that may fall back to one", async () => {
    const { verdict, failed } = await check({ hardwareKeystore: false, softwareFallback: true });
    expect(failed).toEqual([]);
    expect(verdict.outcome).toBe("ready: software-debug");
  });

  it("fails a plugin that keeps a software key where none is allowed", async () => {
    const { failed } = await check({ backing: "software-debug", faults: { keepsSoftwareKey: true } });
    expect(failed).toEqual([
      "the hardware key is hardware, or marked software-debug where only a debug build may use one",
    ]);
  });

  it("fails a plugin that signs the bare hash, without the unlock context", async () => {
    const { failed } = await check({ faults: { signsTheBareHash: true } });
    expect(failed).toEqual(["after the prompt, the hardware key signs the unlock message, and the signature verifies"]);
  });

  it("fails a plugin that signs a hash of any length", async () => {
    const { failed } = await check({ faults: { signsAnyLength: true } });
    expect(failed).toEqual(["a hash that is not 32 bytes is refused, before any prompt"]);
  });

  it("fails a plugin that silently replaces existing keys", async () => {
    const { failed } = await check({ faults: { replacesKeys: true } });
    expect(failed).toContain("creating them again is refused while they exist");
  });
});

describe("the keys check on a phone that cannot be a Device", () => {
  it("passes when the plugin refuses a phone with no passcode", async () => {
    const { verdict, failed, keys } = await check({ passcodeSet: false });
    expect(failed).toEqual([]);
    expect(verdict).toMatchObject({ outcome: "refused: no-passcode", passed: true });
    expect(keys.prompts).toBe(0);
  });

  it("fails a plugin that creates keys on a phone with no passcode anyway", async () => {
    const { verdict, failed } = await check({ passcodeSet: false, faults: { createsWithoutPasscode: true } });
    expect(verdict.passed).toBe(false);
    expect(failed).toEqual([
      "creating the keys is refused natively too, for the same reason",
      "no keys are left behind",
    ]);
  });

  it("passes when the plugin refuses a phone with no hardware keystore", async () => {
    const { verdict, failed } = await check({ hardwareKeystore: false });
    expect(failed).toEqual([]);
    expect(verdict.outcome).toBe("refused: no-hardware-keystore");
  });

  /// An emulator claims a hardware keystore; a build that may not fall
  /// back learns otherwise when the key comes out software.
  it("passes when the refusal only comes once the key is made", async () => {
    const { verdict, failed } = await check({ backing: "software-debug" });
    expect(failed).toEqual([]);
    expect(verdict).toMatchObject({ outcome: "refused: no-hardware-keystore", passed: true });
  });
});

describe("the keys check with no plugin", () => {
  it("fails, saying so", async () => {
    const log: string[] = [];
    const broken = standIn();
    broken.status = () => Promise.reject(new Error('"DeviceKeys" plugin is not implemented on web'));
    const verdict = await runKeysCheck({ keys: broken, log: (line) => log.push(line) });
    expect(verdict).toMatchObject({ outcome: "no plugin", passed: false });
  });
});

