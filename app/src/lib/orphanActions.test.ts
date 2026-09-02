import { describe, it, expect, vi, beforeEach } from "vitest";
import { writable } from "svelte/store";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn().mockResolvedValue(true),
  message: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./backend", () => ({
  endOrphan: vi.fn(),
}));
vi.mock("./layoutState", () => ({
  layoutState: writable({ orphanBySessionId: {} }),
  handleOrphanEnded: vi.fn(),
}));

import { confirm, message } from "@tauri-apps/plugin-dialog";
import * as backend from "./backend";
import { layoutState, handleOrphanEnded } from "./layoutState";
import { endSessionOrphan } from "./orphanActions";
import type { OrphanProcess } from "./orphan";

const ORPHAN: OrphanProcess = { pid: 4172, command: "claude --model opus" };

function withOrphan(orphan: OrphanProcess | null): void {
  layoutState.set({ orphanBySessionId: orphan ? { "s-1": orphan } : {} } as never);
}

describe("endSessionOrphan", () => {
  beforeEach(() => {
    vi.mocked(confirm).mockClear().mockResolvedValue(true);
    vi.mocked(message).mockClear();
    vi.mocked(backend.endOrphan).mockReset();
    vi.mocked(handleOrphanEnded).mockClear();
    withOrphan(ORPHAN);
  });

  it("does nothing at all for a session with no orphan recorded", async () => {
    withOrphan(null);
    await endSessionOrphan("s-1");
    expect(confirm).not.toHaveBeenCalled();
    expect(backend.endOrphan).not.toHaveBeenCalled();
  });

  it("always confirms first, and names the process in the prompt", async () => {
    // Killing something gavin no longer hosts is outside what the session
    // owns and has no undo, so it is never a bare click -- and a
    // confirmation that does not say WHICH process is not one.
    vi.mocked(backend.endOrphan).mockResolvedValue({ ended: true, stillRunning: false });
    await endSessionOrphan("s-1");
    expect(vi.mocked(confirm).mock.calls[0][0]).toContain("claude --model opus (pid 4172)");
  });

  it("sends nothing when the human declines", async () => {
    vi.mocked(confirm).mockResolvedValue(false);
    await endSessionOrphan("s-1");
    expect(backend.endOrphan).not.toHaveBeenCalled();
  });

  it("asks the daemon by session id, never by pid", async () => {
    // The daemon looks up the process IT recorded and re-probes its
    // identity. A pid on the wire would make this request a way to
    // signal anything on the machine.
    vi.mocked(backend.endOrphan).mockResolvedValue({ ended: true, stillRunning: false });
    await endSessionOrphan("s-1");
    expect(backend.endOrphan).toHaveBeenCalledWith("s-1");
  });

  it("clears the badge and stays silent when the process really ended", async () => {
    vi.mocked(backend.endOrphan).mockResolvedValue({ ended: true, stillRunning: false });
    await endSessionOrphan("s-1");
    expect(handleOrphanEnded).toHaveBeenCalledWith("s-1");
    expect(message).not.toHaveBeenCalled();
  });

  it("keeps the badge and speaks up when the process ignored the signal", async () => {
    // The badge disappearing would be the app reassuring the human about
    // something it just watched fail. The process is still editing the
    // checkout.
    vi.mocked(backend.endOrphan).mockResolvedValue({ ended: false, stillRunning: true });
    await endSessionOrphan("s-1");
    expect(handleOrphanEnded).not.toHaveBeenCalled();
    expect(vi.mocked(message).mock.calls[0][0]).toContain("still running");
  });

  it("clears the badge when the daemon reports nothing was there to end", async () => {
    // ended false with stillRunning false means the daemon had no orphan
    // recorded -- so the app's own state is the stale half, and the badge
    // has to go even though nothing was killed.
    vi.mocked(backend.endOrphan).mockResolvedValue({ ended: false, stillRunning: false });
    await endSessionOrphan("s-1");
    expect(handleOrphanEnded).toHaveBeenCalledWith("s-1");
    expect(vi.mocked(message).mock.calls[0][0]).toContain("already gone");
  });

  it("keeps the badge and names the process when the request itself fails", async () => {
    // A failed request proves nothing about the process, so the warning
    // has to stay up.
    vi.mocked(backend.endOrphan).mockRejectedValue(new Error("daemon went away"));
    await endSessionOrphan("s-1");
    expect(handleOrphanEnded).not.toHaveBeenCalled();
    expect(vi.mocked(message).mock.calls[0][0]).toContain("pid 4172");
  });
});
