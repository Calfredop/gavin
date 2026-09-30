// The live hub, in Node: the shell's own Unlock, live hub, connection and
// pairing modules, and the real Companion core, over Node's WebSocket,
// against two real Workstations -- two daemons, each behind its own Relay
// (`scripts/devstack.mjs`). Not part of `companion-shell:test`: it needs
// the binaries built and takes seconds. `scripts/pair.sh node` runs it
// with the pairing's, or alone:
//
//   GAVIN_E2E=1 npx vitest run src/shell/hub/hub.e2e.ts
//
// What stands in for the phone is its hardware key and its Unlock: a
// P-256 key in WebCrypto that signs only while "unlocked", and counts
// how often the owner was asked. Everything else is what runs on the
// phone.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import { loadCore, type CoreModule } from "$shell/core/core";
import { combinedInbox } from "$shell/hub/inbox";
import { keepPairing, type PairedWorkstation } from "$shell/hub/paired";
import { createUnlockedHub, type UnlockedHub } from "$shell/hub/unlockedHub";
import type { LiveState } from "$shell/hub/live";
import { pair } from "$shell/pairing/pairing";
import { webSocketOpener, type OpenRelaySocket, type RelaySocket, type WebSocketConstructor } from "$shell/pairing/relaySocket";
import { coreWasm } from "$shell/testing/coreWasm";
import { softwarePhone, startStack, until, type App, type Stack } from "$shell/testing/e2ePhone";

let studio: Stack;
let laptop: Stack;
let core: CoreModule;
let phone: Awaited<ReturnType<typeof softwarePhone>>;
let records: PairedWorkstation[] = [];

async function pairWith(stack: Stack, name: string): Promise<PairedWorkstation> {
  const qr = await stack.desk.offer();
  await stack.registered(qr);
  const outcome = pair(qr, {
    core,
    keys: phone.pairing,
    open: webSocketOpener(WebSocket as unknown as WebSocketConstructor),
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    deviceName: "Scripted phone",
    onPhase: () => {},
  });
  const asked = await stack.desk.asked(30_000);
  await stack.desk.confirm(asked.device_id);
  const done = await outcome;
  if (done.outcome !== "paired") throw new Error(`${JSON.stringify(done)}\n${stack.daemonLog()}`);
  const record = { ...keepPairing(done.workstation, records, Date.now()), name };
  records = [...records, record];
  return record;
}

beforeAll(async () => {
  [studio, laptop] = await Promise.all([startStack(), startStack()]);
  core = await loadCore(coreWasm());
  phone = await softwarePhone();
}, 90_000);

afterAll(async () => {
  await Promise.all([studio?.stop(), laptop?.stop()]);
});

describe("the live hub against two real Workstations", () => {
  let hub: UnlockedHub;
  const sockets: Array<{ url: string; socket: RelaySocket }> = [];
  let STUDIO: PairedWorkstation;
  let LAPTOP: PairedWorkstation;
  const live = (): Record<string, LiveState> => get(hub.live);
  const stateOf = (ws: PairedWorkstation) => live()[ws.id]?.state;

  it("pairs one phone with both, one Device identity for both", async () => {
    STUDIO = await pairWith(studio, "Studio");
    LAPTOP = await pairWith(laptop, "Laptop");
    expect(STUDIO.id).not.toBe(LAPTOP.id);
  }, 90_000);

  it("unlocks once, and both Workstations connect and label what they have waiting", async () => {
    const item = (id: string, text: string) => ({
      id,
      workspace: "ws-1",
      kind: "waiting",
      text,
      target: { kind: "session", id: `s-${id}` },
    });
    const studioApp = await studio.desk.startApp([item("w1", "feat-x asks which migration to keep"), item("w2", "a human test is filed")]);
    const laptopApp = await laptop.desk.startApp([item("w1", "the rail stopped")]);
    apps.studio = studioApp;
    apps.laptop = laptopApp;

    const open: OpenRelaySocket = async (url, timeoutMs) => {
      const socket = await webSocketOpener(WebSocket as unknown as WebSocketConstructor)(url, timeoutMs);
      sockets.push({ url, socket });
      return socket;
    };
    hub = createUnlockedHub({
      keys: phone.unlock,
      core: async () => core,
      open,
      random: (n) => crypto.getRandomValues(new Uint8Array(n)),
      hub: { pollMs: 500, reconnect: { floorMs: 200, ceilingMs: 1_000, settledMs: 60_000 } },
    });
    hub.setPaired(records);
    await hub.start();

    await until("both Workstations to be ready", () => stateOf(STUDIO) === "ready" && stateOf(LAPTOP) === "ready");
    expect(phone.counts.prompts).toBe(1);
    expect(phone.counts.silentSigns).toBe(2);
    expect(combinedInbox(records, live()).map((r) => [r.workstationName, r.text])).toEqual([
      ["Studio", "feat-x asks which migration to keep"],
      ["Studio", "a human test is filed"],
      ["Laptop", "the rail stopped"],
    ]);
  }, 60_000);

  it("reconnects a dropped connection without asking the owner again", async () => {
    const before = phone.counts.silentSigns;
    const studioLeg = sockets.filter((s) => STUDIO.relays.includes(s.url)).pop()!;
    studioLeg.socket.close();
    await until("the Studio to drop", () => stateOf(STUDIO) !== "ready", 10_000);
    await until("the Studio to be ready again", () => stateOf(STUDIO) === "ready", 20_000);
    expect(phone.counts.prompts).toBe(1);
    expect(phone.counts.silentSigns).toBe(before + 1);
    expect(stateOf(LAPTOP)).toBe("ready");
  }, 30_000);

  it("takes an item dealt with at the desk off the phone", async () => {
    apps.studio!.setItems([]);
    await until("the Studio's items to go", () => {
      const s = live()[STUDIO.id];
      return s?.state === "ready" && s.items.length === 0;
    });
    expect(combinedInbox(records, live()).map((r) => r.workstationName)).toEqual(["Laptop"]);
  }, 20_000);

  it("shows a Workstation whose desktop app quit, and adds nothing from it", async () => {
    apps.laptop!.quit();
    await until("the Laptop's desktop app to read as not running", () => stateOf(LAPTOP) === "desktop-app-not-running");
    expect(combinedInbox(records, live())).toEqual([]);
  }, 20_000);

  it("shows a Workstation that left its Relay as asleep, and adds nothing from it", async () => {
    apps.studio!.setItems([{ id: "w3", workspace: "ws-1", kind: "failed", text: "an agent failed", target: { kind: "session", id: "s3" } }]);
    await until("the Studio's new item", () => combinedInbox(records, live()).length === 1);
    await studio.desk.remoteAccess(false);
    await until("the Studio to read as asleep", () => stateOf(STUDIO) === "asleep", 30_000);
    expect(combinedInbox(records, live())).toEqual([]);
    expect(phone.counts.prompts).toBe(1);
  }, 40_000);

  it("locks, dropping every connection, when the app goes to the background; asks again in front", async () => {
    phone.emit("background");
    await until("everything to lock", () => stateOf(STUDIO) === "locked" && stateOf(LAPTOP) === "locked", 5_000);
    expect(get(hub.unlock)).toEqual({ state: "locked", why: "background" });

    await studio.desk.remoteAccess(true);
    phone.emit("foreground");
    await until("the Laptop to answer again", () => stateOf(LAPTOP) === "desktop-app-not-running", 20_000);
    expect(phone.counts.prompts).toBe(2);
    await hub.dispose();
  }, 40_000);
});

const apps: { studio?: App; laptop?: App } = {};
