import { describe, expect, it, vi } from "vitest";
import { expectOnce } from "$companion/testing/expectOnce";
import { ChannelError, createChannelClient } from "$companion/channel/client";
import { CHANNEL_VERSION, CORE_MESSAGES, MESSAGE_TYPES } from "$companion/channel/messages";
import type { ChannelPort } from "$companion/channel/port";

// The other end, played by hand: what the client posted, and a way to
// say something back. The seam suites drive the real Demo Workstation;
// this is for the things a well-behaved end never does.
function scriptedEnd() {
  const posted: Array<Record<string, unknown>> = [];
  let handler: ((raw: string) => void) | null = null;
  const port: ChannelPort = {
    post: (raw) => void posted.push(JSON.parse(raw)),
    receive: (h) => {
      handler = h;
      return () => {
        handler = null;
      };
    },
  };
  return {
    port,
    posted,
    say(message: unknown): void {
      handler?.(typeof message === "string" ? message : JSON.stringify(message));
    },
    ok(id: unknown, value: unknown = null): void {
      this.say({ v: CHANNEL_VERSION, type: "result", id, ok: true, value });
    },
    fail(id: unknown, error: string, code?: string): void {
      this.say({ v: CHANNEL_VERSION, type: "result", id, ok: false, error, code });
    },
    /// Answers the capabilities query the way an end carrying `messages`
    /// would, whenever the client gets round to asking.
    answerCapabilities(messages: readonly string[]): void {
      const ask = posted.find((m) => m.type === "capabilities");
      if (!ask) throw new Error("the client has not asked for capabilities");
      this.ok(ask.id, {
        version: CHANNEL_VERSION,
        messages,
        workstation: { id: "ws-test", name: "Test bench", demo: false },
      });
    },
  };
}

describe("invoke", () => {
  it("posts the command and resolves with the matching result's value", async () => {
    const end = scriptedEnd();
    const client = createChannelClient(end.port);
    const answer = client.invoke<{ columns: string[] }>("get_board", { workspaceId: "w1" });
    expect(end.posted).toEqual([
      { v: CHANNEL_VERSION, type: "invoke", id: end.posted[0].id, cmd: "get_board", args: { workspaceId: "w1" } },
    ]);
    end.ok(end.posted[0].id, { columns: ["To Do"] });
    await expect(answer).resolves.toEqual({ columns: ["To Do"] });
  });

  it("sends an empty args object for a command that takes none", () => {
    const end = scriptedEnd();
    void createChannelClient(end.port).invoke("temp_dir");
    expect(end.posted[0].args).toEqual({});
  });

  it("pairs answers by id, whatever order they come back in", async () => {
    const end = scriptedEnd();
    const client = createChannelClient(end.port);
    const first = client.invoke("first");
    const second = client.invoke("second");
    end.ok(end.posted[1].id, "second's");
    end.ok(end.posted[0].id, "first's");
    await expect(first).resolves.toBe("first's");
    await expect(second).resolves.toBe("second's");
  });

  it("rejects with the Workstation's own words", async () => {
    const end = scriptedEnd();
    const answer = createChannelClient(end.port).invoke("get_board", { workspaceId: "gone" });
    end.fail(end.posted[0].id, "no such workspace");
    await expect(answer).rejects.toThrow(new ChannelError("no such workspace"));
  });

  it("rejects, rather than waiting forever, when the answer cannot be read", async () => {
    const end = scriptedEnd();
    const answer = createChannelClient(end.port).invoke("get_board");
    end.say({ v: CHANNEL_VERSION, type: "result", id: end.posted[0].id });
    await expect(answer).rejects.toThrow(/result without an outcome/);
  });

  it("ignores an answer to a question it never asked", async () => {
    const end = scriptedEnd();
    const client = createChannelClient(end.port);
    const answer = client.invoke("get_board");
    end.ok(9999, "stray");
    end.ok(end.posted[0].id, "real");
    await expect(answer).resolves.toBe("real");
  });

  it("settles a call once: a second answer to the same id changes nothing", async () => {
    const end = scriptedEnd();
    const answer = createChannelClient(end.port).invoke("get_board");
    end.ok(end.posted[0].id, "first");
    end.fail(end.posted[0].id, "late");
    await expect(answer).resolves.toBe("first");
  });
});

