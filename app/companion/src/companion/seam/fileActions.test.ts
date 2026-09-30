// Seam 2 for the Files surface: the desktop's own file calls
// (`backend.ts`, unchanged) on one end of the channel, the Demo
// Workstation on the other, and the wire read message by message.
//
// The surface lists folders with `list_directory` and opens files in the
// desk's own editor, which reads, watches and autosaves through the same
// calls as below -- the order of them is `FileEditor.svelte`'s. What is
// held here is what crosses: the arguments the host takes, the fences
// it keeps, the event that tells an open editor about a change, and that
// a save is a change on the Git surface too.
import { afterEach, describe, expect, it, vi } from "vitest";
import { listen, type Event } from "@tauri-apps/api/event";
import { get } from "svelte/store";
import * as backend from "$lib/core/backend";
import { emptyTree, withChildren } from "$lib/files/fileTree";
import { __resetViewableCacheForTesting, isViewableExtension, loadViewableExtensions } from "$lib/files/fileTypes";
import { ensureGitView, gitStore, refresh, startWatching } from "$lib/git/gitState";
import { createChannelClient } from "$companion/channel/client";
import { loopback } from "$companion/channel/port";
import { DEMO } from "$companion/demo/sampleData";
import { disconnectChannel } from "$companion/remote/connection";
import { DESK_ONLY_COMMANDS, LAYOUT_SAVING_COMMANDS } from "$companion/remote/remoteRole";
import { folderView, tapOn } from "$companion/surfaces/phoneFiles";
import { connectDemo, settle } from "$companion/testing/demoBench";
import { resetDesktopStores } from "$companion/testing/desktopStores";
import { allowedToRemoteRole, tableSize } from "$companion/testing/remoteTable";
import { argsOf, mark, traffic } from "$companion/testing/wire";

const ROOT = DEMO.atlasRoot;
const README = `${ROOT}/README.md`;

afterEach(() => {
  disconnectChannel();
  gitStore.set({});
  resetDesktopStores();
  __resetViewableCacheForTesting();
});

describe("browsing", () => {
  it("lists a folder with the workspace's root beside it, folders first", async () => {
    const demo = connectDemo();
    const listing = await backend.listDirectory(ROOT, ROOT);
    expect(argsOf(demo, "list_directory")).toEqual([{ root: ROOT, path: ROOT }]);
    expect(listing.entries.map((e) => `${e.isDir ? "dir " : ""}${e.name}`)).toEqual([
      "dir docs",
      "dir services",
      "dir src",
      "dir test",
      ".gitignore",
      "package.json",
      "README.md",
    ]);
    expect(listing.omitted).toBe(0);
  });

  it("walks into a folder the same way, and the desk's tree takes the answer as it is", async () => {
    connectDemo();
    const dir = `${ROOT}/src/auth`;
    const listing = await backend.listDirectory(ROOT, dir);
    const tree = withChildren(emptyTree(ROOT), dir, listing.entries, listing.omitted);
    const view = folderView(tree, dir);
    expect(view.kind === "listed" && view.nodes.map((n) => [n.path, n.size > 0])).toEqual([
      [`${ROOT}/src/auth/rotation.ts`, true],
      [`${ROOT}/src/auth/session.ts`, true],
      [`${ROOT}/src/auth/tokens.ts`, true],
    ]);
  });

  it("is refused outside the root it names, in the host's words", async () => {
    connectDemo();
    await expect(backend.listDirectory(ROOT, "/etc")).rejects.toBe("/etc is outside the workspace root");
    await expect(backend.listDirectory(ROOT, `${ROOT}/nowhere`)).rejects.toMatch(/No such file or directory/);
  });

  it("decides what opens in the editor from the Workstation's own list", async () => {
    const demo = connectDemo();
    const viewable = await loadViewableExtensions();
    expect(argsOf(demo, "viewable_extensions")).toEqual([{}]);
    expect(isViewableExtension(README, viewable)).toBe(true);
    const listing = await backend.listDirectory(ROOT, `${ROOT}/docs`);
    const picture = listing.entries.find((e) => e.name === "architecture.png");
    expect(picture && tapOn({ ...picture, path: `${ROOT}/docs/${picture.name}` }, viewable)).toBe("unviewable");
  });
});

