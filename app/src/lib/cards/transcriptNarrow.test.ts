import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("$lib/core/backend", () => ({
  cardRunTouchedFiles: vi.fn(),
  shellWrites: vi.fn(),
}));

vi.mock("$lib/core/layoutState", async () => {
  const { writable } = await import("svelte/store");
  return { daemonCompat: writable(null) };
});

import * as backend from "$lib/core/backend";
import { daemonCompat } from "$lib/core/layoutState";
import { narrowToTranscript } from "$lib/cards/transcriptNarrow";
import type { RunChanges } from "$lib/git/git";

const BASE = "1111111111111111111111111111111111111111";
const WS = "ws1";
const NO_RECORDS: backend.ShellWrites = { calls: [], files: [] };

function changes(over: Partial<RunChanges> = {}): RunChanges {
  return {
    baseSha: BASE,
    notARepo: false,
    baseMissing: false,
    root: "/repo",
    baseSubject: "base",
    files: [
      { path: "a.ts", status: "M" },
      { path: "b.ts", status: "M" },
      { path: "c.ts", status: "?" },
      { path: "moved.ts", oldPath: "was.ts", status: "R" },
    ],
    added: 3,
    removed: 1,
    commits: 0,
    untilSha: null,
    ...over,
  };
}

const editedFiles = vi.mocked(backend.cardRunTouchedFiles);
const shellWrites = vi.mocked(backend.shellWrites);

beforeEach(() => {
  editedFiles.mockReset();
  shellWrites.mockReset();
  shellWrites.mockResolvedValue(NO_RECORDS);
  daemonCompat.set({ daemonVersion: 72, appVersion: 72, degraded: false });
});

describe("narrowToTranscript", () => {
  it("keeps only the files the run's own agent edited", async () => {
    editedFiles.mockResolvedValue({ kind: "ready", paths: ["a.ts"] });
    const narrowed = await narrowToTranscript(
      WS,
      { cwd: "/repo", conversationId: "conv-1" },
      changes()
    );
    expect(editedFiles).toHaveBeenCalledWith(
      "conv-1",
      "/repo",
      "/repo",
      ["a.ts", "b.ts", "c.ts", "moved.ts", "was.ts"],
      NO_RECORDS
    );
    expect(narrowed?.files.map((f) => f.path)).toEqual(["a.ts"]);
  });

  it("keeps a rename whose old path the agent wrote", async () => {
    editedFiles.mockResolvedValue({ kind: "ready", paths: ["was.ts"] });
    const narrowed = await narrowToTranscript(
      WS,
      { cwd: "/repo", conversationId: "conv-1" },
      changes()
    );
    expect(narrowed?.files.map((f) => f.path)).toEqual(["moved.ts"]);
  });

  it("returns an empty file list when the agent touched none of the dirty files", async () => {
    editedFiles.mockResolvedValue({ kind: "ready", paths: [] });
    const narrowed = await narrowToTranscript(
      WS,
      { cwd: "/repo", conversationId: "conv-1" },
      changes()
    );
    expect(narrowed?.files).toEqual([]);
  });

  it("returns null when there is no conversation id", async () => {
    expect(await narrowToTranscript(WS, { cwd: "/repo" }, changes())).toBeNull();
    expect(editedFiles).not.toHaveBeenCalled();
  });

  it("returns null when the transcript has no answer", async () => {
    editedFiles.mockResolvedValue({ kind: "unavailable", reason: "gone" });
    expect(
      await narrowToTranscript(WS, { cwd: "/repo", conversationId: "conv-1" }, changes())
    ).toBeNull();
  });

  it("returns null when the host refuses the read", async () => {
    editedFiles.mockRejectedValue(new Error("unknown command"));
    expect(
      await narrowToTranscript(WS, { cwd: "/repo", conversationId: "conv-1" }, changes())
    ).toBeNull();
  });

  it("hands the reader what the shell-write hook recorded", async () => {
    const observed: backend.ShellWrites = {
      calls: ["toolu_1"],
      files: [{ root: "/repo", paths: ["b.ts"] }],
    };
    shellWrites.mockResolvedValue(observed);
    editedFiles.mockResolvedValue({ kind: "ready", paths: ["b.ts"] });
    await narrowToTranscript(WS, { cwd: "/repo", conversationId: "conv-1" }, changes());
    expect(shellWrites).toHaveBeenCalledWith(WS, "conv-1");
    expect(editedFiles.mock.calls[0][4]).toEqual(observed);
  });

  it("does not ask a daemon older than the records, and reads the transcript alone", async () => {
    daemonCompat.set({ daemonVersion: 71, appVersion: 72, degraded: true });
    editedFiles.mockResolvedValue({ kind: "ready", paths: ["a.ts"] });
    await narrowToTranscript(WS, { cwd: "/repo", conversationId: "conv-1" }, changes());
    expect(shellWrites).not.toHaveBeenCalled();
    expect(editedFiles.mock.calls[0][4]).toBeNull();
  });
});
