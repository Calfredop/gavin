// Seam 2 for adding a workspace from a phone (ADR 0006): the folder
// browser's reads and the add itself on one end of the channel, the Demo
// Workstation on the other, and the wire read message by message.
//
// The browser walks the file viewer's own listing (`list_directory`) from
// the Workstation's home folder; the add is settings alone
// (`add_workspace`), never the desk's layout save, which a Device is
// refused. What is held here is what crosses, in what order, what the
// Workstation holds afterwards, and what every desk window is told.
import { afterEach, describe, expect, it } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { get } from "svelte/store";
import * as backend from "$lib/core/backend";
import { gavinTrees } from "$lib/core/gavinState";
import { layoutState } from "$lib/core/layoutState";
import type { WorkspacesData } from "$lib/core/workspace";
import { emptyTree, withChildren } from "$lib/files/fileTree";
import { loopback } from "$companion/channel/port";
import { DEMO } from "$companion/demo/sampleData";
import { createDemoWorkstation, type DemoWorkstation } from "$companion/demo/workstation";
import { disconnectChannel } from "$companion/remote/connection";
import { LAYOUT_SAVING_COMMANDS } from "$companion/remote/remoteRole";
import { addWorkspace, connectWorkstation, view } from "$companion/state/workstation";
import { browseRoot, browserListing, folderAction } from "$companion/surfaces/phoneAddWorkspace";
import { folderAbove, folderView } from "$companion/surfaces/phoneFiles";
import { settle } from "$companion/testing/demoBench";
import { deviceStorage, resetDesktopStores } from "$companion/testing/desktopStores";
import { allowedToRemoteRole } from "$companion/testing/remoteTable";
import { argsOf, mark, traffic } from "$companion/testing/wire";

let disconnect: (() => void) | null = null;

afterEach(() => {
  disconnect?.();
  disconnect = null;
  disconnectChannel();
  resetDesktopStores();
});

async function connected(demo = createDemoWorkstation()): Promise<DemoWorkstation> {
  disconnect = await connectWorkstation(loopback(demo), deviceStorage());
  await settle();
  return demo;
}

function invokes(demo: DemoWorkstation, from: number): string[] {
  return traffic(demo, from).filter((line) => line.startsWith("invoke "));
}

/// One folder as the browser draws it, read the way the browser reads it.
async function browse(root: string, dir: string) {
  const listed = await backend.listDirectory(root, dir);
  const view = folderView(withChildren(emptyTree(root), dir, listed.entries, listed.omitted), dir);
  if (view.kind !== "listed") throw new Error(`${dir} was not listed`);
  return browserListing(view.nodes, get(layoutState).workspaces);
}

const WEATHER = DEMO.weatherRoot;

describe("the folder browser", () => {
  it("starts at the Workstation's home folder, listed against the top of its disk", async () => {
    const demo = await connected();
    const from = mark(demo);

    const home = await backend.homeDir();
    const root = browseRoot(home);
    const listing = await browse(root, home);

    expect(home).toBe(DEMO.home);
    expect(root).toBe("/");
    expect(argsOf(demo, "list_directory", from)).toEqual([{ root: "/", path: DEMO.home }]);
    expect(listing.rows.map((row) => `${row.isDir ? "dir " : ""}${row.name}`)).toEqual(["dir code", "dir Documents"]);
    // .zshrc: a home folder's dotfiles are not where a project lives.
    expect(listing.hidden).toBe(1);
  });

  it("marks the folders a workspace already works in", async () => {
    await connected();
    const listing = await browse("/", `${DEMO.home}/code`);
    expect(listing.rows.map((row) => [row.name, row.workspace])).toEqual([
      ["atlas-api", "atlas-api"],
      ["field-notes", "field-notes"],
      ["weather-station", null],
    ]);
  });

  it("goes up past the home folder, to the top of the disk", async () => {
    await connected();
    expect(folderAbove("/", DEMO.home)).toBe("/Users");
    expect(folderAbove("/", "/Users")).toBe("/");
    expect((await browse("/", "/Users")).rows.map((row) => row.name)).toEqual(["demo"]);
  });

  it("offers to open the workspace already on a folder, to add one on any other, and nothing at the top", async () => {
    await connected();
    const workspaces = get(layoutState).workspaces;
    expect(folderAction(DEMO.atlasRoot, "/", workspaces)).toEqual({
      kind: "open",
      workspaceId: DEMO.atlas,
      label: "Open atlas-api",
    });
    expect(folderAction(WEATHER, "/", workspaces)).toEqual({
      kind: "add",
      name: "weather-station",
      label: "Add weather-station",
    });
    expect(folderAction("/", "/", workspaces)).toEqual({ kind: "none" });
  });

  it("asks the Workstation whether gavin is in a folder already", async () => {
    const demo = await connected();
    const from = mark(demo);
    await expect(backend.gavinRootExists(DEMO.atlasRoot)).resolves.toBe(true);
    await expect(backend.gavinRootExists(WEATHER)).resolves.toBe(false);
    expect(argsOf(demo, "gavin_root_exists", from)).toEqual([{ rootPath: DEMO.atlasRoot }, { rootPath: WEATHER }]);
  });
});

