import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("$lib/backend", () => ({
  gitRunChanges: vi.fn(),
  gitDiffSince: vi.fn(),
}));

import * as backend from "$lib/backend";
import {
  FETCH_CONCURRENCY,
  clearReviewFile,
  loadTouchedFiles,
  reviewStore,
  selectReviewFile,
  viewFor,
  type TouchRequest,
  type TouchedRun,
} from "$lib/reviewState";
import type { FileDiff, RunChanges } from "$lib/git";

const WS = "ws1";
const BASE = "1111111111111111111111111111111111111111";

function changes(over: Partial<RunChanges> = {}): RunChanges {
  return {
    baseSha: BASE,
    notARepo: false,
    baseMissing: false,
    root: "/repo",
    baseSubject: "base",
    files: [{ path: "app/src/lib/git.ts", status: "M" }],
    added: 3,
    removed: 1,
    commits: 0,
    untilSha: null,
    ...over,
  };
}

function request(path: string, over: Partial<TouchRequest> = {}): TouchRequest {
  return { path, cwd: "/repo", baseSha: BASE, peers: [], ...over };
}

const runChanges = vi.mocked(backend.gitRunChanges);
const diffSince = vi.mocked(backend.gitDiffSince);

beforeEach(() => {
  reviewStore.set({});
  runChanges.mockReset();
  diffSince.mockReset();
});

