import { describe, expect, it } from "vitest";
import type { DeviceKeysStatus } from "$shell/native/deviceKeys";
import { panelAction, statusLines } from "./keysPanel";
import { refused, standIn } from "./standIn";

function status(over: Partial<DeviceKeysStatus> = {}): DeviceKeysStatus {
  return {
    platform: "android",
    passcodeSet: true,
    hardwareKeystore: true,
    softwareFallback: false,
    keys: null,
    debugBuild: true,
    checkRequested: false,
    ...over,
  };
}

describe("statusLines", () => {
  it("leads with the refusal on a phone that cannot be a Device", () => {
    const [first] = statusLines(status({ passcodeSet: false }));
    expect(first).toMatchObject({ tone: "problem" });
    expect(first.text).toMatch(/no passcode/);
  });

  it("says where the hardware key lives once there are keys", () => {
    expect(statusLines(status({ keys: { backing: "strongbox" } }))[0]).toEqual({
      tone: "ok",
      text: "This phone holds a Device’s keys, the hardware key in StrongBox.",
    });
  });

  it("lays out the facts it decided on", () => {
    expect(statusLines(status({ hardwareKeystore: false, softwareFallback: true }))[1].text).toBe(
      "Passcode set; hardware keystore absent; software key allowed."
    );
  });
});

describe("panelAction", () => {
  it("creates, signs with a prompt, and deletes", async () => {
    const keys = standIn();
    expect(await panelAction(keys, "create")).toEqual({
      tone: "ok",
      text: "Created: the hardware key in the Secure Enclave.",
    });
    expect(await panelAction(keys, "sign")).toEqual({
      tone: "ok",
      text: "Signed, and the signature verifies against the hardware key.",
    });
    expect(keys.prompts).toBe(1);
    expect(await panelAction(keys, "delete")).toEqual({ tone: "ok", text: "Deleted." });
    expect(await panelAction(keys, "sign")).toMatchObject({ tone: "problem", text: expect.stringMatching(/holds no keys/) });
  });

  it("says a signature that does not verify is wrong", async () => {
    const keys = standIn({ faults: { signsTheBareHash: true } });
    await panelAction(keys, "create");
    expect(await panelAction(keys, "sign")).toMatchObject({ tone: "problem", text: expect.stringMatching(/does not verify/) });
  });

  it("passes the refusal through in words", async () => {
    expect((await panelAction(standIn({ passcodeSet: false }), "create")).text).toMatch(/^Refused: This phone has no passcode/);
    const keys = standIn();
    await panelAction(keys, "create");
    expect((await panelAction(keys, "create")).text).toMatch(/already holds a Device’s keys/);
  });

  it("takes a dismissed prompt calmly", async () => {
    const keys = standIn();
    await panelAction(keys, "create");
    keys.sign = () => Promise.reject(refused("cancelled"));
    expect(await panelAction(keys, "sign")).toEqual({ tone: "muted", text: "Not signed: the prompt was dismissed." });
  });
});