describe("adding a workspace", () => {
  it("sets gavin up in the folder, then adds the workspace as settings alone, and opens it", async () => {
    const demo = await connected();
    const from = mark(demo);

    await addWorkspace(WEATHER, { trackInGit: true });
    await settle();

    const sent = invokes(demo, from);
    expect(sent.slice(0, 2)).toEqual(["invoke init_gavin_root", "invoke add_workspace"]);
    // Read back as well as heard: the announcement and the read race, and
    // the workspace has to be in hand before it is opened either way.
    expect(sent.indexOf("invoke get_workspaces_state")).toBeGreaterThan(1);
    expect(argsOf(demo, "init_gavin_root", from)).toEqual([{ rootPath: WEATHER, workspaceName: "weather-station" }]);
    // Tracking is what a repository does with no rule, so there is none to write.
    expect(argsOf(demo, "set_gavin_git_tracking", from)).toEqual([]);
    expect(argsOf(demo, "add_workspace", from)).toEqual([
      { settings: { name: "weather-station", rootPath: WEATHER, gitTrackingAsked: true } },
    ]);

    const added = demo.state.workspaces.workspaces.at(-1);
    expect(added).toMatchObject({ id: "demo-added-1", name: "weather-station", rootPath: WEATHER, pages: [] });
    expect(demo.state.files[`${WEATHER}/.gavin-root/PRD.md`]).toContain("# weather-station");
    expect(get(layoutState).workspaces.map((w) => w.id)).toContain("demo-added-1");
    expect(get(view)).toEqual({ workspaceId: "demo-added-1", surface: "board" });
  });

  it("reads the new workspace's board and tree, as it reads every rooted one", async () => {
    const demo = await connected();
    const from = mark(demo);

    await addWorkspace(WEATHER, { trackInGit: true });
    await settle();

    expect(argsOf(demo, "get_board", from)).toContainEqual({ workspaceId: "demo-added-1" });
    expect(get(gavinTrees)["demo-added-1"]?.contexts.map((c) => c.kind)).toEqual(["root"]);
  });

  it("writes the ignore rule first when told not to track gavin's files", async () => {
    const demo = await connected();
    const from = mark(demo);

    await addWorkspace(WEATHER, { trackInGit: false });

    expect(argsOf(demo, "set_gavin_git_tracking", from)).toEqual([{ root: WEATHER, tracked: false, untrack: false }]);
    expect(invokes(demo, from).indexOf("invoke set_gavin_git_tracking")).toBeLessThan(
      invokes(demo, from).indexOf("invoke add_workspace")
    );
  });

  it("adds a folder as it is, leaving the set-up and the git question for later", async () => {
    const demo = await connected();
    const from = mark(demo);

    await addWorkspace(WEATHER, null);

    expect(argsOf(demo, "init_gavin_root", from)).toEqual([]);
    expect(argsOf(demo, "add_workspace", from)).toEqual([{ settings: { name: "weather-station", rootPath: WEATHER } }]);
    expect(demo.state.workspaces.workspaces.at(-1)?.gitTrackingAsked).toBeUndefined();
  });

  it("is announced to every window as the Workstation's new list, under the Device's origin", async () => {
    await connected();
    const heard: { origin: string; data: WorkspacesData }[] = [];
    const stop = await listen<{ origin: string; data: WorkspacesData }>("workspaces-synced", (event) => {
      heard.push(event.payload);
    });

    await addWorkspace(WEATHER, null);
    await settle();
    stop();

    expect(heard.map((h) => h.origin)).toEqual(["companion"]);
    expect(heard[0].data.workspaces.map((w) => w.name)).toEqual([
      "atlas-api",
      "field-notes",
      "Scratchpad",
      "weather-station",
    ]);
  });

  it("never saves the desk's layout to do it, and sends only what the Remote role may", async () => {
    const demo = await connected();
    const home = await backend.homeDir();
    await browse(browseRoot(home), home);
    await backend.gavinRootExists(WEATHER);
    await addWorkspace(WEATHER, { trackInGit: false });
    await settle();

    const sent = [...new Set(demo.commands())];
    expect(sent.filter((cmd) => (LAYOUT_SAVING_COMMANDS as readonly string[]).includes(cmd))).toEqual([]);
    expect(sent.filter((cmd) => !allowedToRemoteRole(cmd))).toEqual([]);
    expect(demo.unanswered()).toEqual([]);
  });

  it("is refused, as the host refuses it, without a name or with layout in it", async () => {
    const demo = await connected();
    const before = demo.state.workspaces.workspaces.length;

    await expect(backend.addWorkspace({ rootPath: WEATHER })).rejects.toMatch(/needs a name/);
    await expect(backend.addWorkspace({ name: "   ", rootPath: WEATHER })).rejects.toMatch(/needs a name/);
    await expect(backend.addWorkspace({ name: "x", pages: [] } as never)).rejects.toBe(
      "`pages` is not a workspace setting"
    );
    expect(demo.state.workspaces.workspaces).toHaveLength(before);
  });

  it("says what went wrong when the desk cannot be asked, and adds nothing", async () => {
    const demo = await connected();
    demo.unavailable = "desktop app not running";
    const before = get(layoutState).workspaces.length;

    await expect(addWorkspace(WEATHER, null)).rejects.toBe("desktop app not running");
    expect(get(layoutState).workspaces).toHaveLength(before);
    expect(get(view).workspaceId).toBeNull();
  });
});