describe("loadTouchedFiles", () => {
  it("records the paths a run touched", async () => {
    runChanges.mockResolvedValue(changes());
    await loadTouchedFiles(WS, [request("/a.md")]);
    expect(viewFor(WS).runs["/a.md"].files).toEqual(["app/src/lib/git.ts"]);
    expect(viewFor(WS).loadingPaths).toEqual([]);
  });

  it("keeps a measured empty run apart from an unmeasurable one", async () => {
    runChanges.mockResolvedValueOnce(changes({ files: [] }));
    runChanges.mockResolvedValueOnce(changes({ baseMissing: true }));
    await loadTouchedFiles(WS, [request("/empty.md")]);
    await loadTouchedFiles(WS, [request("/gone.md")]);
    // Measured and moved nothing.
    expect(viewFor(WS).runs["/empty.md"].files).toEqual([]);
    expect(viewFor(WS).runs["/empty.md"].problem).toBeNull();
    // Has a baseline the checkout can no longer be diffed against: not
    // measured, and never reported as a run that changed nothing.
    expect(viewFor(WS).runs["/gone.md"].files).toBeNull();
    expect(viewFor(WS).runs["/gone.md"].problem).toMatch(/not in this checkout/);
  });

  it("says so when a run's folder is not a repository", async () => {
    runChanges.mockResolvedValue(changes({ notARepo: true }));
    await loadTouchedFiles(WS, [request("/a.md")]);
    expect(viewFor(WS).runs["/a.md"].files).toBeNull();
    expect(viewFor(WS).runs["/a.md"].problem).toMatch(/not inside a git repository/);
  });

  it("keeps one card's failure off every other card", async () => {
    runChanges.mockRejectedValueOnce(new Error("git exploded"));
    runChanges.mockResolvedValueOnce(changes());
    await loadTouchedFiles(WS, [request("/bad.md")]);
    await loadTouchedFiles(WS, [request("/good.md")]);
    expect(viewFor(WS).runs["/bad.md"].error).toMatch(/git exploded/);
    expect(viewFor(WS).runs["/bad.md"].files).toBeNull();
    expect(viewFor(WS).runs["/good.md"].files).toEqual(["app/src/lib/git.ts"]);
  });

  it("does not re-read a card whose baseline has not moved", async () => {
    runChanges.mockResolvedValue(changes());
    await loadTouchedFiles(WS, [request("/a.md")]);
    await loadTouchedFiles(WS, [request("/a.md")]);
    expect(runChanges).toHaveBeenCalledTimes(1);
  });

  it("re-reads a card that was re-launched onto a new baseline", async () => {
    runChanges.mockResolvedValue(changes());
    await loadTouchedFiles(WS, [request("/a.md")]);
    await loadTouchedFiles(WS, [request("/a.md", { baseSha: "2".repeat(40) })]);
    expect(runChanges).toHaveBeenCalledTimes(2);
  });

  it("re-reads a card whose run moved to another checkout", async () => {
    runChanges.mockResolvedValue(changes());
    await loadTouchedFiles(WS, [request("/a.md")]);
    await loadTouchedFiles(WS, [request("/a.md", { cwd: "/other" })]);
    expect(runChanges).toHaveBeenCalledTimes(2);
  });

  it("asks git where this run's window ends", async () => {
    runChanges.mockResolvedValue(changes());
    await loadTouchedFiles(WS, [request("/a.md", { peers: [BASE, "2".repeat(40)] })]);
    expect(runChanges).toHaveBeenCalledWith("/repo", BASE, [BASE, "2".repeat(40)]);
  });

  it("re-reads a card once a later run appears beside it", async () => {
    // The peers decide where the window ends, so the stored answer is
    // about a window that no longer exists.
    runChanges.mockResolvedValue(changes());
    await loadTouchedFiles(WS, [request("/a.md")]);
    await loadTouchedFiles(WS, [request("/a.md", { peers: ["2".repeat(40)] })]);
    expect(runChanges).toHaveBeenCalledTimes(2);
  });

  it("keeps the bound git resolved, for the file diffs under it", async () => {
    const until = "2".repeat(40);
    runChanges.mockResolvedValue(changes({ untilSha: until }));
    await loadTouchedFiles(WS, [request("/a.md", { peers: [until] })]);
    expect(viewFor(WS).runs["/a.md"].untilSha).toBe(until);
  });

  it("re-reads everything when Refresh forces it", async () => {
    runChanges.mockResolvedValue(changes());
    await loadTouchedFiles(WS, [request("/a.md")]);
    await loadTouchedFiles(WS, [request("/a.md")], { force: true });
    expect(runChanges).toHaveBeenCalledTimes(2);
  });

  it("caps how many diffs run at once", async () => {
    let live = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    runChanges.mockImplementation(() => {
      live += 1;
      peak = Math.max(peak, live);
      return new Promise<RunChanges>((resolve) => {
        release.push(() => {
          live -= 1;
          resolve(changes());
        });
      });
    });
    const requests = Array.from({ length: 12 }, (_, i) => request(`/c${i}.md`));
    const done = loadTouchedFiles(WS, requests);
    // Drain in waves: each release lets the pool start the next one.
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
      release.shift()?.();
      await Promise.resolve();
    }
    await done;
    expect(peak).toBeLessThanOrEqual(FETCH_CONCURRENCY);
    expect(runChanges).toHaveBeenCalledTimes(12);
  });

  it("marks every requested card as loading while its diff is in flight", async () => {
    let resolve!: (c: RunChanges) => void;
    runChanges.mockReturnValue(new Promise<RunChanges>((r) => (resolve = r)));
    const done = loadTouchedFiles(WS, [request("/a.md")]);
    await Promise.resolve();
    expect(viewFor(WS).loadingPaths).toEqual(["/a.md"]);
    resolve(changes());
    await done;
    expect(viewFor(WS).loadingPaths).toEqual([]);
  });

  it("drops a superseded batch rather than mixing it into the next", async () => {
    let resolveFirst!: (c: RunChanges) => void;
    runChanges.mockReturnValueOnce(new Promise<RunChanges>((r) => (resolveFirst = r)));
    const first = loadTouchedFiles(WS, [request("/a.md")]);
    await Promise.resolve();

    runChanges.mockResolvedValue(changes({ files: [{ path: "second.ts", status: "M" }] }));
    await loadTouchedFiles(WS, [request("/b.md")]);

    resolveFirst(changes());
    await first;
    // The first batch's answer arrived after a newer one started, so it
    // is not stored.
    expect(viewFor(WS).runs["/a.md"]).toBeUndefined();
    expect(viewFor(WS).runs["/b.md"].files).toEqual(["second.ts"]);
  });

  it("asks for nothing when there is nothing to ask about", async () => {
    await loadTouchedFiles(WS, []);
    expect(runChanges).not.toHaveBeenCalled();
  });

  it("leaves nothing loading that no batch is reading any more", async () => {
    // The failure this covers is a Refresh button that never comes back.
    // A superseded worker returns without clearing its path, so a batch
    // narrowed under it -- the human types in the search box while ten
    // cards load -- used to leave the other nine in `loadingPaths` for
    // the life of the store, and the tab derives `loading` from that.
    const gates: Array<() => void> = [];
    runChanges.mockImplementation(
      () => new Promise<RunChanges>((resolve) => gates.push(() => resolve(changes())))
    );

    const wide = ["/a.md", "/b.md", "/c.md", "/d.md", "/e.md", "/f.md"].map((p) => request(p));
    const first = loadTouchedFiles(WS, wide);
    await Promise.resolve();
    expect(viewFor(WS).loadingPaths).toHaveLength(wide.length);

    const second = loadTouchedFiles(WS, [request("/z.md")]);
    expect(viewFor(WS).loadingPaths).toEqual(["/z.md"]);

    for (let i = 0; i < 20 && gates.length > 0; i++) {
      gates.splice(0).forEach((resolve) => resolve());
      await Promise.resolve();
      await Promise.resolve();
    }
    await Promise.all([first, second]);
    expect(viewFor(WS).loadingPaths).toEqual([]);
  });
});

