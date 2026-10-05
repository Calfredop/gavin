// Seam 2 for the Git surface: the desktop's own Git state and actions
// (`gitState.ts`, unchanged) on one end of the channel, the Demo
// Workstation on the other, and the wire between them read message by
// message.
//
// The phone's Git surface is a template over exactly these calls, so
// this is what it sends: the reads a refresh makes, each action's
// command with the arguments the desk's host takes, the op id that ties
// a push's progress to the bar that shows it, and nothing that saves the
// desk's layout.
import { afterEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import * as backend from "$lib/core/backend";
import {
  checkout,
  commit,
  createBranch,
  ensureGitView,
  fetch,
  gitStore,
  mergeBranch,
  pull,
  push,
  refresh,
  select,
  setCommitDraft,
  stageAll,
  stageFiles,
  startWatching,
  unstageAll,
  unstageFiles,
  type GitViewState,
} from "$lib/git/gitState";
import { DEMO } from "$companion/demo/sampleData";
import type { DemoWorkstation } from "$companion/demo/workstation";
import { disconnectChannel } from "$companion/remote/connection";
import { DESK_ONLY_COMMANDS, LAYOUT_SAVING_COMMANDS } from "$companion/remote/remoteRole";
import { connectDemo, settle } from "$companion/testing/demoBench";
import { resetDesktopStores } from "$companion/testing/desktopStores";
import { allowedToRemoteRole, tableSize } from "$companion/testing/remoteTable";
import { argsOf, mark, traffic } from "$companion/testing/wire";

const ROOT = DEMO.atlasRoot;
const WS = DEMO.atlas;

afterEach(() => {
  disconnectChannel();
  gitStore.set({});
  resetDesktopStores();
});

/// What the surface does when it opens: the view for the root, and one
/// refresh.
async function openGit(): Promise<{ demo: DemoWorkstation; from: number }> {
  const demo = connectDemo();
  const from = mark(demo);
  ensureGitView(WS, ROOT);
  await refresh(WS);
  return { demo, from };
}

function view(): GitViewState {
  return get(gitStore)[WS];
}

/// A refresh's reads, in order: what every action ends with.
const READS = ["invoke git_repo_info", "invoke git_status", "invoke git_refs", "invoke git_merge_tool_name"];

const OP_ID = expect.stringMatching(/^[0-9a-f-]{36}$/);

describe("opening the Git surface", () => {
  it("reads the repository at the workspace's root, as the desk's tab does", async () => {
    const { demo, from } = await openGit();
    expect(traffic(demo, from)).toEqual(READS);
    for (const cmd of ["git_repo_info", "git_status", "git_refs", "git_merge_tool_name"]) {
      expect(argsOf(demo, cmd, from)).toEqual([{ cwd: ROOT }]);
    }
  });

  it("fills the desktop's Git store with what the Workstation holds", async () => {
    await openGit();
    expect(view().repo).toMatchObject({ branch: "main", notARepo: false });
    expect(view().status).toEqual({
      unstaged: [
        { path: "src/auth/rotation.ts", status: "?" },
        { path: "src/auth/tokens.ts", status: "M" },
      ],
      staged: [{ path: "test/tokens.test.ts", status: "M" }],
    });
    expect(view().refs?.branches.find((b) => b.current)).toMatchObject({ name: "main", ahead: 1 });
  });

  it("watches the checkout while it is up, refreshes on the Workstation's news, and lets go", async () => {
    const { demo } = await openGit();
    let from = mark(demo);
    const stop = await startWatching(WS);
    expect(traffic(demo, from)).toEqual(["invoke git_watch", "listen git-changed"]);
    expect(argsOf(demo, "git_watch", from)).toEqual([{ cwd: ROOT }]);

    // Someone saves a file at the desk.
    from = mark(demo);
    await backend.writeFileForEditor(`${ROOT}/README.md`, "# atlas-api\n\nRewritten.\n");
    await settle();
    expect(traffic(demo, from)).toEqual(["invoke write_file_for_editor", ...READS]);
    expect(view().status?.unstaged).toContainEqual({ path: "README.md", status: "M" });

    from = mark(demo);
    stop();
    await settle();
    expect(traffic(demo, from)).toEqual(["unlisten", "invoke git_unwatch"]);
    expect(demo.state.watches.git).toEqual({});
  });
});

describe("reading a diff", () => {
  it("asks for the file's unstaged change, and draws it from the answer", async () => {
    const { demo } = await openGit();
    const from = mark(demo);
    await select(WS, { path: "src/auth/tokens.ts", area: "unstaged" });
    expect(argsOf(demo, "git_diff", from)).toEqual([
      { cwd: ROOT, path: "src/auth/tokens.ts", oldPath: null, staged: false, untracked: false, rev: null },
    ]);
    const added = view().diff?.hunks.flatMap((h) => h.lines).filter((l) => l.kind === "add").map((l) => l.text);
    expect(added).toContain('import { markUsed, wasUsed } from "./rotation.js";');
  });

  it("asks for a staged change against HEAD, and an untracked file whole", async () => {
    const { demo } = await openGit();
    const from = mark(demo);
    await select(WS, { path: "test/tokens.test.ts", area: "staged" });
    await select(WS, { path: "src/auth/rotation.ts", area: "unstaged" });
    expect(argsOf(demo, "git_diff", from).map((a) => [a.path, a.staged, a.untracked])).toEqual([
      ["test/tokens.test.ts", true, false],
      ["src/auth/rotation.ts", false, true],
    ]);
    expect(view().diff?.hunks[0].header.startsWith("@@ -0,0 +1,")).toBe(true);
  });
});

describe("staging", () => {
  it("stages a file with the path the row names, then reads the tree again", async () => {
    const { demo } = await openGit();
    const from = mark(demo);
    expect(await stageFiles(WS, ["src/auth/tokens.ts"])).toBe(true);
    expect(traffic(demo, from)).toEqual(["invoke git_stage_files", ...READS]);
    expect(argsOf(demo, "git_stage_files", from)).toEqual([{ cwd: ROOT, paths: ["src/auth/tokens.ts"] }]);
    expect(view().status?.staged.map((e) => e.path)).toEqual(["src/auth/tokens.ts", "test/tokens.test.ts"]);
  });

  it("unstages a file", async () => {
    const { demo } = await openGit();
    const from = mark(demo);
    expect(await unstageFiles(WS, ["test/tokens.test.ts"])).toBe(true);
    expect(argsOf(demo, "git_unstage_files", from)).toEqual([{ cwd: ROOT, paths: ["test/tokens.test.ts"] }]);
    expect(view().status?.staged).toEqual([]);
  });

  it("stages and unstages everything", async () => {
    const { demo } = await openGit();
    const from = mark(demo);
    await stageAll(WS);
    expect(view().status?.unstaged).toEqual([]);
    await unstageAll(WS);
    expect(view().status?.staged).toEqual([]);
    expect(traffic(demo, from)).toEqual(["invoke git_stage_all", ...READS, "invoke git_unstage_all", ...READS]);
    expect(argsOf(demo, "git_stage_all", from)).toEqual([{ cwd: ROOT }]);
  });

  it("keeps the diff page on a file it stages, now on its staged side", async () => {
    await openGit();
    await select(WS, { path: "src/auth/tokens.ts", area: "unstaged" });
    await stageFiles(WS, ["src/auth/tokens.ts"]);
    expect(view().selected).toEqual({ path: "src/auth/tokens.ts", area: "staged" });
  });
});

describe("committing", () => {
  it("listens for the commit's progress first, then sends the message with its op id", async () => {
    const { demo } = await openGit();
    setCommitDraft(WS, { summary: "Test that a refresh token is single-use", description: "It is spent by its first refresh." });
    const from = mark(demo);
    expect(await commit(WS)).toBe(true);
    expect(traffic(demo, from)).toEqual(["listen git-op-progress", "invoke git_commit", "unlisten", ...READS]);
    expect(argsOf(demo, "git_commit", from)).toEqual([
      {
        cwd: ROOT,
        message: "Test that a refresh token is single-use\n\nIt is spent by its first refresh.",
        amend: false,
        opId: OP_ID,
      },
    ]);
  });

  it("empties what was staged, moves the branch on, and clears the box", async () => {
    await openGit();
    setCommitDraft(WS, { summary: "Test that a refresh token is single-use" });
    await commit(WS);
    expect(view().status?.staged).toEqual([]);
    expect(view().refs?.branches.find((b) => b.current)).toMatchObject({
      ahead: 2,
      subject: "Test that a refresh token is single-use",
    });
    expect(view().commit).toEqual({ summary: "", description: "", amend: false });
  });

  it("sends nothing when there is no message, as the desk's button would not", async () => {
    const { demo } = await openGit();
    const from = mark(demo);
    expect(await commit(WS)).toBe(false);
    expect(traffic(demo, from)).toEqual([]);
  });
});

describe("the remote", () => {
  it("pushes to the branch's remote, with the push's progress on the op bar while it runs", async () => {
    const { demo } = await openGit();
    const lines: string[] = [];
    const stop = gitStore.subscribe((all) => {
      const line = all[WS]?.op?.line;
      if (line && lines.at(-1) !== line) lines.push(line);
    });
    const from = mark(demo);
    expect(await push(WS)).toBe(true);
    stop();
    expect(traffic(demo, from)).toEqual(["listen git-op-progress", "invoke git_push", "unlisten", ...READS]);
    expect(argsOf(demo, "git_push", from)).toEqual([{ cwd: ROOT, remote: "origin", opId: OP_ID }]);
    expect(lines).toContain("Writing objects: 100% (3/3), done.");
    expect(view().op).toBeNull();
    expect(view().refs?.branches.find((b) => b.current)).toMatchObject({ ahead: 0, behind: 0 });
  });

  it("fetches from the remote, and pulls the branch, each as an op", async () => {
    const { demo } = await openGit();
    const from = mark(demo);
    expect(await fetch(WS)).toBe(true);
    expect(await pull(WS)).toBe(true);
    expect(argsOf(demo, "git_fetch", from)).toEqual([{ cwd: ROOT, remote: "origin", opId: OP_ID }]);
    expect(argsOf(demo, "git_pull", from)).toEqual([{ cwd: ROOT, opId: OP_ID }]);
  });

  it("brings a refused push back in the Workstation's words, on the tab's error banner", async () => {
    const demo = connectDemo();
    demo.state.repos[ROOT].remote.branches.main = "1d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d15";
    ensureGitView(WS, ROOT);
    await refresh(WS);
    expect(await push(WS)).toBe(false);
    expect(view().error).toMatch(/^Push failed: To git@github\.com:demo\/atlas-api\.git\n ! \[rejected\]/);
  });
});

describe("branches", () => {
  it("switches to a branch by name, with no remote", async () => {
    const { demo } = await openGit();
    const from = mark(demo);
    expect(await checkout(WS, "feat/login-rate-limit", null)).toBe(true);
    expect(traffic(demo, from)).toEqual(["listen git-op-progress", "invoke git_checkout", "unlisten", ...READS]);
    expect(argsOf(demo, "git_checkout", from)).toEqual([
      { cwd: ROOT, name: "feat/login-rate-limit", trackRemote: null, opId: OP_ID },
    ]);
    expect(view().repo?.branch).toBe("feat/login-rate-limit");
  });

  it("checks out a branch only the remote has, naming the remote", async () => {
    const { demo } = await openGit();
    const from = mark(demo);
    expect(await checkout(WS, "fix/session-expiry", "origin")).toBe(true);
    expect(argsOf(demo, "git_checkout", from)).toEqual([
      { cwd: ROOT, name: "fix/session-expiry", trackRemote: "origin", opId: OP_ID },
    ]);
    expect(view().refs?.branches.find((b) => b.current)).toMatchObject({
      name: "fix/session-expiry",
      upstream: "origin/fix/session-expiry",
    });
  });

  it("creates a branch from HEAD and switches to it", async () => {
    const { demo } = await openGit();
    const from = mark(demo);
    expect((await createBranch(WS, "feat/rotation", null, true)).ok).toBe(true);
    expect(argsOf(demo, "git_create_branch", from)).toEqual([
      { cwd: ROOT, name: "feat/rotation", from: null, checkout: true, opId: OP_ID },
    ]);
    expect(view().repo?.branch).toBe("feat/rotation");
  });

  it("merges a branch into the one checked out", async () => {
    const { demo } = await openGit();
    const from = mark(demo);
    expect(await mergeBranch(WS, "feat/login-rate-limit")).toBe(true);
    expect(traffic(demo, from)).toEqual(["listen git-op-progress", "invoke git_merge", "unlisten", ...READS]);
    expect(argsOf(demo, "git_merge", from)).toEqual([{ cwd: ROOT, branch: "feat/login-rate-limit", opId: OP_ID }]);
    expect(view().repo?.headMessage).toBe("Merge branch 'feat/login-rate-limit'");
  });

  it("brings a refused checkout back as git said it, and leaves the branch where it was", async () => {
    const { demo } = await openGit();
    await backend.writeFileForEditor(`${ROOT}/src/server.ts`, "// edited on the phone\n");
    await refresh(WS);
    expect(await checkout(WS, "feat/login-rate-limit", null)).toBe(false);
    expect(view().error).toMatch(
      /^Checkout feat\/login-rate-limit failed: error: Your local changes to the following files would be overwritten by checkout:\n\tsrc\/server\.ts/
    );
    expect(view().repo?.branch).toBe("main");
    expect(demo.unanswered()).toEqual([]);
  });
});

describe("a whole round, at the wire", () => {
  it("edits, stages, commits and pushes asking nothing the Workstation cannot answer, and nothing a Device may not", async () => {
    const { demo } = await openGit();
    const stop = await startWatching(WS);
    await backend.writeFileForEditor(`${ROOT}/docs/rate-limits.md`, "# Rate limits\n\nFive a minute.\n");
    await settle();
    await select(WS, { path: "docs/rate-limits.md", area: "unstaged" });
    await stageFiles(WS, ["docs/rate-limits.md"]);
    setCommitDraft(WS, { summary: "Say the limit plainly" });
    await commit(WS);
    await push(WS);
    await checkout(WS, "feat/login-rate-limit", null);
    await checkout(WS, "main", null);
    await mergeBranch(WS, "feat/login-rate-limit");
    stop();
    await settle();

    const sent = demo.commands();
    const refused = [...LAYOUT_SAVING_COMMANDS, ...DESK_ONLY_COMMANDS] as readonly string[];
    expect(sent.filter((cmd) => refused.includes(cmd))).toEqual([]);
    // ...and a real Workstation's daemon lets a Device call every one.
    expect(tableSize()).toBeGreaterThan(100);
    expect([...new Set(sent)].filter((cmd) => !allowedToRemoteRole(cmd))).toEqual([]);
    expect(demo.unanswered()).toEqual([]);
    expect(view().error).toBeNull();
    // Pushed, then merged: the merge commit and the branch's own are new.
    expect(view().refs?.branches.find((b) => b.current)).toMatchObject({ name: "main", ahead: 2 });
    // The desk's layout is as the desk left it.
    expect(demo.state.workspaces.activeWorkspaceId).toBe(DEMO.atlas);
  });
});
