import { afterEach, describe, expect, it } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CORE_MESSAGES } from "$companion/channel/messages";
import { disconnectChannel } from "$companion/remote/connection";
import { connectDemo, settle } from "$companion/testing/demoBench";

afterEach(() => disconnectChannel());

describe("opening a link, as the desktop's modules ask for it", () => {
  it("is the channel's own message, not a command sent to the desk", async () => {
    const demo = connectDemo();
    await openUrl("https://example.com/docs");
    expect(demo.received().filter((m) => m.type !== "capabilities")).toEqual([
      expect.objectContaining({ type: "open-external", url: "https://example.com/docs" }),
    ]);
    expect(demo.commands()).toEqual([]);
  });

  it("takes a URL object as the desktop's callers pass one", async () => {
    const demo = connectDemo();
    await openUrl(new URL("https://example.com/a b"));
    expect(demo.received().some((m) => m.type === "open-external" && m.url === "https://example.com/a%20b")).toBe(
      true
    );
  });

  it("rejects, having sent nothing, on a shell that cannot open links", async () => {
    const demo = connectDemo({ messages: CORE_MESSAGES });
    await expect(openUrl("https://example.com/docs")).rejects.toBe(
      "this Companion cannot open https://example.com/docs"
    );
    await settle();
    expect(demo.received().some((m) => m.type === "open-external")).toBe(false);
  });

  it("rejects what is not a web link", async () => {
    connectDemo();
    await expect(openUrl("file:///etc/passwd")).rejects.toMatch(/cannot open/);
  });

  it("rejects when nothing is connected", async () => {
    await expect(openUrl("https://example.com")).rejects.toBe("the channel is not connected");
  });
});