describe("selectReviewFile", () => {
  const run: TouchedRun = {
    cwd: "/repo",
    baseSha: BASE,
    untilSha: null,
    peers: [],
    changes: changes(),
    files: ["app/src/lib/git.ts"],
    problem: null,
    error: null,
  };
  const diff: FileDiff = { path: "app/src/lib/git.ts", binary: false, tooLarge: false, hunks: [] };

  it("reads the file against that card's baseline", async () => {
    diffSince.mockResolvedValue(diff);
    await selectReviewFile(WS, run, "app/src/lib/git.ts");
    expect(diffSince).toHaveBeenCalledWith("/repo", BASE, "app/src/lib/git.ts", null, false, null);
    expect(viewFor(WS).selectedFile).toBe("app/src/lib/git.ts");
    expect(viewFor(WS).diff).toEqual(diff);
  });

  it("takes the no-index route for an untracked file", async () => {
    const untracked: TouchedRun = {
      ...run,
      changes: changes({ files: [{ path: "new.ts", status: "?" }] }),
    };
    diffSince.mockResolvedValue({ ...diff, path: "new.ts" });
    await selectReviewFile(WS, untracked, "new.ts");
    expect(diffSince).toHaveBeenCalledWith("/repo", BASE, "new.ts", null, true, null);
  });

  it("reads the file under the same bound as the row that opened it", async () => {
    // Otherwise a file the next run also edited opens showing that
    // run's hunks under this card's name.
    const until = "2".repeat(40);
    diffSince.mockResolvedValue(diff);
    await selectReviewFile(WS, { ...run, untilSha: until }, "app/src/lib/git.ts");
    expect(diffSince).toHaveBeenCalledWith("/repo", BASE, "app/src/lib/git.ts", null, false, until);
  });

  it("ignores a file the run never touched", async () => {
    await selectReviewFile(WS, run, "somewhere/else.ts");
    expect(diffSince).not.toHaveBeenCalled();
  });

  it("reports a failure without leaving the old diff on screen", async () => {
    diffSince.mockResolvedValueOnce(diff);
    await selectReviewFile(WS, run, "app/src/lib/git.ts");
    diffSince.mockRejectedValueOnce(new Error("too big"));
    await selectReviewFile(WS, run, "app/src/lib/git.ts");
    expect(viewFor(WS).diff).toBeNull();
    expect(viewFor(WS).diffError).toMatch(/too big/);
  });

  it("drops a superseded read", async () => {
    let resolveFirst!: (d: FileDiff) => void;
    diffSince.mockReturnValueOnce(new Promise<FileDiff>((r) => (resolveFirst = r)));
    const first = selectReviewFile(WS, run, "app/src/lib/git.ts");
    diffSince.mockResolvedValueOnce({ ...diff, path: "other" });
    const second: TouchedRun = { ...run, changes: changes({ files: [{ path: "other", status: "M" }] }) };
    await selectReviewFile(WS, second, "other");
    resolveFirst(diff);
    await first;
    expect(viewFor(WS).diff?.path).toBe("other");
  });
});

describe("clearReviewFile", () => {
  it("drops the diff but keeps the touched-file cache", async () => {
    runChanges.mockResolvedValue(changes());
    await loadTouchedFiles(WS, [request("/a.md")]);
    diffSince.mockResolvedValue({ path: "app/src/lib/git.ts", binary: false, tooLarge: false, hunks: [] });
    await selectReviewFile(WS, viewFor(WS).runs["/a.md"], "app/src/lib/git.ts");

    clearReviewFile(WS);
    expect(viewFor(WS).diff).toBeNull();
    expect(viewFor(WS).selectedFile).toBeNull();
    // The cache survives, so returning to the tab costs no gits.
    expect(viewFor(WS).runs["/a.md"].files).toEqual(["app/src/lib/git.ts"]);
  });
});
