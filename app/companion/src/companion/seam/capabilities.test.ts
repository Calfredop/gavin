// A store-distributed shell and a Workstation-served bundle update on
// different schedules (ADR 0005), so either end can be the older one.
// The capabilities query is how that stays a missing button instead of a
// broken page.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as backend from "$lib/core/backend";
import { listen } from "@tauri-apps/api/event";
import {
  CHANNEL_VERSION,
  CORE_MESSAGES,
  MESSAGE_TYPES,
  readWorkstationMessage,
} from "$companion/channel/messages";
import { loopback } from "$companion/channel/port";
import { createDemoWorkstation } from "$companion/demo/workstation";
import { channel, connectChannel, disconnectChannel } from "$companion/remote/connection";
import { connectDemo, settle } from "$companion/testing/demoBench";

afterEach(() => disconnectChannel());

describe("what the Demo Workstation says it carries", () => {
  it("is the whole message set, at this build's version, as the demo", async () => {
    connectDemo();
    expect(await channel()!.capabilities()).toEqual({
      version: CHANNEL_VERSION,
      messages: [...MESSAGE_TYPES],
      workstation: { id: "demo", name: "Demo Workstation", demo: true },
    });
  });
});

describe("a shell older than the bundle", () => {
  it("is asked nothing it does not know, and the bundle is told so", async () => {
    const demo = connectDemo({ messages: CORE_MESSAGES });
    const client = channel()!;

    expect(await client.supports("return-to-hub")).toBe(false);
    expect(await client.supports("open-external")).toBe(false);
    expect(await client.returnToHub()).toBe(false);
    expect(await client.openExternal("https://example.com")).toBe(false);

    await settle();
    expect(demo.received().map((m) => m.type)).toEqual(["capabilities"]);
  });

  it("still carries everything the bundle cannot work without", async () => {
    const demo = connectDemo({ messages: CORE_MESSAGES });
    const heard = vi.fn();
    await listen("cwd-changed", heard);
    demo.emit("cwd-changed", ["s-atlas-auth", "/tmp"]);
    await settle();

    expect(heard).toHaveBeenCalledTimes(1);
    expect((await backend.getWorkspacesState()).workspaces).toHaveLength(3);
  });

  it("that cannot even answer the question is taken to carry the core set", async () => {
    connectDemo({ messages: CORE_MESSAGES.filter((m) => m !== "capabilities") });
    const client = channel()!;
    expect((await client.capabilities()).messages).toEqual([...CORE_MESSAGES]);
    expect(await client.returnToHub()).toBe(false);
    expect((await backend.getWorkspacesState()).workspaces).toHaveLength(3);
  });
});

describe("a bundle newer than the Workstation's end", () => {
  /// Posts one raw message and returns what came back for it.
  async function ask(message: Record<string, unknown>): Promise<unknown[]> {
    const port = loopback(createDemoWorkstation());
    const replies: unknown[] = [];
    port.receive((raw) => {
      const read = readWorkstationMessage(raw);
      replies.push(read.kind === "message" ? read.message : read);
    });
    port.post(JSON.stringify(message));
    await settle();
    return replies;
  }

  it("is told `unsupported` for a type this end has never heard of", async () => {
    expect(await ask({ v: 4, type: "share-sheet", id: 7, title: "x" })).toEqual([
      { v: CHANNEL_VERSION, type: "result", id: 7, ok: false, error: "share-sheet", code: "unsupported" },
    ]);
  });

  it("is answered on the types this end does know, whatever version it claims", async () => {
    expect(await ask({ v: 4, type: "invoke", id: 8, cmd: "get_bootstrap_error", args: {}, trace: "abc" })).toEqual([
      { v: CHANNEL_VERSION, type: "result", id: 8, ok: true, value: null },
    ]);
  });

  it("is not answered at all for what cannot be answered: there is no id to answer to", async () => {
    expect(await ask({ v: 4, type: "telemetry", samples: [1, 2, 3] })).toEqual([]);
  });

  it("is told what was wrong with a message it got wrong", async () => {
    expect(await ask({ v: CHANNEL_VERSION, type: "invoke", id: 9 })).toEqual([
      { v: CHANNEL_VERSION, type: "result", id: 9, ok: false, error: "invoke without a command" },
    ]);
  });

  it("keeps the channel: an unknown message costs the one after it nothing", async () => {
    const demo = createDemoWorkstation();
    const port = loopback(demo);
    const client = connectChannel({
      post: (raw) => port.post(raw),
      receive: (h) => port.receive(h),
    });
    port.post(JSON.stringify({ v: 4, type: "share-sheet", id: 999_999, title: "x" }));
    await settle();
    await expect(client.invoke("get_bootstrap_error")).resolves.toBeNull();
  });
});
