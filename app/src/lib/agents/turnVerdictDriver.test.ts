import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import type { SessionStatus } from "$lib/core/notifications";

// The driver's one entry point is a hook it hands to layoutState, so the
// mock captures it: the tests below drive the feature exactly as the
// daemon does -- "this session is now idle, it was working a moment ago".
const captured = vi.hoisted(() => ({
  hook: null as
    | ((sessionId: string, status: SessionStatus, previousStatus: SessionStatus | undefined) => void)
    | null,
}));

vi.mock("$lib/core/backend", () => ({
  sessionScreen: vi.fn(),
  typesafeAsk: vi.fn(),
  typesafeSettings: vi.fn(),
}));

vi.mock("$lib/core/layoutState", async () => {
  const { writable: w } = await import("svelte/store");
  return {
    daemonCompat: w(null),
    resolvedAgentFor: vi.fn(() => ({ profileId: "claude-code" })),
    agentForCard: vi.fn(() => ({ profileId: "codex" })),
    setSessionStatusHook: vi.fn((hook) => {
      captured.hook = hook;
    }),
  };
});

vi.mock("$lib/board/kanbanState", async () => {
  const { writable: w } = await import("svelte/store");
  return { kanbanState: w({} as Record<string, unknown>) };
});

vi.mock("$lib/core/gavinState", async () => {
  const { writable: w } = await import("svelte/store");
  return { gavinTrees: w({} as Record<string, unknown>) };
});

vi.mock("$lib/orchestration/orchestrationState", async () => {
  const { writable: w } = await import("svelte/store");
  return { orchestrations: w({} as Record<string, unknown>) };
});

import * as backend from "$lib/core/backend";
import { daemonCompat, setSessionStatusHook } from "$lib/core/layoutState";
import { kanbanState } from "$lib/board/kanbanState";
import { gavinTrees } from "$lib/core/gavinState";
import { orchestrations } from "$lib/orchestration/orchestrationState";
import { PENDING_BACKSTOP_MS, turnVerdictById, typesafeSettings } from "$lib/agents/turnVerdictState";
import {
  __resetForTesting,
  clearTurnVerdict,
  noteQuietTransition,
  startTurnVerdict,
  turnVerdictSkip,
} from "$lib/agents/turnVerdictDriver";

const CARD = "/ws/.gavin-root/plans/a.md";

// What the daemon renders for a Claude Code turn that ended on a prose
// question, right-trimmed and with no padding rows -- so it survives
// `screenTail` unchanged and the assertion below can name it exactly.
const SCREEN = ["⏺ Which do you want?", "", "╭──╮", "│ > │", "╰──╯"].join("\n");

function body(verdict = "asking") {
  const noul = (n: number) => ({ type: "noul", noul: n });
  return {
    model: "jev-1.13.0",
    answers: {
      verdict: { type: "choice", choice: verdict, probabilities: {}, confidence: 0.93 },
      cause: { type: "choice", choice: "none", probabilities: {}, confidence: 0.9 },
      n_asks: noul(0.95),
      n_broke: noul(0.01),
      n_active: noul(0.02),
      n_done: noul(0.1),
      n_optional_offer: noul(0.05),
    },
  };
}

function armed(): void {
  typesafeSettings.set({ enabled: true, hasKey: true });
  daemonCompat.set({ daemonVersion: 39, appVersion: 39, degraded: false } as never);
}

/// A card run bound to `id`.
function cardSession(id = "s1"): void {
  kanbanState.set({
    "ws-1": {
      columns: [],
      labels: [],
      cardSessions: [{ path: CARD, sessionId: id, cwd: "/ws", command: null }],
    },
  } as never);
}

/// A rail step running `id` -- a card step when `cardPath` is given, an
/// agent tool step otherwise.
function stepSession(id = "s1", cardPath: string | null = null): void {
  orchestrations.set({
    "ws-1": {
      rails: [
        {
          id: "r1",
          name: "R",
          position: 0,
          worktreePath: null,
          pageId: null,
          stages: [
            {
              id: "st1",
              position: 0,
              steps: [
                {
                  id: "t1",
                  position: 0,
                  cardPath,
                  toolId: cardPath ? null : "builtin:commit",
                  toolParams: {},
                },
              ],
            },
          ],
        },
      ],
      conflictNotes: [],
      railRuns: [],
      stepRuns: [{ stepId: "t1", state: "running", sessionId: id, reason: null }],
    },
  } as never);
}

