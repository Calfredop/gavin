import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  closeWindowPrompt,
  closeActionsFor,
  sessionsToEnd,
  survivingSessionsAlert,
  endEverySession,
  confirmWindowClose,
  type CloseScope,
} from "$lib/shell/appClose";
import type { ManagedSession, ManagedSessions } from "$lib/sessions/sessionsManager";
import type { OrphanProcess } from "$lib/sessions/orphan";

vi.mock("$lib/core/backend", () => ({
  listManagedSessions: vi.fn(),
  killSession: vi.fn(),
  endOrphan: vi.fn(),
  closeAllWorkspaceWindows: vi.fn(),
  stopDaemon: vi.fn(),
}));

vi.mock("$lib/core/dialog", () => ({
  askConfirmPicked: vi.fn(),
  showAlert: vi.fn(),
}));

vi.mock("$lib/core/confirmGate", () => ({
  grantForAnsweredPrompt: vi.fn(),
  DAEMON_SUBJECT: "",
}));

import * as backend from "$lib/core/backend";
import * as dialog from "$lib/core/dialog";
import * as confirmGate from "$lib/core/confirmGate";

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
    expect(prompt.confirmLabel).toBe("Close");
    expect(prompt.cancelLabel).toBe("Keep open");
  });

  // One question, four outcomes. Two prompts in a row -- "close?" then
  // "and kill?" -- is how a human learns to dismiss the second without
  // reading it, which is exactly the prompt that must not be dismissed
  // unread.
  it("offers the four rungs in increasing severity", () => {
    expect(prompt.picker.options.map((o) => o.value)).toEqual(["window", "windows", "sessions", "daemon"]);
  });

  // Rung 1 is what closing a window has always meant, so that is where
  // the prompt opens. A ladder that starts further up is a default-on
  // tick-box wearing a different hat.
  it("opens on the rung that changes nothing", () => {
    expect(prompt.picker.default).toBe("window");
  });

  // Every rung carries its own consequence. A ladder whose rungs are
  // only named ("Close everything") makes the human infer the cost,
  // which is the one thing this prompt exists to state out loud.
  it("spells out what each rung costs", () => {
    const detail = Object.fromEntries(prompt.picker.options.map((o) => [o.value, o.detail ?? ""]));
    expect(detail.window).toContain("keep running");
    expect(detail.windows).toContain("keep running");
    expect(detail.sessions).toContain("Ends every terminal session");
    expect(detail.daemon).toContain("daemon");
  });

  // Radios, not a dropdown: a <select> folds three of the four answers
  // behind a click, and a prompt whose answers are invisible until
  // clicked cannot claim the human saw them.
  it("shows the rungs rather than folding them into a dropdown", () => {
    expect(prompt.picker.expanded).toBe(true);
  });

  // Enter must not be able to fire a rung that ends a day's agents, so
  // the rungs that end something mark themselves and ConfirmPrompt
  // keeps focus on the dismissing button for those. The two that only
  // move windows about are undone by reopening the app; marking them
  // too would make the mark mean nothing.
  it("marks the rungs that end something, and only those", () => {
    const danger = Object.fromEntries(prompt.picker.options.map((o) => [o.value, o.danger ?? false]));
    expect(danger).toEqual({ window: false, windows: false, sessions: true, daemon: true });
  });

  // The ladder replaced the tick-box. Carrying both would be two ways
  // to say "end my sessions" that can disagree with each other.
  it("has no tick-box left", () => {
    expect("check" in prompt).toBe(false);
  });
});

