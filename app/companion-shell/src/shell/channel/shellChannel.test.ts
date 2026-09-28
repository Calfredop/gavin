import { describe, expect, it, vi } from "vitest";
import { createChannelClient } from "$companion/channel/client";
import { CHANNEL_VERSION, MESSAGE_TYPES, type Capabilities } from "$companion/channel/messages";
import type { ChannelEndpoint, ChannelPort } from "$companion/channel/port";
import { createDemoWorkstation } from "$companion/demo/workstation";
import type { WorkspacesData } from "$lib/core/workspace";
import { createShellChannel, type Drop, type ShellActs } from "$shell/channel/shellChannel";

const ORIGIN = "gavin-bundle://demo";
const DEMO_IDENTITY: Capabilities["workstation"] = { id: "demo", name: "Demo Workstation", demo: true };

/// The bundle's own channel client, talking through a shell channel to a
/// Workstation -- the whole route a bundle's call takes on a phone, minus
/// the native hop, which carries strings and nothing else.
function bench(options: { endpoint?: ChannelEndpoint; acts?: Partial<ShellActs> } = {}) {
  const endpoint = options.endpoint ?? createDemoWorkstation({ host: {} });
  const delivered: string[] = [];
  const drops: Drop[] = [];
  let toBundle: ((raw: string) => void) | null = null;
  const acts: ShellActs = {
    openExternal: vi.fn(),
    returnToHub: vi.fn(),
    ...options.acts,
  };
  const shell = createShellChannel({
    origin: ORIGIN,
    workstation: DEMO_IDENTITY,
    endpoint,
    acts,
    deliver: (raw) => {
      delivered.push(raw);
      toBundle?.(raw);
    },
    onDrop: (drop) => drops.push(drop),
  });
  const port: ChannelPort = {
    post: (raw) => queueMicrotask(() => shell.receive(raw, ORIGIN)),
    receive: (handler) => {
      toBundle = handler;
      return () => {
        toBundle = null;
      };
    },
  };
  const client = createChannelClient(port);
  return { shell, client, acts, delivered, drops, endpoint };
}

/// Lets every queued crossing and settled promise land.
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => queueMicrotask(r));
}