function treeWithCard(): void {
  gavinTrees.set({
    "ws-1": {
      rootPath: "/ws",
      rootMissing: false,
      contexts: [
        {
          folderPath: "/ws/.gavin-root",
          kind: "root",
          name: "ws",
          plans: [
            {
              path: CARD,
              fileName: "a.md",
              title: "a",
              status: "In Progress",
              priority: null,
              order: null,
              kind: "task",
              parent: null,
              labels: [],
              agent: "codex",
              checklistDone: 0,
              checklistTotal: 0,
              parseWarning: false,
            },
          ],
          docs: [],
          specs: [],
          hasPrd: false,
          configWarning: false,
        },
      ],
    },
  } as never);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetForTesting();
  captured.hook = null;
  kanbanState.set({} as never);
  orchestrations.set({} as never);
  gavinTrees.set({} as never);
  daemonCompat.set({ daemonVersion: 39, appVersion: 39, degraded: false } as never);
  vi.mocked(backend.sessionScreen).mockResolvedValue(SCREEN);
  vi.mocked(backend.typesafeAsk).mockResolvedValue(body());
  vi.mocked(backend.typesafeSettings).mockResolvedValue({ enabled: true, hasKey: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the gates: whether a byte leaves the machine at all", () => {
  it("sends nothing while nobody has turned it on", () => {
    // `typesafeSettings` is null until the host has been asked, and null
    // is not consent.
    cardSession();
    noteQuietTransition("s1");
    expect(backend.sessionScreen).not.toHaveBeenCalled();
    expect(get(turnVerdictById)).toEqual({});
    expect(turnVerdictSkip("s1")).toContain("off");
  });

  it("a key alone is not consent", () => {
    typesafeSettings.set({ enabled: false, hasKey: true });
    cardSession();
    noteQuietTransition("s1");
    expect(backend.sessionScreen).not.toHaveBeenCalled();
    expect(turnVerdictSkip("s1")).toContain("off");
  });

  it("sends nothing without a key to pay with", () => {
    typesafeSettings.set({ enabled: true, hasKey: false });
    cardSession();
    noteQuietTransition("s1");
    expect(backend.sessionScreen).not.toHaveBeenCalled();
    expect(turnVerdictSkip("s1")).toContain("key");
  });

  it("skips the verdict outright against a daemon that cannot hand over a screen", () => {
    // Not "asks and takes the version error": a failed read would leave
    // the caller holding an empty screen, and an empty screen is a
    // finished turn to any reader. The FEATURE_MIN_VERSION entry's
    // consumer is this line.
    armed();
    daemonCompat.set({ daemonVersion: 38, appVersion: 39, degraded: true } as never);
    cardSession();
    noteQuietTransition("s1");
    expect(backend.sessionScreen).not.toHaveBeenCalled();
    expect(get(turnVerdictById)).toEqual({});
    expect(turnVerdictSkip("s1")).toContain("v39");
  });

  it("never sends a terminal the human opened", () => {
    // Bound to no card and behind no rail step: its screen is theirs.
    armed();
    noteQuietTransition("s1");
    expect(backend.sessionScreen).not.toHaveBeenCalled();
    expect(turnVerdictSkip("s1")).toContain("terminal you opened");
  });

  it("clears a stale entry for a session it will no longer judge", () => {
    // The feature switched off between two turns: the old reading must
    // not go on holding a rail.
    armed();
    cardSession();
    turnVerdictById.set({ s1: { state: "read", reading: { kind: "asking" } } });
    typesafeSettings.set({ enabled: false, hasKey: true });
    noteQuietTransition("s1");
    expect(get(turnVerdictById)).toEqual({});
  });
});

describe("a quiet transition", () => {
  it("marks the session pending before anything is awaited", () => {
    // The scheduler reads the map synchronously on the status emission
    // that follows this call. A pending entry that arrived a microtask
    // later would arrive after the step had been marked done.
    armed();
    cardSession();
    noteQuietTransition("s1");
    expect(get(turnVerdictById).s1).toEqual({ state: "pending" });
  });

  it("asks for the screen, then the verdict, and reads the answer", async () => {
    armed();
    cardSession();
    treeWithCard();
    noteQuietTransition("s1");
    await flush();
    expect(backend.sessionScreen).toHaveBeenCalledWith("s1");
    expect(backend.typesafeAsk).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "jev-1.13.0",
        // The card's own agent, not the workspace's: this card names
        // codex, and the model is told whose chrome it is reading.
        state: { agent_cli: "codex", screen: SCREEN },
      })
    );
    expect(get(turnVerdictById).s1).toEqual({ state: "read", reading: { kind: "asking" } });
  });

  it("names the workspace's agent for an agent tool step, which has no card", async () => {
    armed();
    stepSession("s1", null);
    noteQuietTransition("s1");
    await flush();
    expect(backend.typesafeAsk).toHaveBeenCalledWith(
      expect.objectContaining({ state: { agent_cli: "claude-code", screen: SCREEN } })
    );
  });

  it("a rail step's session is gavin's work too", async () => {
    armed();
    stepSession("s1", CARD);
    noteQuietTransition("s1");
    await flush();
    expect(backend.sessionScreen).toHaveBeenCalledWith("s1");
    expect(get(turnVerdictById).s1).toEqual({ state: "read", reading: { kind: "asking" } });
  });

  it("every failure is today's answer, and they are indistinguishable", async () => {
    armed();
    cardSession();
    vi.mocked(backend.typesafeAsk).mockRejectedValue(new Error("TypeSafe answered 401"));
    noteQuietTransition("s1");
    await flush();
    expect(get(turnVerdictById).s1).toEqual({ state: "read", reading: null });

    __resetForTesting();
    armed();
    vi.mocked(backend.sessionScreen).mockRejectedValue(new Error("unknown session: s1"));
    noteQuietTransition("s1");
    await flush();
    expect(get(turnVerdictById).s1).toEqual({ state: "read", reading: null });

    __resetForTesting();
    armed();
    vi.mocked(backend.sessionScreen).mockResolvedValue(SCREEN);
    vi.mocked(backend.typesafeAsk).mockResolvedValue("upstream connect error");
    noteQuietTransition("s1");
    await flush();
    expect(get(turnVerdictById).s1).toEqual({ state: "read", reading: null });
  });

  it("the backstop settles a request the host never answers", async () => {
    // The one way this feature could do more damage than the bug it
    // fixes: a pending entry that outlives its request holds a rail step
    // for ever.
    vi.useFakeTimers();
    armed();
    cardSession();
    vi.mocked(backend.sessionScreen).mockReturnValue(new Promise(() => {}));
    noteQuietTransition("s1");
    expect(get(turnVerdictById).s1).toEqual({ state: "pending" });
    await vi.advanceTimersByTimeAsync(PENDING_BACKSTOP_MS - 1);
    expect(get(turnVerdictById).s1).toEqual({ state: "pending" });
    await vi.advanceTimersByTimeAsync(1);
    expect(get(turnVerdictById).s1).toEqual({ state: "read", reading: null });
  });

  it("drops an answer that arrives for a turn that is over", async () => {
    armed();
    cardSession();
    const late = deferred<unknown>();
    vi.mocked(backend.typesafeAsk).mockReturnValue(late.promise);
    noteQuietTransition("s1");
    await flush();
    expect(get(turnVerdictById).s1).toEqual({ state: "pending" });
    // The agent started talking again. The verdict in flight is about
    // the turn that just ended, and must not land on the next one.
    clearTurnVerdict("s1");
    expect(get(turnVerdictById)).toEqual({});
    late.resolve(body());
    await flush();
    expect(get(turnVerdictById)).toEqual({});
  });

  it("supersedes an earlier request with a later one, by token and not by identity", async () => {
    armed();
    cardSession();
    const first = deferred<unknown>();
    vi.mocked(backend.typesafeAsk)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(body("finished"));
    noteQuietTransition("s1");
    await flush();
    noteQuietTransition("s1");
    await flush();
    expect(get(turnVerdictById).s1).toEqual({ state: "read", reading: { kind: "finished" } });
    first.resolve(body("asking"));
    await flush();
    expect(get(turnVerdictById).s1).toEqual({ state: "read", reading: { kind: "finished" } });
  });
});

