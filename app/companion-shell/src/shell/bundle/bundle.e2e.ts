// The served bundle, in Node, end to end: the shell's own modules and the
// real Companion core over Node's WebSocket, against a real Workstation
// -- a daemon behind a Relay (`scripts/devstack.mjs`) whose desk serves a
// bundle the desktop's own packer and signer made -- and then the
// channel's `invoke` and `listen` over that same connection, through the
// daemon's forwarding to the desk. Not part of `companion-shell:test`: it
// needs the binaries built and takes seconds. `scripts/pair.sh node`
// runs it, or alone:
//
//   GAVIN_E2E=1 npx vitest run src/shell/bundle/bundle.e2e.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import { readyBundle, type BundleStore } from "$shell/bundle/bundle";
import { BundleError, BUNDLE_CHUNK_MAX } from "$shell/bundle/manifest";
import { createShellChannel } from "$shell/channel/shellChannel";
import { loadCore, type BundleFile, type CoreModule } from "$shell/core/core";
import { keepPairing, type PairedWorkstation } from "$shell/hub/paired";
import { createUnlockedHub, type UnlockedHub } from "$shell/hub/unlockedHub";
import { pair } from "$shell/pairing/pairing";
import { webSocketOpener, type WebSocketConstructor } from "$shell/pairing/relaySocket";
import { coreWasm, readFixture } from "$shell/testing/coreWasm";
import { softwarePhone, startStack, until, type App, type Stack } from "$shell/testing/e2ePhone";
import { workstationEndpoint } from "$shell/visit/workstationEndpoint";
import { createChannelClient } from "$companion/channel/client";
import type { ChannelPort } from "$companion/channel/port";

/// The desktop's packer and signer, as `stage-companion.mjs` runs them.
interface Packer {
  pack(files: Array<{ path: string; data: Uint8Array }>): Uint8Array;
  sign(archive: Uint8Array, seedHex: string, gavinVersion: string): { hash: string; signer: string; size: number };
  publicKeyOf(seedHex: string): string;
}

let stack: Stack;
let core: CoreModule;
let phone: Awaited<ReturnType<typeof softwarePhone>>;
let packer: Packer;
let record: PairedWorkstation;
let hub: UnlockedHub;
let app: App;

const DEV_SEED = "3c".repeat(32);
const PUBLISHER_SEED = "5e".repeat(32);

function mapStore(): BundleStore & { files: Map<string, BundleFile[]> } {
  const files = new Map<string, BundleFile[]>();
  return {
    files,
    installed: async (hash) => files.has(hash),
    install: async (hash, list) => void files.set(hash, list),
    prune: async (keep) => {
      for (const hash of [...files.keys()]) if (!keep.includes(hash)) files.delete(hash);
    },
  };
}

/// A bundle the desk serves: the fixture's files plus one big enough
/// that the fetch has to loop, signed by `seed`.
function bundleOf(seed: string, extra: Array<{ path: string; data: Uint8Array }> = []) {
  const fixture = readFixture();
  const files = fixture.files.map((path) => ({ path, data: new Uint8Array(0) }));
  // The fixture's contents are in its archive; the paths are enough here.
  const big = new Uint8Array(BUNDLE_CHUNK_MAX + 4321).map((_, i) => i % 253);
  const all = [{ path: "index.html", data: new TextEncoder().encode("<!doctype html><title>e2e</title>") }, { path: "_app/big.js", data: big }, ...extra];
  void files;
  const archive = packer.pack(all);
  const manifest = packer.sign(archive, seed, "e2e");
  return { manifest, archive, files: all };
}

beforeAll(async () => {
  const bundleModule = new URL("../../../../src-tauri/companion-bundle.mjs", import.meta.url).href;
  packer = (await import(/* @vite-ignore */ bundleModule)) as Packer;
  stack = await startStack();
  core = await loadCore(coreWasm());
  phone = await softwarePhone();
}, 90_000);

afterAll(async () => {
  hub?.dispose();
  await stack?.stop();
});

