import { describe, expect, it, vi } from "vitest";
import { SHELL_CHANNEL_NAME } from "$companion/channel/port";
import { DEMO_PACE_MS, deviceStorage, openChannel } from "$companion/state/entry";

describe("where the bundle's channel leads", () => {
  it("is the shell's, in a page the shell prepared, with no demo made", () => {
    const shell = { postMessage: vi.fn(), onmessage: null };
    const opened = openChannel({ [SHELL_CHANNEL_NAME]: shell });
    expect(opened.demo).toBeNull();
    opened.port.post("hello");
    expect(shell.postMessage).toHaveBeenCalledWith("hello");
  });

  it("is a Demo Workstation in the page itself, where there is no shell", async () => {
    const opened = openChannel({});
    expect(opened.demo).not.toBeNull();
    const heard = vi.fn();
    opened.port.receive(heard);
    opened.port.post(JSON.stringify({ v: 1, type: "capabilities", id: 1 }));
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    expect(JSON.parse(heard.mock.calls[0][0]).value.workstation.demo).toBe(true);
  });

  it("paces the demo slowly enough to read", () => {
    expect(DEMO_PACE_MS).toBeGreaterThanOrEqual(3000);
  });
});

describe("the Device's storage", () => {
  it("is the page's own", () => {
    const local = { getItem: () => null, setItem: () => {} };
    expect(deviceStorage({ localStorage: local })).toBe(local);
  });

  it("is nothing where the page is given none, or is refused it", () => {
    expect(deviceStorage({})).toBeNull();
    const refused = Object.defineProperty({}, "localStorage", {
      get() {
        throw new Error("The operation is insecure.");
      },
    });
    expect(deviceStorage(refused)).toBeNull();
  });
});

describe("a page that hosts its own demo", () => {
  async function capabilitiesOf(scope: object): Promise<{ messages: string[] }> {
    const opened = openChannel(scope);
    const heard = vi.fn();
    opened.port.receive(heard);
    opened.port.post(JSON.stringify({ v: 1, type: "capabilities", id: 1 }));
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    return JSON.parse(heard.mock.calls[0][0]).value;
  }

  it("has no hub to go back to, and says so", async () => {
    const { messages } = await capabilitiesOf({ open: () => null });
    expect(messages).not.toContain("return-to-hub");
  });

  it("opens a link in a tab of its own, with no way back into the page", async () => {
    const open = vi.fn(() => ({}));
    const opened = openChannel({ open });
    const heard = vi.fn();
    opened.port.receive(heard);
    opened.port.post(JSON.stringify({ v: 1, type: "open-external", id: 2, url: "https://example.com/docs" }));
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(1));

    expect(open).toHaveBeenCalledWith("https://example.com/docs", "_blank", "noopener,noreferrer");
    expect(JSON.parse(heard.mock.calls[0][0]).ok).toBe(true);
  });

  it("cannot open links where the page cannot open windows", async () => {
    const { messages } = await capabilitiesOf({});
    expect(messages).not.toContain("open-external");
  });
});