describe("reading and editing a file", () => {
  it("reads what the Workstation has on disk", async () => {
    const demo = connectDemo();
    const read = await backend.readFileForViewer(README);
    expect(argsOf(demo, "read_file_for_viewer")).toEqual([{ path: README }]);
    expect(read).toEqual({ content: demo.state.files[README], truncated: false, exists: true });
    expect(read.content.startsWith("# atlas-api")).toBe(true);
  });

  it("answers a file that is not there as not there, not as an error", async () => {
    connectDemo();
    await expect(backend.readFileForViewer(`${ROOT}/NOTES.md`)).resolves.toEqual({
      content: "",
      truncated: false,
      exists: false,
    });
  });

  it("is refused anywhere outside every open workspace", async () => {
    connectDemo();
    await expect(backend.readFileForViewer("/etc/hosts")).rejects.toBe("/etc/hosts is outside every open workspace");
    await expect(backend.writeFileForEditor("/etc/hosts", "")).rejects.toBe("/etc/hosts is outside every open workspace");
  });

  it("saves the editor's buffer as the path and its whole content, and the Workstation has it", async () => {
    const demo = connectDemo();
    const edited = "# atlas-api\n\nThe accounts API, edited on a phone.\n";
    await backend.writeFileForEditor(README, edited);
    expect(argsOf(demo, "write_file_for_editor")).toEqual([{ path: README, content: edited }]);
    expect(demo.state.files[README]).toBe(edited);
    expect((await backend.readFileForViewer(README)).content).toBe(edited);
  });

  it("goes in the order the desk's editor makes its calls: read, watch, listen; save; unwatch", async () => {
    const demo = connectDemo();
    const from = mark(demo);
    await backend.readFileForViewer(README);
    await backend.watchFileForViewer(README);
    const stop = await listen<string>("file-changed", () => {});
    await backend.writeFileForEditor(README, "# atlas-api\n");
    stop();
    await backend.unwatchFileForViewer(README);
    expect(traffic(demo, from)).toEqual([
      "invoke read_file_for_viewer",
      "invoke watch_file_for_viewer",
      "listen file-changed",
      "invoke write_file_for_editor",
      "unlisten",
      "invoke unwatch_file_for_viewer",
    ]);
    expect(demo.state.watches.files).toEqual({});
  });
});

describe("a change to an open file", () => {
  it("reaches the editor watching it as file-changed, naming the path", async () => {
    const demo = connectDemo();
    await backend.watchFileForViewer(README);
    const heard = vi.fn<[Event<string>], void>();
    await listen<string>("file-changed", heard);

    // The desk -- or an agent there -- writes the file.
    const desk = createChannelClient(loopback(demo));
    await desk.invoke("write_file_for_editor", { path: README, content: "# atlas-api\n\nChanged at the desk.\n" });
    await settle();

    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard.mock.calls[0][0].payload).toBe(README);
    expect((await backend.readFileForViewer(README)).content).toContain("Changed at the desk.");
  });

  it("is not announced for a file nobody watches", async () => {
    const demo = connectDemo();
    const heard = vi.fn();
    await listen("file-changed", heard);
    await backend.writeFileForEditor(README, "# unwatched\n");
    await settle();
    expect(heard).not.toHaveBeenCalled();
    expect(demo.state.files[README]).toBe("# unwatched\n");
  });

  it("arrives when git rewrites the file, too", async () => {
    connectDemo();
    const server = `${ROOT}/src/server.ts`;
    await backend.watchFileForViewer(server);
    const heard = vi.fn<[Event<string>], void>();
    await listen<string>("file-changed", heard);
    await backend.gitCheckout(ROOT, "feat/login-rate-limit", null, null);
    await settle();
    expect(heard.mock.calls.map((c) => c[0].payload)).toEqual([server]);
  });
});

describe("an edit saved from Files", () => {
  it("is a change on the Git surface: the watched checkout hears of it and reads it", async () => {
    const demo = connectDemo();
    ensureGitView(DEMO.atlas, ROOT);
    await refresh(DEMO.atlas);
    const stop = await startWatching(DEMO.atlas);

    await backend.writeFileForEditor(README, "# atlas-api\n\nEdited on a phone.\n");
    await settle();

    expect(get(gitStore)[DEMO.atlas].status?.unstaged).toContainEqual({ path: "README.md", status: "M" });
    stop();
    await settle();

    const refused = [...LAYOUT_SAVING_COMMANDS, ...DESK_ONLY_COMMANDS] as readonly string[];
    expect(demo.commands().filter((cmd) => refused.includes(cmd))).toEqual([]);
    expect(demo.unanswered()).toEqual([]);
  });
});

describe("everything the Files surface sends", () => {
  it("is a command a real Workstation lets a Device call", async () => {
    const demo = connectDemo();
    await loadViewableExtensions();
    await backend.listDirectory(ROOT, ROOT);
    await backend.readFileForViewer(README);
    await backend.watchFileForViewer(README);
    await backend.writeFileForEditor(README, "# atlas-api\n");
    await backend.unwatchFileForViewer(README);
    const sent = [...new Set(demo.commands())];
    expect(sent.sort()).toEqual(
      [
        "list_directory",
        "read_file_for_viewer",
        "unwatch_file_for_viewer",
        "viewable_extensions",
        "watch_file_for_viewer",
        "write_file_for_editor",
      ].sort()
    );
    expect(tableSize()).toBeGreaterThan(100);
    expect(sent.filter((cmd) => !allowedToRemoteRole(cmd))).toEqual([]);
  });
});