describe("a served bundle against a real Workstation", () => {
  const connection = () => hub.connectionSource(record.id).current();

  it("pairs, unlocks, and connects", async () => {
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
    record = { ...keepPairing(done.workstation, [], Date.now()), name: "Studio" };

    hub = createUnlockedHub({
      keys: phone.unlock,
      core: async () => core,
      open: webSocketOpener(WebSocket as unknown as WebSocketConstructor),
      random: (n) => crypto.getRandomValues(new Uint8Array(n)),
      hub: { pollMs: 500, reconnect: { floorMs: 200, ceilingMs: 1_000, settledMs: 60_000 } },
    });
    hub.setPaired([record]);
    await hub.start();
    await until("the Workstation to connect", () => connection() !== null);
  }, 90_000);

  it("says so when the desktop app is not running, and when it carries no bundle", async () => {
    const store = mapStore();
    await expect(readyBundle({ connection: connection()!, store, core: async () => core, trusted: [] })).rejects.toThrow(
      /desktop app is not running/
    );
    const bare = await stack.desk.startApp([], { bundle: null });
    await until("the desk to be ready", () => get(hub.live)[record.id]?.state === "ready");
    await expect(readyBundle({ connection: connection()!, store, core: async () => core, trusted: [] })).rejects.toThrow(
      /carries no UI/
    );
    bare.quit();
    await until("the desk to be gone", () => get(hub.live)[record.id]?.state === "desktop-app-not-running");
  }, 30_000);

  it("fetches a dev-signed bundle in chunks, verifies it in the core, installs it, and then hits the cache", async () => {
    const served = bundleOf(DEV_SEED);
    app = await stack.desk.startApp([], { bundle: served });
    await until("the desk to be ready", () => get(hub.live)[record.id]?.state === "ready");
    const store = mapStore();
    const said: string[] = [];
    const devKey = packer.publicKeyOf(DEV_SEED);
    const publisherKey = packer.publicKeyOf(PUBLISHER_SEED);

    const first = await readyBundle({
      connection: connection()!,
      store,
      core: async () => core,
      trusted: [publisherKey, devKey],
      say: (t) => said.push(t),
    });
    expect(first.fetched).toBe(true);
    expect(first.hash).toBe(served.manifest.hash);
    expect(said.some((t) => t.startsWith("Fetching its UI…"))).toBe(true);
    const installed = store.files.get(served.manifest.hash)!;
    expect(installed.map((f) => f.path)).toEqual(["_app/big.js", "index.html"]);
    expect(Uint8Array.from(atob(installed[0].data), (c) => c.charCodeAt(0))).toEqual(served.files[1].data);

    const again = await readyBundle({ connection: connection()!, store, core: async () => core, trusted: [devKey] });
    expect(again.fetched).toBe(false);
    expect(again.hash).toBe(served.manifest.hash);
  }, 60_000);

  it("a store build refuses the dev-signed bundle, before fetching it", async () => {
    const store = mapStore();
    await expect(
      readyBundle({ connection: connection()!, store, core: async () => core, trusted: [packer.publicKeyOf(PUBLISHER_SEED)] })
    ).rejects.toThrow(/does not trust/);
    await expect(readyBundle({ connection: connection()!, store, core: async () => core, trusted: [] })).rejects.toThrow(
      BundleError
    );
    expect(store.files.size).toBe(0);
  }, 30_000);

  it("a Workstation upgrade serves a new hash, which is fetched; a bundle with a bad signature is refused", async () => {
    const store = mapStore();
    const devKey = packer.publicKeyOf(DEV_SEED);
    const before = await readyBundle({ connection: connection()!, store, core: async () => core, trusted: [devKey] });
    const upgraded = bundleOf(DEV_SEED, [{ path: "_app/new.js", data: new TextEncoder().encode("1") }]);
    expect(upgraded.manifest.hash).not.toBe(before.hash);
    app.setBundle(upgraded);
    const after = await readyBundle({ connection: connection()!, store, core: async () => core, trusted: [devKey] });
    expect(after.fetched).toBe(true);
    expect(after.hash).toBe(upgraded.manifest.hash);
    expect([...store.files.keys()]).toEqual([before.hash, upgraded.manifest.hash]);

    // A manifest whose signature is not over this archive.
    const forged = { ...upgraded, manifest: { ...upgraded.manifest, signature: `${"0".repeat(2)}${(upgraded.manifest as { signature: string }).signature.slice(2)}` } };
    app.setBundle(forged);
    await expect(readyBundle({ connection: connection()!, store: mapStore(), core: async () => core, trusted: [devKey] })).rejects.toThrow(
      /signature/
    );
    app.setBundle(upgraded);
  }, 60_000);

  it("carries invoke and listen over the same connection, through forwarding, to the desk", async () => {
    app.quit();
    await until("the desk to be gone", () => get(hub.live)[record.id]?.state === "desktop-app-not-running");
    app = await stack.desk.startApp([], {
      bundle: bundleOf(DEV_SEED),
      commands: (command, args) => {
        if (command === "get_workspaces_state") return { workspaces: [{ id: "w1", name: "Atlas", rootPath: "/atlas" }], removedWorkspaces: [] };
        if (command === "get_board") return { columns: [], labels: [], cardSessions: [], asked: args };
        throw new Error(`no such command: ${command}`);
      },
    });
    await until("the desk to be ready", () => get(hub.live)[record.id]?.state === "ready");

    // The channel, as a visit joins it: the shell's end over the
    // Workstation's endpoint, and the bundle's client on a port that
    // crosses as strings.
    const endpoint = workstationEndpoint(hub.connectionSource(record.id));
    const stop = endpoint.start!();
    let toBundle: ((raw: string) => void) | null = null;
    const channel = createShellChannel({
      origin: "gavin-bundle://ws-e2e",
      workstation: { id: record.id, name: record.name, demo: false },
      landing: { workspace: "w1", target: { kind: "card", path: "/atlas/.gavin-root/plans/a.md" } },
      endpoint: endpoint.endpoint,
      acts: { openExternal: () => {}, returnToHub: () => {} },
      deliver: (raw) => toBundle?.(raw),
    });
    const port: ChannelPort = {
      post: (raw) => queueMicrotask(() => channel.receive(raw, "gavin-bundle://ws-e2e")),
      receive: (handler) => {
        toBundle = handler;
        return () => (toBundle = null);
      },
    };
    const bundle = createChannelClient(port);

    const capabilities = await bundle.capabilities();
    expect(capabilities.workstation).toEqual({ id: record.id, name: "Studio", demo: false });
    expect(capabilities.landing).toEqual({ workspace: "w1", target: { kind: "card", path: "/atlas/.gavin-root/plans/a.md" } });

    const data = await bundle.invoke<{ workspaces: Array<{ name: string }> }>("get_workspaces_state");
    expect(data.workspaces[0].name).toBe("Atlas");
    const board = await bundle.invoke<{ asked: unknown }>("get_board", { workspaceId: "w1" });
    expect(board.asked).toEqual({ workspaceId: "w1" });
    await expect(bundle.invoke("no_such_command")).rejects.toThrow(/unknown desktop command/);
    // A layout-saving command is refused by the daemon's table, before
    // it reaches the desk.
    await expect(bundle.invoke("set_workspaces_state", {})).rejects.toThrow(/may not invoke/);
    expect(app.received().map((r) => r.command)).toEqual(["get_workspaces_state", "get_board"]);

    const heard: unknown[] = [];
    const unlisten = await bundle.listen("session-status-changed", (payload) => heard.push(payload));
    await app.offer("session-status-changed", ["s1", "idle"]);
    await until("the event to reach the bundle", () => heard.length === 1, 10_000);
    expect(heard[0]).toEqual(["s1", "idle"]);
    unlisten();
    await app.offer("session-status-changed", ["s1", "working"]);
    await new Promise((r) => setTimeout(r, 300));
    expect(heard).toHaveLength(1);

    stop();
    channel.close();
  }, 60_000);
});
