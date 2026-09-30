// The Demo Workstation's Git and file commands, asked directly: what the
// host answers that the surfaces' own suites (seam/gitActions,
// seam/fileActions) do not happen to reach.
import { describe, expect, it, vi } from "vitest";
import hostFileViewer from "../../../../src-tauri/src/fileviewer.rs?raw";
import { createChannelClient } from "$companion/channel/client";
import { loopback } from "$companion/channel/port";
import { DEMO } from "$companion/demo/sampleData";
import { createDemoWorkstation } from "$companion/demo/workstation";
import { settle } from "$companion/testing/demoBench";

function bench() {
  const demo = createDemoWorkstation();
  return { demo, client: createChannelClient(loopback(demo)) };
}

describe("the Demo's Git commands", () => {
  it("answer a folder in no repository as no repository, and refuse to read one", async () => {
    const { client } = bench();
    await expect(client.invoke("git_repo_info", { cwd: DEMO.home })).resolves.toMatchObject({ notARepo: true });
    await expect(client.invoke("git_status", { cwd: DEMO.home })).rejects.toThrow(
      `fatal: not a git repository: ${DEMO.home}`
    );
  });

  it("read a checkout from any folder inside it", async () => {
    const { client } = bench();
    await expect(client.invoke("git_repo_info", { cwd: `${DEMO.atlasRoot}/services/billing` })).resolves.toMatchObject({
      root: DEMO.atlasRoot,
    });
  });

  it("give each session's checkout its chip, and none to a session in no repository", async () => {
    const { client } = bench();
    const chips = await client.invoke("get_git_baselines", { cwds: [DEMO.atlasRoot, DEMO.home, DEMO.notesRoot] });
    expect(chips).toEqual([
      expect.objectContaining({ branch: "main", dirty: true, ahead: 1 }),
      null,
      expect.objectContaining({ branch: "main", dirty: false, ahead: 0 }),
    ]);
  });

  it("tell a watched checkout it changed, and only one somebody watches", async () => {
    const { demo, client } = bench();
    const heard = vi.fn();
    await client.listen("git-changed", heard);
    await client.invoke("git_stage_all", { cwd: DEMO.atlasRoot });
    await settle();
    expect(heard).not.toHaveBeenCalled();

    await client.invoke("git_watch", { cwd: DEMO.atlasRoot });
    await client.invoke("git_watch", { cwd: DEMO.atlasRoot });
    await client.invoke("git_unstage_all", { cwd: DEMO.atlasRoot });
    await settle();
    expect(heard.mock.calls).toEqual([[{ cwd: DEMO.atlasRoot }]]);

    // Two watches, so one unwatch leaves it watched.
    await client.invoke("git_unwatch", { cwd: DEMO.atlasRoot });
    expect(demo.state.watches.git).toEqual({ [DEMO.atlasRoot]: 1 });
    await client.invoke("git_unwatch", { cwd: DEMO.atlasRoot });
    await client.invoke("git_unwatch", { cwd: DEMO.atlasRoot });
    expect(demo.state.watches.git).toEqual({});
  });

  it("stream an op's progress to the op that asked, and none for a command without one", async () => {
    const { client } = bench();
    const progress = vi.fn();
    await client.listen("git-op-progress", progress);
    await client.invoke("git_push", { cwd: DEMO.atlasRoot, remote: "origin", opId: "op-1" });
    await settle();
    expect(progress.mock.calls.every(([p]) => p.opId === "op-1")).toBe(true);
    expect(progress.mock.calls.map(([p]) => p.line)).toContain("Writing objects: 100% (3/3), done.");

    progress.mockClear();
    await client.invoke("git_checkout", { cwd: DEMO.atlasRoot, name: "feat/login-rate-limit", trackRemote: null, opId: null });
    await settle();
    expect(progress).not.toHaveBeenCalled();
  });

  it("have no op left to cancel, since every demo op is over when it answers", async () => {
    const { client } = bench();
    await expect(client.invoke("git_cancel_op", { opId: "op-1" })).resolves.toBe(false);
  });
});

describe("the Demo's file commands", () => {
  it("open in the app what the host opens in the app", async () => {
    const host = /VIEWABLE_EXTENSIONS: &\[&str\] = &\[([\s\S]*?)\];/.exec(hostFileViewer)?.[1] ?? "";
    const expected = [...host.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(expected.length).toBeGreaterThan(10);
    const { client } = bench();
    await expect(client.invoke("viewable_extensions")).resolves.toEqual(expected);
  });

  it("list only below an open workspace's root", async () => {
    const { client } = bench();
    await expect(client.invoke("list_directory", { root: "/Users/demo", path: "/Users/demo" })).rejects.toThrow(
      "/Users/demo is not the root of an open workspace"
    );
    await expect(client.invoke("list_directory", { root: DEMO.atlasRoot, path: `${DEMO.atlasRoot}/README.md` })).rejects.toThrow(
      "is not a directory"
    );
  });

  it("refuse to read or write a folder as a file", async () => {
    const { client } = bench();
    await expect(client.invoke("read_file_for_viewer", { path: `${DEMO.atlasRoot}/src` })).rejects.toThrow("Is a directory");
    await expect(client.invoke("write_file_for_editor", { path: `${DEMO.atlasRoot}/src`, content: "" })).rejects.toThrow(
      "Is a directory"
    );
  });

  it("create a file by writing it, which is how a new one is saved", async () => {
    const { demo, client } = bench();
    await client.invoke("write_file_for_editor", { path: `${DEMO.notesRoot}/notes/today.md`, content: "# Today\n" });
    expect(demo.state.files[`${DEMO.notesRoot}/notes/today.md`]).toBe("# Today\n");
    const listing = await client.invoke<{ entries: { name: string }[] }>("list_directory", {
      root: DEMO.notesRoot,
      path: `${DEMO.notesRoot}/notes`,
    });
    expect(listing.entries.map((e) => e.name)).toEqual(["2026-09-offline.md", "today.md"]);
    const status = await client.invoke<{ unstaged: unknown[] }>("git_status", { cwd: DEMO.notesRoot });
    expect(status.unstaged).toEqual([{ path: "notes/today.md", status: "?" }]);
  });
});