describe("listen", () => {
  it("resolves only once the other end has registered the listener", async () => {
    const end = scriptedEnd();
    const client = createChannelClient(end.port);
    let registered = false;
    const listening = client.listen("cwd-changed", () => {}).then(() => (registered = true));
    await Promise.resolve();
    expect(registered).toBe(false);
    expect(end.posted).toEqual([
      { v: CHANNEL_VERSION, type: "listen", id: end.posted[0].id, event: "cwd-changed" },
    ]);
    end.ok(end.posted[0].id);
    await listening;
    expect(registered).toBe(true);
  });

  it("hands each event's payload to the listener it was sent to", async () => {
    const end = scriptedEnd();
    const client = createChannelClient(end.port);
    const cwd = vi.fn();
    const status = vi.fn();
    const a = client.listen("cwd-changed", cwd);
    const b = client.listen("session-status-changed", status);
    end.ok(end.posted[0].id);
    end.ok(end.posted[1].id);
    await Promise.all([a, b]);

    end.say({
      v: CHANNEL_VERSION,
      type: "event",
      listener: end.posted[0].id,
      event: "cwd-changed",
      payload: ["s1", "/tmp"],
    });
    expectOnce(cwd, ["s1", "/tmp"]);
    expect(status).not.toHaveBeenCalled();
  });

  it("delivers an event that overtook the registration's own answer", async () => {
    const end = scriptedEnd();
    const heard = vi.fn();
    const listening = createChannelClient(end.port).listen("cwd-changed", heard);
    const id = end.posted[0].id;
    end.say({ v: CHANNEL_VERSION, type: "event", listener: id, event: "cwd-changed", payload: "early" });
    end.ok(id);
    await listening;
    expectOnce(heard, "early");
  });

  it("stops at once on unlisten, and tells the other end which listener ended", async () => {
    const end = scriptedEnd();
    const heard = vi.fn();
    const listening = createChannelClient(end.port).listen("cwd-changed", heard);
    const id = end.posted[0].id;
    end.ok(id);
    const unlisten = await listening;

    unlisten();
    end.say({ v: CHANNEL_VERSION, type: "event", listener: id, event: "cwd-changed", payload: "late" });
    expect(heard).not.toHaveBeenCalled();
    expect(end.posted[1]).toMatchObject({ type: "unlisten", listener: id });
  });

  it("tells the other end once, however many times unlisten is called", async () => {
    const end = scriptedEnd();
    const listening = createChannelClient(end.port).listen("cwd-changed", () => {});
    end.ok(end.posted[0].id);
    const unlisten = await listening;
    unlisten();
    unlisten();
    expect(end.posted.filter((m) => m.type === "unlisten")).toHaveLength(1);
  });

  it("rejects, and keeps no listener, when the other end refuses the registration", async () => {
    const end = scriptedEnd();
    const heard = vi.fn();
    const listening = createChannelClient(end.port).listen("trust-changed", heard);
    const id = end.posted[0].id;
    end.fail(id, "refused for the Remote role");
    await expect(listening).rejects.toThrow("refused for the Remote role");
    end.say({ v: CHANNEL_VERSION, type: "event", listener: id, event: "trust-changed", payload: 1 });
    expect(heard).not.toHaveBeenCalled();
  });

  it("keeps delivering to the other listeners when one of them throws", async () => {
    const end = scriptedEnd();
    const client = createChannelClient(end.port);
    const heard = vi.fn();
    const a = client.listen("cwd-changed", () => {
      throw new Error("a surface broke");
    });
    const b = client.listen("cwd-changed", heard);
    end.ok(end.posted[0].id);
    end.ok(end.posted[1].id);
    await Promise.all([a, b]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const m of end.posted.slice(0, 2)) {
      end.say({ v: CHANNEL_VERSION, type: "event", listener: m.id, event: "cwd-changed", payload: 1 });
    }
    expect(heard).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("what the other end says that this build cannot read", () => {
  it("is dropped, and the channel carries on", async () => {
    const end = scriptedEnd();
    const client = createChannelClient(end.port);
    const answer = client.invoke("get_board");
    end.say("not json at all");
    end.say({ v: 9, type: "presence", devices: ["phone"] });
    end.say({ v: CHANNEL_VERSION, type: "event", listener: 4242, event: "nobody-asked", payload: 1 });
    end.ok(end.posted[0].id, "still here");
    await expect(answer).resolves.toBe("still here");
  });
});

describe("capabilities", () => {
  it("asks once and remembers", async () => {
    const end = scriptedEnd();
    const client = createChannelClient(end.port);
    const first = client.capabilities();
    const second = client.capabilities();
    end.answerCapabilities(MESSAGE_TYPES);
    expect(await first).toEqual(await second);
    expect(end.posted.filter((m) => m.type === "capabilities")).toHaveLength(1);
    expect((await first).workstation).toEqual({ id: "ws-test", name: "Test bench", demo: false });
  });

  it("falls back to the core set when the other end cannot answer the question", async () => {
    const end = scriptedEnd();
    const client = createChannelClient(end.port);
    const asked = client.capabilities();
    end.fail(end.posted[0].id, "capabilities", "unsupported");
    expect((await asked).messages).toEqual([...CORE_MESSAGES]);
  });

  it("falls back to the core set when the answer is not a capabilities answer", async () => {
    const end = scriptedEnd();
    const client = createChannelClient(end.port);
    const asked = client.capabilities();
    end.ok(end.posted[0].id, { version: "one", messages: "all of them" });
    expect((await asked).messages).toEqual([...CORE_MESSAGES]);
  });

  it("keeps the types it was told about, including ones this build has never heard of", async () => {
    const end = scriptedEnd();
    const client = createChannelClient(end.port);
    const asked = client.capabilities();
    end.answerCapabilities([...MESSAGE_TYPES, "share-sheet"]);
    expect((await asked).messages).toContain("share-sheet");
  });
});

describe("opening a link outside the app", () => {
  it("asks the shell, and says whether it was done", async () => {
    const end = scriptedEnd();
    const client = createChannelClient(end.port);
    const opened = client.openExternal("https://example.com/docs");
    end.answerCapabilities(MESSAGE_TYPES);
    await vi.waitFor(() => expect(end.posted.some((m) => m.type === "open-external")).toBe(true));
    const sent = end.posted.find((m) => m.type === "open-external")!;
    expect(sent.url).toBe("https://example.com/docs");
    end.ok(sent.id);
    await expect(opened).resolves.toBe(true);
  });

  it("degrades to `false`, sending nothing, on a shell that does not know the message", async () => {
    const end = scriptedEnd();
    const client = createChannelClient(end.port);
    const opened = client.openExternal("https://example.com/docs");
    end.answerCapabilities(CORE_MESSAGES);
    await expect(opened).resolves.toBe(false);
    expect(end.posted.some((m) => m.type === "open-external")).toBe(false);
  });

  it("answers `false` when the shell refuses", async () => {
    const end = scriptedEnd();
    const client = createChannelClient(end.port);
    const opened = client.openExternal("https://example.com/docs");
    end.answerCapabilities(MESSAGE_TYPES);
    await vi.waitFor(() => expect(end.posted.some((m) => m.type === "open-external")).toBe(true));
    end.fail(end.posted.find((m) => m.type === "open-external")!.id, "blocked");
    await expect(opened).resolves.toBe(false);
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "gavin://pair", "not a url", ""])(
    "never sends %j: only a web link is an external link",
    async (url) => {
      const end = scriptedEnd();
      const client = createChannelClient(end.port);
      await expect(client.openExternal(url)).resolves.toBe(false);
      expect(end.posted).toEqual([]);
    }
  );
});

describe("returning to the hub", () => {
  it("asks the shell", async () => {
    const end = scriptedEnd();
    const client = createChannelClient(end.port);
    const returned = client.returnToHub();
    end.answerCapabilities(MESSAGE_TYPES);
    await vi.waitFor(() => expect(end.posted.some((m) => m.type === "return-to-hub")).toBe(true));
    end.ok(end.posted.find((m) => m.type === "return-to-hub")!.id);
    await expect(returned).resolves.toBe(true);
  });

  it("degrades to `false`, sending nothing, on a shell that does not know the message", async () => {
    const end = scriptedEnd();
    const client = createChannelClient(end.port);
    const returned = client.returnToHub();
    end.answerCapabilities(CORE_MESSAGES);
    await expect(returned).resolves.toBe(false);
    expect(end.posted.some((m) => m.type === "return-to-hub")).toBe(false);
  });
});

describe("the connection to the Workstation", () => {
  it("is heard going down and coming back up, by everyone hearing it", () => {
    const end = scriptedEnd();
    const client = createChannelClient(end.port);
    const first = vi.fn();
    const second = vi.fn();
    client.onConnection(first);
    const stop = client.onConnection(second);

    end.say({ v: CHANNEL_VERSION, type: "connection", state: "down", reason: "asleep" });
    stop();
    end.say({ v: CHANNEL_VERSION, type: "connection", state: "up" });

    expect(first.mock.calls).toEqual([[{ state: "down", reason: "asleep" }], [{ state: "up" }]]);
    expect(second.mock.calls).toEqual([[{ state: "down", reason: "asleep" }]]);
  });

  it("keeps an unreachable refusal's code, for the surface to tell it from the Workstation's own", async () => {
    const end = scriptedEnd();
    const client = createChannelClient(end.port);
    const answer = client.invoke("git_status");
    end.fail(end.posted[0].id, "The Workstation cannot be reached right now.", "unreachable");
    const error = await answer.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelError);
    expect((error as ChannelError).code).toBe("unreachable");
  });

  it("is not heard after the channel closes", () => {
    const end = scriptedEnd();
    const client = createChannelClient(end.port);
    const heard = vi.fn();
    client.onConnection(heard);
    client.close();
    end.say({ v: CHANNEL_VERSION, type: "connection", state: "up" });
    expect(heard).not.toHaveBeenCalled();
  });
});

describe("closing", () => {
  it("rejects what was still waiting, and hears nothing afterwards", async () => {
    const end = scriptedEnd();
    const client = createChannelClient(end.port);
    const heard = vi.fn();
    const listening = client.listen("cwd-changed", heard);
    end.ok(end.posted[0].id);
    await listening;
    const answer = client.invoke("get_board");

    client.close();
    await expect(answer).rejects.toThrow("the channel closed");
    end.say({ v: CHANNEL_VERSION, type: "event", listener: end.posted[0].id, event: "cwd-changed", payload: 1 });
    expect(heard).not.toHaveBeenCalled();
  });

  it("refuses new calls", async () => {
    const end = scriptedEnd();
    const client = createChannelClient(end.port);
    client.close();
    await expect(client.invoke("get_board")).rejects.toThrow("the channel closed");
    expect(end.posted).toEqual([]);
  });
});
