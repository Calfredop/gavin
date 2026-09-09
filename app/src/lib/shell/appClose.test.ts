import { describe, it, expect, vi, beforeEach } from "vitest";
import { closeWindowPrompt, sessionsToEnd, survivingSessionsAlert, endEverySession } from "$lib/shell/appClose";
import type { ManagedSession, ManagedSessions } from "$lib/sessions/sessionsManager";
import type { OrphanProcess } from "$lib/sessions/orphan";

vi.mock("$lib/backend", () => ({
  listManagedSessions: vi.fn(),
  killSession: vi.fn(),
  endOrphan: vi.fn(),
}));

import * as backend from "$lib/backend";

function session(fields: Partial<ManagedSession>): ManagedSession {
  return {
    id: "s1",
    workspacePath: "/tmp/ws",
    cwd: "/tmp/ws",
    status: "idle",
    restored: false,
    interrupted: false,
    orphan: null,
    command: null,
    pid: 1,
    rssBytes: 0,
    cpuTimeUs: 0,
    processCount: 1,
    sampledAtUs: 0,
    ...fields,
  };
}

const ORPHAN: OrphanProcess = { pid: 42, command: "npm run dev" };

function sample(sessions: ManagedSession[]): ManagedSessions {
  return { sessions, metrics: true };
}

describe("closeWindowPrompt", () => {
  const prompt = closeWindowPrompt();

  // The verb, not "OK": after a mis-click the label is the only record
  // of what happened.
  it("names both answers", () => {
    expect(prompt.confirmLabel).toBe("Close window");
    expect(prompt.cancelLabel).toBe("Keep open");
  });

  // The whole point of the tick-box: the prompt says what happens if you
  // leave it alone AND what ticking it does, so the human never has to
  // guess which of the two "close" means here.
  it("states the default and what the box changes", () => {
    expect(prompt.lines?.[0]).toContain("keep running");
    expect(prompt.lines?.join(" ")).toContain("Tick the box");
    expect(prompt.check.label).toContain("End every terminal session");
  });

  // A default-on box that ends a day's agents on a reflexive Enter is
  // not a default, it is a trap: the tick must never make the action
  // more destructive than the title says without being asked to.
  it("leaves the box unticked", () => {
    expect(prompt.check.default ?? false).toBe(false);
  });
});

describe("sessionsToEnd", () => {
  it("reaches everything the daemon is still holding", () => {
    const rows = [session({ id: "a" }), session({ id: "b", status: "running" })];
    expect(sessionsToEnd(sample(rows)).map((s) => s.id)).toEqual(["a", "b"]);
  });

  // An exited row is a record with nothing behind it; killing it buys
  // nothing.
  it("skips a row that has already exited", () => {
    const rows = [session({ id: "a", status: "exited" }), session({ id: "b" })];
    expect(sessionsToEnd(sample(rows)).map((s) => s.id)).toEqual(["b"]);
  });

  // ...unless it left a process behind. That one is the reason the box
  // exists, and it is exactly the row the rule above would drop.
  it("keeps an exited row that left an orphan running", () => {
    const rows = [session({ id: "a", status: "exited", orphan: ORPHAN })];
    expect(sessionsToEnd(sample(rows)).map((s) => s.id)).toEqual(["a"]);
  });
});

describe("survivingSessionsAlert", () => {
  it("says nothing when the sweep ended everything", () => {
    expect(survivingSessionsAlert([])).toBeNull();
  });

  // The window closes either way -- the human asked for that -- so the
  // alert has to say so rather than look like a question.
  it("names the survivors and admits the window goes anyway", () => {
    const alert = survivingSessionsAlert(["npm run dev", "claude"]);
    expect(alert?.title).toContain("2");
    expect(alert?.lines.join(" ")).toContain("npm run dev");
    expect(alert?.lines.join(" ")).toContain("closes anyway");
    expect(alert?.dismissLabel).toBe("Close anyway");
  });

  it("counts one session in the singular", () => {
    expect(survivingSessionsAlert(["claude"])?.title).toBe("One session is still running");
  });
});

describe("endEverySession", () => {
  beforeEach(() => {
    vi.mocked(backend.killSession).mockReset().mockResolvedValue(undefined);
    vi.mocked(backend.endOrphan).mockReset().mockResolvedValue({ ended: true, stillRunning: false });
    vi.mocked(backend.listManagedSessions).mockReset();
  });
  it("kills every session the daemon holds", async () => {
    vi.mocked(backend.listManagedSessions).mockResolvedValue(
      sample([session({ id: "a" }), session({ id: "b" })])
    );
    expect(await endEverySession()).toEqual([]);
    expect(vi.mocked(backend.killSession).mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
  });

  // The surviving process is recorded ON the session's registry row, and
  // killing the session deletes that row -- so the other order would
  // leave a live process with nothing left that knows how to end it.
  it("ends a survivor before the session that recorded it", async () => {
    const order: string[] = [];
    vi.mocked(backend.listManagedSessions).mockResolvedValue(
      sample([session({ id: "a", orphan: ORPHAN })])
    );
    vi.mocked(backend.endOrphan).mockImplementation(async () => {
      order.push("orphan");
      return { ended: true, stillRunning: false };
    });
    vi.mocked(backend.killSession).mockImplementation(async () => {
      order.push("session");
    });
    await endEverySession();
    expect(order).toEqual(["orphan", "session"]);
  });

  // One wedged session must not keep the other twenty alive: the window
  // is on its way out, and a throw here would abandon the sweep.
  it("carries on past a refusal and reports it", async () => {
    vi.mocked(backend.listManagedSessions).mockResolvedValue(
      sample([
        session({ id: "a", command: "stubborn", orphan: ORPHAN }),
        session({ id: "b", command: "throws" }),
        session({ id: "c" }),
      ])
    );
    vi.mocked(backend.endOrphan).mockResolvedValue({ ended: false, stillRunning: true });
    vi.mocked(backend.killSession).mockImplementation(async (id: string) => {
      if (id === "b") throw new Error("no");
    });
    expect(await endEverySession()).toEqual(["stubborn", "throws"]);
    // The refusing orphan's session is left alone -- killing it would
    // delete the only handle on the process that survived.
    expect(vi.mocked(backend.killSession).mock.calls.map((c) => c[0])).toEqual(["b", "c"]);
  });

  // A daemon that cannot be reached has no sessions to have failed on.
  it("reports nothing when the list itself cannot be read", async () => {
    vi.mocked(backend.listManagedSessions).mockRejectedValue(new Error("no socket"));
    expect(await endEverySession()).toEqual([]);
    expect(backend.killSession).not.toHaveBeenCalled();
  });
});
