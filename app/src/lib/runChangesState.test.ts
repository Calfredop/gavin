import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("./backend", () => ({
  gitRunChanges: vi.fn(),
  gitDiffSince: vi.fn(),
  gitDiscardRun: vi.fn(),
}));

import * as backend from "./backend";
import {
  closeRunChanges,
  discardRun,
  openRunChanges,
  refreshRunChanges,
  runChangesStore,
  selectRunFile,
} from "./runChangesState";
import type { FileDiff, RunChanges } from "./git";

const PATH = "/ws/.gavin-root/plans/t.md";
const BASE = "1111111111111111111111111111111111111111";

function changes(over: Partial<RunChanges> = {}): RunChanges {
  return {
    baseSha: BASE,
    notARepo: false,
    baseMissing: false,
    root: "/repo",
    baseSubject: "base",
    files: [{ path: "a.ts", status: "M" }],
    added: 3,
    removed: 1,
    commits: 0,
    ...over,
  };
}

const emptyDiff: FileDiff = { path: "a.ts", binary: false, tooLarge: false, hunks: [] };

beforeEach(() => {
  vi.clearAllMocks();
  runChangesStore.set({});
});

describe("openRunChanges", () => {
  it("loads the run and keys the view on the card path", async () => {
    vi.mocked(backend.gitRunChanges).mockResolvedValue(changes());

    await openRunChanges(PATH, "/repo/wt", BASE);

    expect(backend.gitRunChanges).toHaveBeenCalledWith("/repo/wt", BASE);
    const view = get(runChangesStore)[PATH];
    expect(view.changes?.files).toHaveLength(1);
    expect(view.loading).toBe(false);
    expect(view.error).toBeNull();
  });

  /// A re-launch mints a new baseline. Keeping the previous run's file
  /// list under the new sha would show a diff of a run that no longer
  /// exists, in a modal that says it is showing this one.
  it("drops everything when the run it is pointed at changes", async () => {
    vi.mocked(backend.gitRunChanges).mockResolvedValue(changes());
    await openRunChanges(PATH, "/repo/wt", BASE);
    await selectRunFile(PATH, "a.ts");
    expect(get(runChangesStore)[PATH].selected).toBe("a.ts");

    vi.mocked(backend.gitRunChanges).mockResolvedValue(changes({ baseSha: "2".repeat(40), files: [] }));
    await openRunChanges(PATH, "/repo/wt", "2".repeat(40));

    const view = get(runChangesStore)[PATH];
    expect(view.selected).toBeNull();
    expect(view.diff).toBeNull();
    expect(view.changes?.files).toEqual([]);
  });

  it("keeps the selection when re-opened on the SAME run", async () => {
    vi.mocked(backend.gitRunChanges).mockResolvedValue(changes());
    vi.mocked(backend.gitDiffSince).mockResolvedValue(emptyDiff);
    await openRunChanges(PATH, "/repo/wt", BASE);
    await selectRunFile(PATH, "a.ts");

    await openRunChanges(PATH, "/repo/wt", BASE);

    expect(get(runChangesStore)[PATH].selected).toBe("a.ts");
  });

  it("reports a failure as a sentence rather than an empty view", async () => {
    vi.mocked(backend.gitRunChanges).mockRejectedValue(new Error("git exploded"));

    await openRunChanges(PATH, "/repo/wt", BASE);

    const view = get(runChangesStore)[PATH];
    expect(view.error).toContain("git exploded");
    expect(view.loading).toBe(false);
    expect(view.changes).toBeNull();
  });
});