describe("closeActionsFor", () => {
  it("closes only this window on the first rung", () => {
    expect(closeActionsFor("window")).toEqual({
      closeOtherWindows: false,
      endSessions: false,
      stopDaemon: false,
    });
  });

  // Windows are not sessions. Closing every one of them still leaves
  // the work running, which is the app's whole premise.
  it("closes every window without touching the sessions", () => {
    expect(closeActionsFor("windows")).toEqual({
      closeOtherWindows: true,
      endSessions: false,
      stopDaemon: false,
    });
  });

  it("ends every session on the third rung, leaving the daemon up", () => {
    expect(closeActionsFor("sessions")).toEqual({
      closeOtherWindows: true,
      endSessions: true,
      stopDaemon: false,
    });
  });

  // Stopping the daemon ends every session by definition -- it owns the
  // PTYs -- but the sweep still runs, because endEverySession() reaches
  // an orphan through the registry row that stopping the daemon takes
  // away with it.
  it("sweeps the sessions as well as stopping the daemon", () => {
    expect(closeActionsFor("daemon")).toEqual({
      closeOtherWindows: true,
      endSessions: true,
      stopDaemon: true,
    });
  });

  // The ladder only ever adds. A rung that undid something a lower one
  // did would make "further down" mean "different" rather than "more",
  // and the human reads it as a severity order.
  it("never takes back what a lower rung did", () => {
    const rungs = (["window", "windows", "sessions", "daemon"] as const).map(closeActionsFor);
    for (let i = 1; i < rungs.length; i++) {
      for (const key of ["closeOtherWindows", "endSessions", "stopDaemon"] as const) {
        expect(rungs[i][key] || !rungs[i - 1][key]).toBe(true);
      }
    }
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

describe("confirmWindowClose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(backend.listManagedSessions).mockResolvedValue(sample([]));
    vi.mocked(backend.closeAllWorkspaceWindows).mockResolvedValue(undefined);
    vi.mocked(backend.stopDaemon).mockResolvedValue(undefined);
    vi.mocked(backend.killSession).mockResolvedValue(undefined);
    vi.mocked(confirmGate.grantForAnsweredPrompt).mockResolvedValue("grant");
    vi.mocked(dialog.showAlert).mockResolvedValue(undefined);
  });

  function answers(picked: CloseScope, confirmed = true) {
    vi.mocked(dialog.askConfirmPicked).mockResolvedValue({ confirmed, checked: false, picked });
  }

  it("keeps the window when the prompt is dismissed", async () => {
    answers("daemon", false);
    expect(await confirmWindowClose()).toBe(false);
    expect(backend.closeAllWorkspaceWindows).not.toHaveBeenCalled();
    expect(backend.stopDaemon).not.toHaveBeenCalled();
  });

  it("touches nothing but this window on the first rung", async () => {
    answers("window");
    expect(await confirmWindowClose()).toBe(true);
    expect(backend.closeAllWorkspaceWindows).not.toHaveBeenCalled();
    expect(backend.listManagedSessions).not.toHaveBeenCalled();
    expect(backend.stopDaemon).not.toHaveBeenCalled();
  });

  // Windows are not sessions: the second rung puts the app away and
  // leaves the work running, which is what closing a window has always
  // meant here.
  it("closes the other windows without ending the sessions", async () => {
    answers("windows");
    expect(await confirmWindowClose()).toBe(true);
    expect(backend.closeAllWorkspaceWindows).toHaveBeenCalled();
    expect(backend.listManagedSessions).not.toHaveBeenCalled();
  });

  // The sweep must finish BEFORE the daemon goes: endEverySession()
  // reaches an orphan through its registry row, and stopping the daemon
  // first leaves a live process with nothing left that knows how to end
  // it.
  it("sweeps every session before it stops the daemon", async () => {
    const order: string[] = [];
    vi.mocked(backend.listManagedSessions).mockImplementation(async () => {
      order.push("list");
      return sample([session({ id: "a" })]);
    });
    vi.mocked(backend.killSession).mockImplementation(async () => {
      order.push("kill");
    });
    vi.mocked(backend.stopDaemon).mockImplementation(async () => {
      order.push("stop");
    });
    answers("daemon");
    expect(await confirmWindowClose()).toBe(true);
    expect(order).toEqual(["list", "kill", "stop"]);
  });

  // Stopping the daemon is gated, and this prompt is the prompt the
  // gate requires to have been on screen.
  it("spends a grant minted for the prompt that was on screen", async () => {
    answers("daemon");
    await confirmWindowClose();
    expect(confirmGate.grantForAnsweredPrompt).toHaveBeenCalledWith("stop_daemon", [""]);
    expect(backend.stopDaemon).toHaveBeenCalledWith("grant");
  });

  // The window goes either way -- the human asked for that, and a modal
  // that refused to close would strand them -- but a daemon still
  // holding every session cannot pass in silence.
  it("closes anyway and says so when the daemon refuses to stop", async () => {
    vi.mocked(backend.stopDaemon).mockRejectedValue(new Error("no route to the socket"));
    answers("daemon");
    expect(await confirmWindowClose()).toBe(true);
    expect(vi.mocked(dialog.showAlert).mock.calls[0][0].title).toContain("daemon");
  });
});