describe("the shell's side of the channel", () => {
  it("answers capabilities itself: the full closed set and the one Workstation it reaches", async () => {
    const forwarded: string[] = [];
    const { client } = bench({ endpoint: { receive: (raw) => forwarded.push(raw) } });
    const capabilities = await client.capabilities();
    expect(capabilities).toEqual({
      version: CHANNEL_VERSION,
      messages: [...MESSAGE_TYPES],
      workstation: DEMO_IDENTITY,
    });
    // A question about the channel, not about the desk.
    expect(forwarded).toEqual([]);
  });

  it("carries an invoke to its Workstation and the answer back", async () => {
    const { client, endpoint } = bench();
    const data = await client.invoke<WorkspacesData>("get_workspaces_state");
    expect(data.workspaces.map((w) => w.id)).toContain("demo-atlas");
    expect((endpoint as ReturnType<typeof createDemoWorkstation>).commands()).toEqual(["get_workspaces_state"]);
  });

  it("carries a Workstation's refusal back as the call's failure", async () => {
    const { client } = bench();
    await expect(client.invoke("set_workspaces_state", { data: {} })).rejects.toThrow();
  });

  it("carries listen, the events that follow, and unlisten", async () => {
    const demo = createDemoWorkstation({ host: {} });
    const { client } = bench({ endpoint: demo });
    const seen: unknown[] = [];
    const stop = await client.listen("gavin-changed", (payload) => seen.push(payload));
    expect(demo.listening("gavin-changed")).toBe(1);
    demo.emit("gavin-changed", { root: "/x" });
    await settle();
    expect(seen).toEqual([{ root: "/x" }]);
    stop();
    await settle();
    expect(demo.listening("gavin-changed")).toBe(0);
  });

  it("drops a message from another origin: not carried, not answered", async () => {
    const forwarded: string[] = [];
    const { shell, delivered, drops } = bench({ endpoint: { receive: (raw) => forwarded.push(raw) } });
    const invoke = JSON.stringify({ v: 1, type: "invoke", id: 7, cmd: "get_workspaces_state", args: {} });
    shell.receive(invoke, "gavin-bundle://other");
    shell.receive(invoke, "https://demo.bundle.gavin.invalid");
    shell.receive(invoke, "null");
    shell.receive(invoke, "");
    await settle();
    expect(forwarded).toEqual([]);
    expect(delivered).toEqual([]);
    expect(drops.map((d) => [d.reason, d.origin])).toEqual([
      ["origin", "gavin-bundle://other"],
      ["origin", "https://demo.bundle.gavin.invalid"],
      ["origin", "null"],
      ["origin", ""],
    ]);
  });

  it("drops a foreign-origin act as well: no link opens, nothing leaves", async () => {
    const { shell, acts, delivered } = bench();
    shell.receive(JSON.stringify({ v: 1, type: "open-external", id: 1, url: "https://example.com" }), "gavin-bundle://evil");
    shell.receive(JSON.stringify({ v: 1, type: "return-to-hub", id: 2 }), "gavin-bundle://evil");
    await settle();
    expect(acts.openExternal).not.toHaveBeenCalled();
    expect(acts.returnToHub).not.toHaveBeenCalled();
    expect(delivered).toEqual([]);
  });

  it("answers a type outside the closed set as unsupported, and never carries it", async () => {
    const forwarded: string[] = [];
    const { shell, delivered, drops } = bench({ endpoint: { receive: (raw) => forwarded.push(raw) } });
    shell.receive(JSON.stringify({ v: 1, type: "keys-sign", id: 3, hash: "00" }), ORIGIN);
    shell.receive(JSON.stringify({ v: 1, type: "plugin", pluginId: "Keys", methodName: "sign" }), ORIGIN);
    await settle();
    expect(forwarded).toEqual([]);
    expect(delivered.map((raw) => JSON.parse(raw))).toEqual([
      { v: CHANNEL_VERSION, type: "result", id: 3, ok: false, error: "keys-sign", code: "unsupported" },
    ]);
    // With no id there is nobody to answer.
    expect(drops.map((d) => d.reason)).toEqual(["unknown"]);
  });

  it("answers a malformed message that has an id, and drops one that has none", async () => {
    const forwarded: string[] = [];
    const { shell, delivered, drops } = bench({ endpoint: { receive: (raw) => forwarded.push(raw) } });
    shell.receive(JSON.stringify({ v: 1, type: "invoke", id: 4 }), ORIGIN);
    shell.receive("not json", ORIGIN);
    await settle();
    expect(forwarded).toEqual([]);
    expect(delivered.map((raw) => JSON.parse(raw))).toEqual([
      { v: CHANNEL_VERSION, type: "result", id: 4, ok: false, error: "invoke without a command" },
    ]);
    expect(drops.map((d) => d.reason)).toEqual(["malformed"]);
  });

  it("opens a web link through the shell, never through the Workstation", async () => {
    const forwarded: string[] = [];
    const { client, acts } = bench({ endpoint: { receive: (raw) => forwarded.push(raw) } });
    await expect(client.openExternal("https://gavin.dev/docs")).resolves.toBe(true);
    expect(acts.openExternal).toHaveBeenCalledWith("https://gavin.dev/docs");
    expect(forwarded).toEqual([]);
  });

  it("refuses to open anything that is not a web link, whoever asks", async () => {
    const { shell, acts, delivered } = bench();
    // Straight onto the wire, past the bundle client's own check.
    for (const [id, url] of [
      [1, "javascript:alert(1)"],
      [2, "file:///etc/passwd"],
      [3, "gavin-bundle://demo/index.html"],
      [4, "capacitor://localhost/"],
      [5, "not a url"],
    ] as const) {
      shell.receive(JSON.stringify({ v: 1, type: "open-external", id, url }), ORIGIN);
    }
    await settle();
    expect(acts.openExternal).not.toHaveBeenCalled();
    const answers = delivered.map((raw) => JSON.parse(raw));
    expect(answers.map((a) => [a.id, a.ok])).toEqual([
      [1, false],
      [2, false],
      [3, false],
      [4, false],
      [5, false],
    ]);
  });

  it("says a link was not opened when the system would not open it", async () => {
    const { client } = bench({
      acts: {
        openExternal: () => Promise.reject(new Error("no browser")),
      },
    });
    await expect(client.openExternal("https://gavin.dev")).resolves.toBe(false);
  });

  it("returns to the hub through the shell", async () => {
    const { client, acts } = bench();
    await expect(client.returnToHub()).resolves.toBe(true);
    expect(acts.returnToHub).toHaveBeenCalledTimes(1);
  });

  it("carries nothing once closed, either way", async () => {
    const demo = createDemoWorkstation({ host: {} });
    const { shell, client, delivered, drops } = bench({ endpoint: demo });
    await client.listen("gavin-changed", () => {});
    const before = delivered.length;
    shell.close();
    demo.emit("gavin-changed", { root: "/x" });
    shell.receive(JSON.stringify({ v: 1, type: "invoke", id: 90, cmd: "get_workspaces_state", args: {} }), ORIGIN);
    await settle();
    expect(delivered.length).toBe(before);
    expect(demo.commands()).toEqual([]);
    expect(drops.map((d) => d.reason)).toEqual(["closed"]);
  });

  it("delivers a late answer to nobody once closed", async () => {
    let answer: ((raw: string) => void) | null = null;
    const { shell, delivered } = bench({ endpoint: { receive: (_raw, reply) => (answer = reply) } });
    shell.receive(JSON.stringify({ v: 1, type: "invoke", id: 5, cmd: "slow", args: {} }), ORIGIN);
    shell.close();
    answer!(JSON.stringify({ v: 1, type: "result", id: 5, ok: true, value: 1 }));
    expect(delivered).toEqual([]);
  });

  it("lets only results and events through from the Workstation", () => {
    const { shell, delivered } = bench({
      endpoint: {
        receive: (_raw, reply) => {
          reply(JSON.stringify({ v: 1, type: "invoke", id: 1, cmd: "x", args: {} }));
          reply(JSON.stringify({ v: 1, type: "open-external", id: 2, url: "https://example.com" }));
          reply("garbage");
          reply(JSON.stringify({ v: 1, type: "result", id: 6, ok: true, value: "fine" }));
          reply(JSON.stringify({ v: 1, type: "event", listener: 6, event: "e", payload: null }));
        },
      },
    });
    shell.receive(JSON.stringify({ v: 1, type: "invoke", id: 6, cmd: "anything", args: {} }), ORIGIN);
    expect(delivered.map((raw) => JSON.parse(raw).type)).toEqual(["result", "event"]);
  });
});
