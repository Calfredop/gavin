// Seam 2 (spec "Testing Decisions"): the desktop's own modules, unchanged,
// on one end of the channel and the Demo Workstation on the other.
//
// Nothing here mocks `@tauri-apps/api/*`. The imports below are the
// desktop's -- `backend.ts` imports `invoke` from the Tauri core module --
// and they reach the channel because this project's build resolves that
// module to the remote shim. A test that passes here is a test of the
// alias as much as of the shim.
import { afterEach, describe, expect, it, vi } from "vitest";
import { listen, type Event } from "@tauri-apps/api/event";
import * as backend from "$lib/core/backend";
import type { GavinTree } from "$lib/core/gavin";
import { connectDemo, settle } from "$companion/testing/demoBench";
import { disconnectChannel } from "$companion/remote/connection";
import { DEMO } from "$companion/demo/sampleData";

afterEach(() => disconnectChannel());

describe("invoke, through the channel", () => {
  it("answers the desktop's backend module with the Demo Workstation's data", async () => {
    const demo = connectDemo();
    const state = await backend.getWorkspacesState();
    expect(state.workspaces.map((w) => w.name)).toEqual(["atlas-api", "field-notes", "Scratchpad"]);
    expect(demo.commands()).toEqual(["get_workspaces_state"]);
  });

  it("carries the arguments the backend module names", async () => {
    connectDemo();
    const atlas = await backend.getBoard(DEMO.atlas);
    const notes = await backend.getBoard(DEMO.notes);
    expect(atlas.columns.map((c) => c.name)).toEqual(["To Do", "In Progress", "Review", "Done"]);
    expect(notes.columns.map((c) => c.name)).toEqual(["To Do", "In Progress", "Done"]);
  });

  it("answers a command that returns nothing with nothing", async () => {
    connectDemo();
    await expect(backend.getBootstrapError()).resolves.toBeNull();
  });

  it("rejects with the Workstation's words as a plain string, the way Tauri does", async () => {
    connectDemo();
    // `String(e)` is what the desktop's callers put on screen, and an
    // Error would read "Error: ..." where a Tauri rejection does not.
    await expect(backend.getBoard("no-such-workspace")).rejects.toBe(
      'the Demo Workstation has no workspace "no-such-workspace"'
    );
  });

  it("hands back data the bundle may change without changing the Workstation's", async () => {
    connectDemo();
    const first = await backend.getBoard(DEMO.atlas);
    first.columns.length = 0;
    expect((await backend.getBoard(DEMO.atlas)).columns).toHaveLength(4);
  });

  it("says so, rather than hanging, when nothing is connected", async () => {
    await expect(backend.getWorkspacesState()).rejects.toBe("the channel is not connected");
  });
});

describe("listen, through the channel", () => {
  it("hears what the Workstation emits, in the shape a Tauri listener is handed", async () => {
    const demo = connectDemo();
    const heard = vi.fn<[Event<[string, string]>], void>();
    await listen<[string, string]>("session-status-changed", heard);

    demo.emit("session-status-changed", ["s-atlas-auth", "idle"]);
    await settle();

    expect(heard).toHaveBeenCalledTimes(1);
    const event = heard.mock.calls[0][0];
    expect(event.event).toBe("session-status-changed");
    expect(event.payload).toEqual(["s-atlas-auth", "idle"]);
    expect(typeof event.id).toBe("number");
  });

  it("is registered on the Workstation by the time `listen` resolves", async () => {
    const demo = connectDemo();
    expect(demo.listening("cwd-changed")).toBe(0);
    await listen("cwd-changed", () => {});
    expect(demo.listening("cwd-changed")).toBe(1);
  });

  it("reaches only the listeners of the event that was emitted", async () => {
    const demo = connectDemo();
    const cwd = vi.fn();
    const status = vi.fn();
    await listen("cwd-changed", cwd);
    await listen("session-status-changed", status);

    demo.emit("cwd-changed", ["s-atlas-auth", "/tmp"]);
    await settle();

    expect(cwd).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it("reaches every listener of one event", async () => {
    const demo = connectDemo();
    const a = vi.fn();
    const b = vi.fn();
    await listen("cwd-changed", a);
    await listen("cwd-changed", b);
    demo.emit("cwd-changed", ["s-atlas-auth", "/tmp"]);
    await settle();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("hears nothing after unlisten, and the Workstation stops sending", async () => {
    const demo = connectDemo();
    const heard = vi.fn();
    const unlisten = await listen("cwd-changed", heard);

    unlisten();
    await settle();
    expect(demo.listening("cwd-changed")).toBe(0);

    demo.emit("cwd-changed", ["s-atlas-auth", "/tmp"]);
    await settle();
    expect(heard).not.toHaveBeenCalled();
  });
});

describe("a command that answers with a push", () => {
  it("delivers the tree a watch asks for as the event the desktop listens for", async () => {
    connectDemo();
    const heard = vi.fn<[Event<[string, GavinTree]>], void>();
    await listen<[string, GavinTree]>("gavin-tree-changed", heard);

    await backend.watchGavinRoot(DEMO.atlas, DEMO.atlasRoot);
    await settle();

    expect(heard).toHaveBeenCalledTimes(1);
    const [workspaceId, tree] = heard.mock.calls[0][0].payload;
    expect(workspaceId).toBe(DEMO.atlas);
    expect(tree.rootPath).toBe(DEMO.atlasRoot);
    expect(tree.contexts.map((c) => c.name)).toEqual(["atlas-api", "billing"]);
  });

  it("and the same tree on request", async () => {
    connectDemo();
    const tree = await backend.getGavinTree(DEMO.atlas);
    expect(tree.contexts[0].plans.length).toBeGreaterThan(0);
  });
});
