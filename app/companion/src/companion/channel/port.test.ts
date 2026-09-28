import { describe, expect, it, vi } from "vitest";
import { expectOnce } from "$companion/testing/expectOnce";
import { loopback, shellPort, SHELL_CHANNEL_NAME, type ChannelEndpoint } from "$companion/channel/port";

/// Lets every queued crossing land.
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("the in-page route to a Workstation", () => {
  it("carries a message to the endpoint and its reply back", async () => {
    const endpoint: ChannelEndpoint = {
      receive: (raw, reply) => reply(`heard ${raw}`),
    };
    const port = loopback(endpoint);
    const heard = vi.fn();
    port.receive(heard);
    port.post("hello");
    await settle();
    expectOnce(heard, "heard hello");
  });

  it("never answers before `post` has returned, as no real channel would", async () => {
    const endpoint: ChannelEndpoint = { receive: (raw, reply) => reply(raw) };
    const port = loopback(endpoint);
    const heard = vi.fn();
    port.receive(heard);
    port.post("hello");
    expect(heard).not.toHaveBeenCalled();
    await settle();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("keeps a reply route open for what the endpoint says later, unasked", async () => {
    let later: ((raw: string) => void) | null = null;
    const endpoint: ChannelEndpoint = {
      receive: (_raw, reply) => {
        later = reply;
      },
    };
    const port = loopback(endpoint);
    const heard = vi.fn();
    port.receive(heard);
    port.post("listen");
    await settle();
    later!("an event");
    await settle();
    expectOnce(heard, "an event");
  });

  it("delivers nothing once the receiver is torn down", async () => {
    const endpoint: ChannelEndpoint = { receive: (raw, reply) => reply(raw) };
    const port = loopback(endpoint);
    const heard = vi.fn();
    const stop = port.receive(heard);
    port.post("hello");
    stop();
    await settle();
    expect(heard).not.toHaveBeenCalled();
  });
});

describe("the route the shell provides", () => {
  it("is absent in a page the shell did not prepare", () => {
    expect(shellPort({})).toBeNull();
    expect(shellPort({ [SHELL_CHANNEL_NAME]: "not a channel" })).toBeNull();
    expect(shellPort({ [SHELL_CHANNEL_NAME]: { onmessage: null } })).toBeNull();
  });

  it("posts strings through the shell's object", () => {
    const channel = { postMessage: vi.fn(), onmessage: null };
    shellPort({ [SHELL_CHANNEL_NAME]: channel })!.post('{"type":"invoke"}');
    expectOnce(channel.postMessage, '{"type":"invoke"}');
  });

  it("hands over the data of each message the shell delivers", () => {
    const channel: { postMessage: () => void; onmessage: ((e: { data: unknown }) => void) | null } = {
      postMessage: () => {},
      onmessage: null,
    };
    const heard = vi.fn();
    shellPort({ [SHELL_CHANNEL_NAME]: channel })!.receive(heard);
    channel.onmessage!({ data: '{"type":"result"}' });
    expectOnce(heard, '{"type":"result"}');
  });

  it("drops a delivery that is not a string: the channel carries nothing else", () => {
    const channel: { postMessage: () => void; onmessage: ((e: { data: unknown }) => void) | null } = {
      postMessage: () => {},
      onmessage: null,
    };
    const heard = vi.fn();
    shellPort({ [SHELL_CHANNEL_NAME]: channel })!.receive(heard);
    channel.onmessage!({ data: { type: "result" } });
    channel.onmessage!({ data: undefined });
    expect(heard).not.toHaveBeenCalled();
  });

  it("stops hearing the shell once torn down", () => {
    const channel: { postMessage: () => void; onmessage: ((e: { data: unknown }) => void) | null } = {
      postMessage: () => {},
      onmessage: null,
    };
    const stop = shellPort({ [SHELL_CHANNEL_NAME]: channel })!.receive(() => {});
    stop();
    expect(channel.onmessage).toBeNull();
  });
});
