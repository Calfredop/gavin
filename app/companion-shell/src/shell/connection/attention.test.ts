// Reading the attention answer: what this build knows, and nothing it
// does not break it.
import { describe, expect, it, vi } from "vitest";
import { ATTENTION_API_VERSION, AttentionError, askAttention, readAttention } from "$shell/connection/attention";
import type { Connection } from "$shell/connection/connection";

describe("the attention answer", () => {
  it("reads the state and the items", () => {
    expect(
      readAttention({
        type: "Attention",
        state: "ready",
        version: 1,
        items: [
          { id: "waiting:s1", workspace: "w1", kind: "waiting", text: "asks which migration", target: { kind: "session", id: "s1" } },
          { id: "test:c", workspace: "w1", kind: "human-test", text: "check the modal", target: { kind: "card", path: "plans/c.md" } },
        ],
      })
    ).toEqual({
      state: "ready",
      items: [
        { id: "waiting:s1", workspace: "w1", kind: "waiting", text: "asks which migration", target: { kind: "session", id: "s1" } },
        { id: "test:c", workspace: "w1", kind: "human-test", text: "check the modal", target: { kind: "card", path: "plans/c.md" } },
      ],
    });
  });

  it("reads a Workstation whose desktop app is not running, whatever items it carries", () => {
    expect(readAttention({ type: "Attention", state: "desktop-app-not-running", items: [{ id: "x" }], version: 1 })).toEqual({
      state: "desktop-app-not-running",
    });
  });

  it("reads why the desktop app could not answer, and passes over a reason it has not heard of", () => {
    for (const reason of ["not-connected", "connection-lost", "not-answering"] as const) {
      expect(readAttention({ type: "Attention", state: "desktop-app-not-running", items: [], version: 1, reason })).toEqual({
        state: "desktop-app-not-running",
        reason,
      });
    }
    expect(readAttention({ type: "Attention", state: "desktop-app-not-running", items: [], version: 1, reason: "asleep-at-the-wheel" })).toEqual({
      state: "desktop-app-not-running",
    });
  });

  it("grows by optional fields: an unknown field is ignored, an unknown kind kept, an unknown target dropped", () => {
    const answer = readAttention({
      type: "Attention",
      state: "ready",
      version: 2,
      mood: "calm",
      items: [
        { id: "a", workspace: "w", kind: "waiting", text: "t", target: { kind: "session", id: "s" }, priority: 3 },
        { id: "b", workspace: "w", kind: "budget-spent", text: "t", target: { kind: "run", id: "r" } },
      ],
    });
    expect(answer).toEqual({
      state: "ready",
      items: [
        { id: "a", workspace: "w", kind: "waiting", text: "t", target: { kind: "session", id: "s" } },
        { id: "b", workspace: "w", kind: "other", text: "t", target: null },
      ],
    });
  });

  it("reads a workspace's name where the Workstation says it, and goes without one where it does not", () => {
    const answer = readAttention({
      type: "Attention",
      state: "ready",
      version: 1,
      items: [
        { id: "a", workspace: "w1", workspaceName: " Gavin ", kind: "waiting", text: "t", target: null },
        { id: "b", workspace: "w2", workspaceName: "", kind: "waiting", text: "t", target: null },
        { id: "c", workspace: "w3", workspaceName: 7, kind: "waiting", text: "t", target: null },
      ],
    });
    expect(answer.state === "ready" && answer.items.map((item) => item.workspaceName)).toEqual(["Gavin", undefined, undefined]);
    expect(answer.state === "ready" && "workspaceName" in answer.items[1]).toBe(false);
  });

  it("leaves out an item it cannot show, and keeps the rest", () => {
    const answer = readAttention({
      type: "Attention",
      state: "ready",
      version: 1,
      items: [null, { id: "", workspace: "w", text: "t" }, { id: "ok", workspace: "w", kind: "failed", text: "crashed" }],
    });
    expect(answer).toEqual({
      state: "ready",
      items: [{ id: "ok", workspace: "w", kind: "failed", text: "crashed", target: null }],
    });
  });

  it("refuses a state it does not know, and an error, in words", () => {
    expect(() => readAttention({ type: "Attention", state: "hibernating", items: [], version: 3 })).toThrow(AttentionError);
    expect(() => readAttention({ type: "Error", message: "no desktop" })).toThrow(/no desktop/);
    expect(() => readAttention({ type: "Unsupported", request_type: "GetAttention", min_version: 50 })).toThrow(
      /too old/
    );
    expect(() => readAttention("Attention")).toThrow(AttentionError);
  });

  it("asks with the version it reads, and takes the first answer to it", async () => {
    const request = vi.fn(async (_message: unknown, answers: (reply: unknown) => boolean) => {
      // A push that is not the answer is passed over by `answers`.
      expect(answers({ type: "DesktopEvent", event: "x", payload: null })).toBe(false);
      expect(answers({ type: "Attention" })).toBe(true);
      expect(answers({ type: "Error", message: "x" })).toBe(true);
      return { type: "Attention", state: "ready", items: [], version: 1 };
    });
    const connection = { request } as unknown as Connection;
    expect(await askAttention(connection, 1234)).toEqual({ state: "ready", items: [] });
    expect(request).toHaveBeenCalledWith({ type: "GetAttention", version: ATTENTION_API_VERSION }, expect.any(Function), 1234);
  });
});