describe("selectRunFile", () => {
  it("diffs against the run's baseline, and marks an untracked file as such", async () => {
    vi.mocked(backend.gitRunChanges).mockResolvedValue(
      changes({ files: [{ path: "new.ts", status: "?" }] })
    );
    vi.mocked(backend.gitDiffSince).mockResolvedValue({ ...emptyDiff, path: "new.ts" });
    await openRunChanges(PATH, "/repo/wt", BASE);

    await selectRunFile(PATH, "new.ts");

    expect(backend.gitDiffSince).toHaveBeenCalledWith("/repo/wt", BASE, "new.ts", null, true);
    expect(get(runChangesStore)[PATH].diff?.path).toBe("new.ts");
  });

  it("carries a rename's old path so the diff has both sides", async () => {
    vi.mocked(backend.gitRunChanges).mockResolvedValue(
      changes({ files: [{ path: "new.ts", oldPath: "old.ts", status: "R" }] })
    );
    vi.mocked(backend.gitDiffSince).mockResolvedValue(emptyDiff);
    await openRunChanges(PATH, "/repo/wt", BASE);

    await selectRunFile(PATH, "new.ts");

    expect(backend.gitDiffSince).toHaveBeenCalledWith("/repo/wt", BASE, "new.ts", "old.ts", false);
  });

  /// The proxy trap this whole store is shaped around: `$state` makes
  /// object identity useless, so supersession is a counter. A slow diff
  /// landing after a newer one must not overwrite it.
  it("a superseded diff never lands", async () => {
    vi.mocked(backend.gitRunChanges).mockResolvedValue(
      changes({ files: [{ path: "a.ts", status: "M" }, { path: "b.ts", status: "M" }] })
    );
    await openRunChanges(PATH, "/repo/wt", BASE);

    let releaseSlow!: (d: FileDiff) => void;
    vi.mocked(backend.gitDiffSince).mockImplementationOnce(
      () => new Promise<FileDiff>((resolve) => (releaseSlow = resolve))
    );
    const slow = selectRunFile(PATH, "a.ts");
    vi.mocked(backend.gitDiffSince).mockResolvedValue({ ...emptyDiff, path: "b.ts" });
    await selectRunFile(PATH, "b.ts");

    releaseSlow({ ...emptyDiff, path: "a.ts" });
    await slow;

    expect(get(runChangesStore)[PATH].diff?.path).toBe("b.ts");
  });
});

describe("discardRun", () => {
  it("removes exactly the untracked files the human was shown, then refreshes", async () => {
    vi.mocked(backend.gitRunChanges).mockResolvedValue(
      changes({
        files: [
          { path: "a.ts", status: "M" },
          { path: "new.ts", status: "?" },
        ],
      })
    );
    await openRunChanges(PATH, "/repo/wt", BASE);
    vi.mocked(backend.gitDiscardRun).mockResolvedValue({ trashed: ["new.ts"], failed: [] });
    vi.mocked(backend.gitRunChanges).mockResolvedValue(changes({ files: [], added: 0, removed: 0 }));

    const result = await discardRun(PATH);

    expect(backend.gitDiscardRun).toHaveBeenCalledWith("/repo/wt", BASE, ["new.ts"]);
    expect("report" in result && result.report.trashed).toEqual(["new.ts"]);
    // The view is re-read, so the modal shows the reset checkout rather
    // than the list it just destroyed.
    expect(get(runChangesStore)[PATH].changes?.files).toEqual([]);
    expect(get(runChangesStore)[PATH].busy).toBe(false);
  });

  it("reports a refusal instead of pretending it happened", async () => {
    vi.mocked(backend.gitRunChanges).mockResolvedValue(changes());
    await openRunChanges(PATH, "/repo/wt", BASE);
    vi.mocked(backend.gitDiscardRun).mockRejectedValue(new Error("index.lock"));

    const result = await discardRun(PATH);

    expect("error" in result && result.error).toContain("index.lock");
    expect(get(runChangesStore)[PATH].busy).toBe(false);
    expect(get(runChangesStore)[PATH].error).toContain("index.lock");
  });

  it("refuses when there is nothing loaded to discard", async () => {
    expect(await discardRun(PATH)).toEqual({ error: "This run's changes are not loaded." });
    expect(backend.gitDiscardRun).not.toHaveBeenCalled();
  });
});

describe("closeRunChanges", () => {
  it("drops the view, so a closed modal holds no diff", async () => {
    vi.mocked(backend.gitRunChanges).mockResolvedValue(changes());
    await openRunChanges(PATH, "/repo/wt", BASE);

    closeRunChanges(PATH);

    expect(get(runChangesStore)[PATH]).toBeUndefined();
  });
});

describe("refreshRunChanges", () => {
  it("is a no-op for a card with no view", async () => {
    await refreshRunChanges(PATH);
    expect(backend.gitRunChanges).not.toHaveBeenCalled();
  });

  it("re-reads the selected file too, since that is why anyone refreshes", async () => {
    vi.mocked(backend.gitRunChanges).mockResolvedValue(changes());
    vi.mocked(backend.gitDiffSince).mockResolvedValue(emptyDiff);
    await openRunChanges(PATH, "/repo/wt", BASE);
    await selectRunFile(PATH, "a.ts");
    vi.mocked(backend.gitDiffSince).mockClear();

    await refreshRunChanges(PATH);

    expect(backend.gitDiffSince).toHaveBeenCalledWith("/repo/wt", BASE, "a.ts", null, false);
  });
});
