// Opening, ending and landing on sessions from the phone, against the
// Demo Workstation and read at the wire.
import { afterEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import { layoutState } from "$lib/core/layoutState";
import { allSessionIds } from "$lib/panes/layout";
import { loopback } from "$companion/channel/port";
import { DEMO } from "$companion/demo/sampleData";
import { createDemoWorkstation, type DemoWorkstation } from "$companion/demo/workstation";
import { disconnectChannel } from "$companion/remote/connection";
import { LAYOUT_SAVING_COMMANDS } from "$companion/remote/remoteRole";
import { endSession, launchTables, loadLaunchTables, startedHere, startSession } from "$companion/state/sessions";
import { viewKey } from "$companion/state/viewState";
import {
  closePage,
  closeTerminal,
  connectWorkstation,
  land,
  landing,
  openTerminal,
  openWorkspace,
  showSurface,
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

async function visit(demo = createDemoWorkstation(), storage = deviceStorage()) {
  disconnect = await connectWorkstation(loopback(demo), storage);
  await settle();
  return { demo, storage };
}

function argsOf(demo: DemoWorkstation, cmd: string): Record<string, unknown>[] {
  return demo.received().flatMap((m) => (m.type === "invoke" && m.cmd === cmd ? [m.args] : []));
}

function authPageTabs(): string[] {
  const atlas = get(layoutState).workspaces.find((w) => w.id === DEMO.atlas)!;
  return allSessionIds(atlas.pages.find((p) => p.name === "auth")!.layout);
}

describe("a workspace's surfaces", () => {
  it("are its board and its sessions, and the choice is remembered", async () => {
    const { storage } = await visit();
    openWorkspace(DEMO.atlas);
    showSurface("sessions");
    expect(get(view)).toEqual({ workspaceId: DEMO.atlas, surface: "sessions", sessionId: null });
    expect(JSON.parse(storage.items[viewKey("demo")]).surface).toBe("sessions");
  });
});

describe("a terminal", () => {
  it("opens over its workspace's sessions, and closes back to them", async () => {
    await visit();
    openTerminal("s-atlas-store");
    expect(get(view)).toEqual({ workspaceId: DEMO.atlas, surface: "sessions", sessionId: "s-atlas-store" });
    expect(get(layoutState).activeWorkspaceId).toBe(DEMO.atlas);
    closeTerminal();
    expect(get(view)).toEqual({ workspaceId: DEMO.atlas, surface: "sessions", sessionId: null });
  });

  it("will not open for a session no workspace holds", async () => {
    await visit();
    openTerminal("no-such-session");
    expect(get(view).sessionId).toBeNull();
  });

  it("is where the phone comes back to, while its session lives", async () => {
    const { storage } = await visit();
    openTerminal("s-notes-sync");
    disconnect!();
    resetDesktopStores();

    await visit(createDemoWorkstation(), storage);
    expect(get(view).sessionId).toBe("s-notes-sync");

    disconnect!();
    resetDesktopStores();
    const gone = createDemoWorkstation();
    gone.state.workspaces.workspaces = gone.state.workspaces.workspaces.map((w) =>
      w.id === DEMO.notes ? { ...w, pages: [] } : w
    );
    await visit(gone, storage);
    expect(get(view)).toMatchObject({ workspaceId: DEMO.notes, sessionId: null });
  });
});

describe("an inbox item", () => {
  it("naming a session lands on that session's terminal", async () => {
    await visit();
    land({ workspace: DEMO.atlas, target: { kind: "session", id: "s-atlas-store" } });
    expect(get(view)).toEqual({ workspaceId: DEMO.atlas, surface: "sessions", sessionId: "s-atlas-store" });
    expect(get(landing)).toBeNull();
  });

  it("naming a card opens that card over the board, whichever surface was last chosen", async () => {
    await visit();
    openWorkspace(DEMO.atlas);
    showSurface("sessions");
    const where = { workspace: DEMO.atlas, target: { kind: "card" as const, path: "/x/.gavin-root/plans/a.md" } };
    land(where);
    expect(get(view)).toEqual({
      workspaceId: DEMO.atlas,
      surface: "board",
      sessionId: null,
      page: { kind: "card", path: "/x/.gavin-root/plans/a.md" },
    });
    // ...and the board under it outlines the card, once the human is back
    // on it.
    closePage();
    expect(get(landing)).toEqual(where);
  });

  it("naming a session the workspace no longer holds lands on the board, to find its card", async () => {
    await visit();
    const where = { workspace: DEMO.atlas, target: { kind: "session" as const, id: "s-long-gone" } };
    land(where);
    expect(get(view)).toMatchObject({ workspaceId: DEMO.atlas, surface: "board", sessionId: null });
    expect(get(landing)).toEqual(where);
  });
});

describe("opening a session", () => {
  it("opens a terminal in the workspace's folder, the way a new tab does at the desk", async () => {
    const { demo } = await visit();
    const id = await startSession(DEMO.atlas, "terminal");
    await settle();

    expect(argsOf(demo, "create_session")).toEqual([{ cwd: DEMO.atlasRoot, workspaceRoot: DEMO.atlasRoot }]);
    expect(get(startedHere)).toEqual({ [id]: DEMO.atlas });
    expect(get(layoutState).sessionStatusById[id]).toBe("idle");
    openTerminal(id);
    expect(get(view)).toMatchObject({ workspaceId: DEMO.atlas, sessionId: id });
  });

  it("opens where a new session opens for a workspace with no folder", async () => {
    const { demo } = await visit();
    await startSession(DEMO.scratch, "terminal");
    expect(argsOf(demo, "create_session")).toEqual([{}]);
  });

  it("opens the workspace's agent only once the Workstation's agent settings are read", async () => {
    const { demo } = await visit();
    await expect(startSession(DEMO.atlas, "agent")).rejects.toThrow(/still being read/);
    expect(argsOf(demo, "create_session")).toEqual([]);

    await loadLaunchTables();
    expect(get(launchTables)).toBe("ready");
    await startSession(DEMO.atlas, "agent");

    const [launched] = argsOf(demo, "create_session");
    expect(launched).toMatchObject({ cwd: DEMO.atlasRoot, workspaceRoot: DEMO.atlasRoot, profileId: "claude-code" });
    expect(String(launched.command)).toMatch(/^claude\b/);
  });

  it("reads the agent settings once a visit", async () => {
    const { demo } = await visit();
    await loadLaunchTables();
    await loadLaunchTables();
    expect(demo.commands().filter((cmd) => cmd === "agent_profiles")).toHaveLength(1);
  });
});

describe("ending a session", () => {
  it("kills it at the Workstation, and a terminal showing it goes back to the list", async () => {
    const { demo } = await visit();
    openTerminal("s-atlas-store");
    await endSession("s-atlas-store");
    await settle();

    expect(argsOf(demo, "kill_session")).toEqual([{ sessionId: "s-atlas-store" }]);
    expect(get(view)).toEqual({ workspaceId: DEMO.atlas, surface: "sessions", sessionId: null });
    // ...and the desk closed its tab, which the phone hears.
    expect(authPageTabs()).toEqual(["s-atlas-auth"]);
  });

  it("forgets a session this phone started", async () => {
    await visit();
    const id = await startSession(DEMO.atlas, "terminal");
    await endSession(id);
    await settle();
    expect(get(startedHere)).toEqual({});
  });

  it("leaves a terminal showing another session where it is", async () => {
    await visit();
    openTerminal("s-atlas-auth");
    await endSession("s-atlas-store");
    await settle();
    expect(get(view).sessionId).toBe("s-atlas-auth");
  });
});

describe("sessions, at the wire", () => {
  it("never save the desk's layout: the desk places and closes their tabs", async () => {
    const { demo } = await visit();
    openWorkspace(DEMO.atlas);
    showSurface("sessions");
    await loadLaunchTables();
    const id = await startSession(DEMO.atlas, "agent");
    openTerminal(id);
    await endSession(id);
    await endSession("s-atlas-store");
    await settle();

    const sent = demo.commands();
    expect(sent.filter((cmd) => (LAYOUT_SAVING_COMMANDS as readonly string[]).includes(cmd))).toEqual([]);
    expect([...new Set(sent)].filter((cmd) => !cmd.startsWith("get_") && cmd !== "worktree_setup").sort()).toEqual(
      ["agent_profiles", "create_session", "kill_session"].sort()
    );
  });
});
