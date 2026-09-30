// The Companion's own way in: what it loads from a Workstation, what it
// keeps current, and what it remembers -- in place of the desktop's
// bootstrap, which starts the desk's duties and saves the desk's layout.
import { afterEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import { kanbanState } from "$lib/board/kanbanState";
import { gavinTrees } from "$lib/core/gavinState";
import { layoutState } from "$lib/core/layoutState";
import type { Workspace } from "$lib/core/workspace";
import { CORE_MESSAGES } from "$companion/channel/messages";
import { loopback } from "$companion/channel/port";
import { DEMO, sampleState } from "$companion/demo/sampleData";
import { createDemoWorkstation, type DemoWorkstation } from "$companion/demo/workstation";
import { disconnectChannel } from "$companion/remote/connection";
import { LAYOUT_SAVING_COMMANDS } from "$companion/remote/remoteRole";
import { viewKey } from "$companion/state/viewState";
import {
  connection,
  connectWorkstation,
  land,
  landing,
  openWorkspace,
  placeFiles,
  returnToHub,
  showSurface,
  showWorkspaces,
  view,
} from "$companion/state/workstation";
import { settle } from "$companion/testing/demoBench";
import { deviceStorage, resetDesktopStores } from "$companion/testing/desktopStores";

let disconnect: (() => void) | null = null;

afterEach(() => {
  disconnect?.();
  disconnect = null;
  disconnectChannel();
  resetDesktopStores();
});

async function connect(demo: DemoWorkstation, storage = deviceStorage()) {
  disconnect = await connectWorkstation(loopback(demo), storage);
  await settle();
  return storage;
}

function aNewWorkspace(): Workspace {
  return {
    id: "demo-new",
    name: "new-service",
    rootPath: "/Users/demo/code/new-service",
    activePageId: null,
    pages: [],
  };
}

describe("connecting to a Workstation", () => {
  it("starts out connecting", () => {
    expect(get(connection)).toEqual({ status: "connecting" });
  });

  it("says which Workstation it reached, and whether the hub can be returned to", async () => {
    await connect(createDemoWorkstation());
    expect(get(connection)).toEqual({
      status: "ready",
      workstation: { id: "demo", name: "Demo Workstation", demo: true },
      canReturnToHub: true,
    });
  });

  it("offers no way back to the hub on a shell that has none", async () => {
    await connect(createDemoWorkstation({ messages: CORE_MESSAGES }));
    expect(get(connection)).toMatchObject({ status: "ready", canReturnToHub: false });
  });

  it("fills the desktop's own stores, which is what the desktop's components read", async () => {
    await connect(createDemoWorkstation());
    const layout = get(layoutState);
    expect(layout.status).toBe("ready");
    expect(layout.workspaces.map((w) => w.name)).toEqual(["atlas-api", "field-notes", "Scratchpad"]);
    expect(layout.sessionStatusById).toMatchObject({
      "s-atlas-auth": "working",
      "s-atlas-store": "waiting_for_input",
      "s-atlas-billing": "idle",
    });
    expect(layout.sessionNames["s-atlas-auth"]).toBe("token refresh");
    expect(get(gavinTrees)[DEMO.atlas].contexts.map((c) => c.name)).toEqual(["atlas-api", "billing"]);
    expect(get(gavinTrees)[DEMO.notes].rootPath).toBe(DEMO.notesRoot);
    expect(get(kanbanState)[DEMO.atlas].columns).toHaveLength(4);
  });

  it("loads no tree for a workspace bound to no folder", async () => {
    const demo = createDemoWorkstation();
    await connect(demo);
    expect(get(gavinTrees)[DEMO.scratch]).toBeUndefined();
    const asked = demo.received().flatMap((m) => (m.type === "invoke" && m.cmd === "get_gavin_tree" ? [m.args] : []));
    expect(asked).toEqual([{ workspaceId: DEMO.atlas }, { workspaceId: DEMO.notes }]);
  });

  it("does not take the desk's open workspace for its own", async () => {
    const demo = createDemoWorkstation();
    expect(demo.state.workspaces.activeWorkspaceId).toBe(DEMO.atlas);
    await connect(demo);
    expect(get(view).workspaceId).toBeNull();
    expect(get(layoutState).activeWorkspaceId).toBeNull();
  });

  it("asks the Demo Workstation nothing it has no answer for", async () => {
    const demo = createDemoWorkstation();
    await connect(demo);
    expect(demo.unanswered()).toEqual([]);
  });

  it("reads a status this build does not know as unknown, never as idle", async () => {
    const state = sampleState();
    state.sessions[1].status = "hibernating";
    await connect(createDemoWorkstation({ state }));
    expect(get(layoutState).sessionStatusById[state.sessions[1].id]).toBe("unknown");
  });

  it("says why, in the Workstation's words, when the Workstation cannot answer", async () => {
    const demo = createDemoWorkstation();
    demo.unavailable = "desktop app not running";
    await connect(demo);
    expect(get(connection)).toEqual({ status: "unavailable", reason: "desktop app not running" });
    expect(get(layoutState).workspaces).toEqual([]);
  });
});

describe("what it keeps current", () => {
  it("hears a session change status", async () => {
    const demo = createDemoWorkstation();
    await connect(demo);
    demo.emit("session-status-changed", ["s-atlas-auth", "waiting_for_input"]);
    await settle();
    expect(get(layoutState).sessionStatusById["s-atlas-auth"]).toBe("waiting_for_input");
  });

  it("hears a card move", async () => {
    const demo = createDemoWorkstation();
    await connect(demo);
    const tree = structuredClone(demo.state.trees[DEMO.atlas]);
    tree.contexts[0].plans[0].status = "Review";
    demo.emit("gavin-tree-changed", [DEMO.atlas, tree]);
    await settle();
    expect(get(gavinTrees)[DEMO.atlas].contexts[0].plans[0].status).toBe("Review");
  });

  it("takes a workspace added at the desk, and loads its board", async () => {
    const demo = createDemoWorkstation();
    await connect(demo);

    const added = aNewWorkspace();
    demo.state.workspaces.workspaces.push(added);
    demo.state.boards[added.id] = structuredClone(demo.state.boards[DEMO.notes]);
    demo.state.trees[added.id] = { rootPath: added.rootPath!, rootMissing: false, contexts: [] };
    demo.emit("workspaces-synced", { origin: "main", data: demo.state.workspaces });
    await settle();

    expect(get(layoutState).workspaces.map((w) => w.id)).toContain(added.id);
    expect(get(kanbanState)[added.id]).toBeDefined();
    expect(get(gavinTrees)[added.id]).toBeDefined();
  });

  it("goes back to the list when the workspace it has open is removed at the desk", async () => {
    const demo = createDemoWorkstation();
    await connect(demo);
    openWorkspace(DEMO.notes);

    demo.state.workspaces.workspaces = demo.state.workspaces.workspaces.filter((w) => w.id !== DEMO.notes);
    demo.emit("workspaces-synced", { origin: "main", data: demo.state.workspaces });
    await settle();

    expect(get(view).workspaceId).toBeNull();
    expect(get(layoutState).activeWorkspaceId).toBeNull();
  });

  it("keeps its own place when the desk switches workspace", async () => {
    const demo = createDemoWorkstation();
    await connect(demo);
    openWorkspace(DEMO.notes);

    demo.state.workspaces.activeWorkspaceId = DEMO.scratch;
    demo.emit("workspaces-synced", { origin: "main", data: demo.state.workspaces });
    await settle();

    expect(get(view).workspaceId).toBe(DEMO.notes);
    expect(get(layoutState).activeWorkspaceId).toBe(DEMO.notes);
  });

  it("stops listening when it disconnects", async () => {
    const demo = createDemoWorkstation();
    await connect(demo);
    expect(demo.listening("session-status-changed")).toBe(1);
    disconnect!();
    disconnect = null;
    await settle();
    for (const event of ["session-status-changed", "gavin-tree-changed", "workspaces-synced"]) {
      expect(demo.listening(event)).toBe(0);
    }
  });
});

describe("the Companion's view", () => {
  it("opens a workspace, and shows the list again", async () => {
    await connect(createDemoWorkstation());
    openWorkspace(DEMO.atlas);
    expect(get(view)).toEqual({ workspaceId: DEMO.atlas, surface: "board" });
    showWorkspaces();
    expect(get(view).workspaceId).toBeNull();
  });

  it("will not open a workspace the Workstation does not have", async () => {
    await connect(createDemoWorkstation());
    openWorkspace("no-such-workspace");
    expect(get(view).workspaceId).toBeNull();
  });

  it("tells the desktop's modules which workspace is open, in memory only", async () => {
    const demo = createDemoWorkstation();
    await connect(demo);
    openWorkspace(DEMO.notes);
    expect(get(layoutState).activeWorkspaceId).toBe(DEMO.notes);
    await settle();
    expect(demo.state.workspaces.activeWorkspaceId).toBe(DEMO.atlas);
  });

  it("is remembered on the Device, under the Workstation it belongs to", async () => {
    const storage = await connect(createDemoWorkstation());
    openWorkspace(DEMO.notes);
    expect(JSON.parse(storage.items[viewKey("demo")])).toEqual({ workspaceId: DEMO.notes, surface: "board" });
  });

  it("comes back where it was", async () => {
    const storage = await connect(createDemoWorkstation());
    openWorkspace(DEMO.notes);
    disconnect!();
    resetDesktopStores();

    await connect(createDemoWorkstation(), storage);
    expect(get(view).workspaceId).toBe(DEMO.notes);
    expect(get(layoutState).activeWorkspaceId).toBe(DEMO.notes);
  });

  it("comes back to the list when where it was no longer exists", async () => {
    const storage = deviceStorage({
      [viewKey("demo")]: JSON.stringify({ workspaceId: "deleted-last-week", surface: "board" }),
    });
    await connect(createDemoWorkstation(), storage);
    expect(get(view).workspaceId).toBeNull();
  });

  it("switches the open workspace's surface, and remembers it on the Device", async () => {
    const storage = await connect(createDemoWorkstation());
    openWorkspace(DEMO.atlas);
    showSurface("git");
    expect(get(view)).toEqual({ workspaceId: DEMO.atlas, surface: "git" });
    showSurface("files");
    placeFiles({ dir: `${DEMO.atlasRoot}/src`, file: `${DEMO.atlasRoot}/src/server.ts` });
    expect(JSON.parse(storage.items[viewKey("demo")])).toEqual({
      workspaceId: DEMO.atlas,
      surface: "files",
      files: { dir: `${DEMO.atlasRoot}/src`, file: `${DEMO.atlasRoot}/src/server.ts` },
    });
  });

  it("comes back to the surface, and the place in Files, it was at", async () => {
    const storage = await connect(createDemoWorkstation());
    openWorkspace(DEMO.atlas);
    showSurface("files");
    placeFiles({ dir: `${DEMO.atlasRoot}/docs`, file: null });
    disconnect!();
    resetDesktopStores();

    await connect(createDemoWorkstation(), storage);
    expect(get(view)).toEqual({
      workspaceId: DEMO.atlas,
      surface: "files",
      files: { dir: `${DEMO.atlasRoot}/docs`, file: null },
    });
  });

  it("leaves a landing behind when the human goes to another surface", async () => {
    const demo = createDemoWorkstation();
    await connect(demo);
    land({ workspace: DEMO.atlas, target: { kind: "card", path: "/x.md" } });
    expect(get(landing)).not.toBeNull();
    showSurface("git");
    expect(get(landing)).toBeNull();
  });

  it("has no surface to switch at the workspace list", async () => {
    await connect(createDemoWorkstation());
    showSurface("git");
    expect(get(view)).toEqual({ workspaceId: null, surface: "board" });
  });

  it("returns to the hub through the shell", async () => {
    const demo = createDemoWorkstation();
    await connect(demo);
    await returnToHub();
    expect(demo.received().some((m) => m.type === "return-to-hub")).toBe(true);
  });
});

describe("everything above, at the wire", () => {
  it("never sends a layout-saving command, and sends nothing but reads", async () => {
    const demo = createDemoWorkstation();
    const storage = await connect(demo);

    // A visit: every workspace opened and left, while the desk carries on.
    for (const id of [DEMO.atlas, DEMO.notes, DEMO.scratch]) {
      openWorkspace(id);
      await settle();
      demo.emit("session-status-changed", ["s-atlas-auth", "idle"]);
      demo.emit("gavin-tree-changed", [DEMO.atlas, demo.state.trees[DEMO.atlas]]);
      demo.emit("workspaces-synced", { origin: "main", data: demo.state.workspaces });
      await settle();
      showWorkspaces();
    }
    openWorkspace(DEMO.atlas);
    disconnect!();
    disconnect = null;
    await settle();

    const sent = demo.commands();
    expect(sent.filter((cmd) => (LAYOUT_SAVING_COMMANDS as readonly string[]).includes(cmd))).toEqual([]);
    expect([...new Set(sent)].sort()).toEqual(
      [
        "get_board",
        "get_gavin_tree",
        "get_session_baselines",
        "get_session_names",
        "get_theme_pref",
        "get_workspaces_state",
        "worktree_setup",
      ].sort()
    );
    // ...and where it was is on the Device.
    expect(JSON.parse(storage.items[viewKey("demo")]).workspaceId).toBe(DEMO.atlas);
    // The desk's layout is as the desk left it.
    expect(demo.state.workspaces).toEqual(sampleState().workspaces);
  });
});
