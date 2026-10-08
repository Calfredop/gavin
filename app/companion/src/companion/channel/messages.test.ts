import { describe, expect, it } from "vitest";
import {
  CHANNEL_VERSION,
  MESSAGE_TYPES,
  encode,
  readBundleMessage,
  readWorkstationMessage,
  type BundleMessage,
  type WorkstationMessage,
} from "$companion/channel/messages";

describe("the channel's message set", () => {
  it("is closed: the nine types the spec names and no others", () => {
    expect([...MESSAGE_TYPES].sort()).toEqual(
      [
        "capabilities",
        "connection",
        "event",
        "invoke",
        "listen",
        "open-external",
        "result",
        "return-to-hub",
        "unlisten",
      ].sort()
    );
  });

  it("carries its version on every message", () => {
    const sent: BundleMessage = { v: CHANNEL_VERSION, type: "return-to-hub", id: 1 };
    expect(JSON.parse(encode(sent)).v).toBe(CHANNEL_VERSION);
  });
});

describe("what the Workstation's end reads", () => {
  const FROM_THE_BUNDLE: BundleMessage[] = [
    { v: CHANNEL_VERSION, type: "capabilities", id: 1 },
    { v: CHANNEL_VERSION, type: "invoke", id: 2, cmd: "get_board", args: { workspaceId: "w1" } },
    { v: CHANNEL_VERSION, type: "listen", id: 3, event: "gavin-tree-changed" },
    { v: CHANNEL_VERSION, type: "unlisten", id: 4, listener: 3 },
    { v: CHANNEL_VERSION, type: "open-external", id: 5, url: "https://example.com/docs" },
    { v: CHANNEL_VERSION, type: "return-to-hub", id: 6 },
  ];

  it.each(FROM_THE_BUNDLE)("round-trips $type", (message) => {
    expect(readBundleMessage(encode(message))).toEqual({ kind: "message", message });
  });

  it("reads a type it has never heard of as unknown, keeping the id it must answer", () => {
    const raw = JSON.stringify({ v: 7, type: "share-sheet", id: 12, title: "x" });
    expect(readBundleMessage(raw)).toEqual({ kind: "unknown", type: "share-sheet", id: 12 });
  });

  it("reads a reply type as unknown: `result` is not something a bundle sends", () => {
    const raw = JSON.stringify({ v: CHANNEL_VERSION, type: "result", id: 1, ok: true, value: 1 });
    expect(readBundleMessage(raw)).toMatchObject({ kind: "unknown", type: "result" });
  });

  it("reads a known type with a missing field as malformed, keeping the id", () => {
    const raw = JSON.stringify({ v: CHANNEL_VERSION, type: "invoke", id: 9, args: {} });
    expect(readBundleMessage(raw)).toMatchObject({ kind: "malformed", id: 9 });
  });

  it("reads an invoke whose args are not an object as malformed", () => {
    const raw = JSON.stringify({ v: CHANNEL_VERSION, type: "invoke", id: 9, cmd: "x", args: [1] });
    expect(readBundleMessage(raw)).toMatchObject({ kind: "malformed", id: 9 });
  });

  it.each(["", "not json", "null", "42", "[]", '{"type":7}', '{"id":1}'])(
    "reads %j as malformed with nothing to answer",
    (raw) => {
      expect(readBundleMessage(raw)).toMatchObject({ kind: "malformed", id: null });
    }
  );

  it("does not take a fractional or negative id for one it can answer", () => {
    for (const id of [1.5, -1, "3", null]) {
      const raw = JSON.stringify({ v: CHANNEL_VERSION, type: "return-to-hub", id });
      expect(readBundleMessage(raw)).toMatchObject({ kind: "malformed", id: null });
    }
  });

  it("ignores a field it does not know on a type it does", () => {
    const raw = JSON.stringify({ v: 2, type: "listen", id: 3, event: "cwd-changed", replay: true });
    expect(readBundleMessage(raw)).toEqual({
      kind: "message",
      message: { v: 2, type: "listen", id: 3, event: "cwd-changed" },
    });
  });
});

describe("what the bundle's end reads", () => {
  const TO_THE_BUNDLE: WorkstationMessage[] = [
    { v: CHANNEL_VERSION, type: "result", id: 1, ok: true, value: { columns: [] } },
    { v: CHANNEL_VERSION, type: "result", id: 2, ok: true, value: null },
    { v: CHANNEL_VERSION, type: "result", id: 3, ok: false, error: "no such workspace" },
    { v: CHANNEL_VERSION, type: "result", id: 4, ok: false, error: "share-sheet", code: "unsupported" },
    { v: CHANNEL_VERSION, type: "result", id: 5, ok: false, error: "gone", code: "unreachable" },
    { v: CHANNEL_VERSION, type: "event", listener: 3, event: "cwd-changed", payload: ["s1", "/tmp"] },
    { v: CHANNEL_VERSION, type: "connection", state: "up" },
    { v: CHANNEL_VERSION, type: "connection", state: "down", reason: "asleep" },
    { v: CHANNEL_VERSION, type: "connection", state: "down", reason: "desktop-app-not-running" },
  ];

  it.each(TO_THE_BUNDLE)("round-trips $type", (message) => {
    expect(readWorkstationMessage(encode(message))).toEqual({ kind: "message", message });
  });

  it("reads a success with no value as a null value: a command that returns nothing", () => {
    const raw = JSON.stringify({ v: CHANNEL_VERSION, type: "result", id: 5, ok: true });
    expect(readWorkstationMessage(raw)).toEqual({
      kind: "message",
      message: { v: CHANNEL_VERSION, type: "result", id: 5, ok: true, value: null },
    });
  });

  it("reads a failure with no words as malformed rather than as a silent rejection", () => {
    const raw = JSON.stringify({ v: CHANNEL_VERSION, type: "result", id: 5, ok: false });
    expect(readWorkstationMessage(raw)).toMatchObject({ kind: "malformed", id: 5 });
  });

  it("reads a type it has never heard of as unknown", () => {
    const raw = JSON.stringify({ v: 3, type: "presence", devices: [] });
    expect(readWorkstationMessage(raw)).toEqual({ kind: "unknown", type: "presence", id: null });
  });

  it("reads a connection down for a reason it does not know as down and unreachable", () => {
    const raw = JSON.stringify({ v: CHANNEL_VERSION, type: "connection", state: "down", reason: "on-a-plane" });
    expect(readWorkstationMessage(raw)).toEqual({
      kind: "message",
      message: { v: CHANNEL_VERSION, type: "connection", state: "down", reason: "unreachable" },
    });
  });

  it("reads a connection with no state it knows as malformed, with nothing to answer", () => {
    const raw = JSON.stringify({ v: CHANNEL_VERSION, type: "connection", state: "sideways" });
    expect(readWorkstationMessage(raw)).toMatchObject({ kind: "malformed", id: null });
  });

  it("is a type a bundle cannot send: it is the shell's to say", () => {
    const raw = JSON.stringify({ v: CHANNEL_VERSION, type: "connection", id: 4, state: "up" });
    expect(readBundleMessage(raw)).toEqual({ kind: "unknown", type: "connection", id: 4 });
  });

  it("drops an error code it does not know and keeps the error", () => {
    const raw = JSON.stringify({
      v: CHANNEL_VERSION,
      type: "result",
      id: 6,
      ok: false,
      error: "later",
      code: "rate-limited",
    });
    expect(readWorkstationMessage(raw)).toEqual({
      kind: "message",
      message: { v: CHANNEL_VERSION, type: "result", id: 6, ok: false, error: "later" },
    });
  });
});