describe("the status hook", () => {
  let stop: () => void;

  beforeEach(() => {
    armed();
    cardSession();
    stop = startTurnVerdict();
  });

  afterEach(() => {
    stop();
  });

  it("is registered on start, and reads the settings from the host", async () => {
    expect(setSessionStatusHook).toHaveBeenCalledWith(expect.any(Function));
    expect(captured.hook).not.toBeNull();
    await flush();
    expect(backend.typesafeSettings).toHaveBeenCalled();
  });

  it("asks on the transition to idle, and once per transition rather than per report", async () => {
    captured.hook?.("s1", "idle", "working");
    // The daemon re-reports a status it has already sent (a re-Attach, a
    // heuristic re-fire). A request per report would be a request per
    // bell rather than per turn.
    captured.hook?.("s1", "idle", "idle");
    await flush();
    expect(backend.sessionScreen).toHaveBeenCalledTimes(1);
  });

  it("failed rides with idle: the verdict is what can name the cause", async () => {
    captured.hook?.("s1", "failed", "working");
    await flush();
    expect(backend.sessionScreen).toHaveBeenCalledTimes(1);
  });

  it("any other status clears the entry and drops the answer in flight", async () => {
    const late = deferred<unknown>();
    vi.mocked(backend.typesafeAsk).mockReturnValue(late.promise);
    captured.hook?.("s1", "idle", "working");
    await flush();
    expect(get(turnVerdictById).s1).toEqual({ state: "pending" });
    captured.hook?.("s1", "working", "idle");
    expect(get(turnVerdictById)).toEqual({});
    late.resolve(body());
    await flush();
    expect(get(turnVerdictById)).toEqual({});
  });

  it("is unregistered and the map emptied on stop", () => {
    captured.hook?.("s1", "idle", "working");
    expect(get(turnVerdictById).s1).toEqual({ state: "pending" });
    stop();
    expect(setSessionStatusHook).toHaveBeenLastCalledWith(null);
    expect(get(turnVerdictById)).toEqual({});
    // Re-armed for the afterEach, which stops again harmlessly.
    stop = startTurnVerdict();
  });
});
