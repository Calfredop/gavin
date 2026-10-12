// The two acts the channel carries that are not the Workstation's at all:
// opening a link and going back to the hub belong to whoever HOSTS the
// channel -- the shell on a phone, the page itself in a desktop browser.
// The Demo Workstation answers them through its host, and says it carries
// only the ones its host can perform.
import { describe, expect, it, vi } from "vitest";
import { createChannelClient } from "$companion/channel/client";
import { CORE_MESSAGES, MESSAGE_TYPES } from "$companion/channel/messages";
import { loopback } from "$companion/channel/port";
import { createDemoWorkstation } from "$companion/demo/workstation";

describe("the acts a Demo Workstation's host performs", () => {
  it("are both carried, and both done, when nobody says otherwise", async () => {
    const client = createChannelClient(loopback(createDemoWorkstation()));
    expect((await client.capabilities()).messages).toEqual([...MESSAGE_TYPES]);
    await expect(client.openExternal("https://example.com")).resolves.toBe(true);
    await expect(client.returnToHub()).resolves.toBe(true);
  });

  it("are handed to the host", async () => {
    const openExternal = vi.fn();
    const returnToHub = vi.fn();
    const client = createChannelClient(loopback(createDemoWorkstation({ host: { openExternal, returnToHub } })));

    await client.openExternal("https://example.com/docs");
    await client.returnToHub();

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs");
    expect(returnToHub).toHaveBeenCalledTimes(1);
  });

  it("are carried only where the host can perform them", async () => {
    const client = createChannelClient(
      loopback(createDemoWorkstation({ host: { openExternal: () => {} } }))
    );
    const { messages } = await client.capabilities();
    expect(messages).toContain("open-external");
    expect(messages).not.toContain("return-to-hub");
    expect(await client.returnToHub()).toBe(false);
  });

  it("are not carried at all by a host that can perform neither", async () => {
    const client = createChannelClient(loopback(createDemoWorkstation({ host: {} })));
    expect((await client.capabilities()).messages).toEqual([...CORE_MESSAGES, "connection"]);
  });

  it("are refused when the host fails at one", async () => {
    const client = createChannelClient(
      loopback(
        createDemoWorkstation({
          host: {
            openExternal: () => {
              throw new Error("the browser blocked the window");
            },
          },
        })
      )
    );
    await expect(client.openExternal("https://example.com")).resolves.toBe(false);
  });

  it("yield to an explicit list, which is how a suite plays an older shell", async () => {
    const returnToHub = vi.fn();
    const demo = createDemoWorkstation({ messages: CORE_MESSAGES, host: { returnToHub } });
    const client = createChannelClient(loopback(demo));
    expect((await client.capabilities()).messages).toEqual([...CORE_MESSAGES]);
    expect(await client.returnToHub()).toBe(false);
    expect(returnToHub).not.toHaveBeenCalled();
  });
});
