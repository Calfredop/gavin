import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get, writable } from "svelte/store";

// The driver's one entry point is a hook it hands to layoutState, so the
// mock captures it: every test below drives the feature exactly as the
// daemon does -- "this session broke, here is why, here is what it was
// doing a moment ago".
const captured = vi.hoisted(() => ({
  hook: null as
    | ((sessionId: string, reason: string, previousStatus: string | undefined) => void)
    | null,
}));

vi.mock("$lib/layoutState", async () => {
  const { writable: w } = await import("svelte/store");
  return {
    layoutState: w({
      workspaces: [] as unknown[],
      failureReasonById: {} as Record<string, string>,
      sessionNames: {} as Record<string, string>,
      cwdBySessionId: {} as Record<string, string>,
    }),
    daemonCompat: w({ daemonVersion: 22, appVersion: 22, degraded: false }),
    resolvedAgentFor: vi.fn(() => ({
      profileId: "claude-code",
      failureCauses: [
        { pattern: "/login", cause: "auth" },
        { pattern: "exceeded your usage limit", cause: "usage-limit" },
        { pattern: "Connection dropped", cause: "network" },
      ],
    })),
    setSessionFailureHook: vi.fn((hook) => {
      captured.hook = hook;
    }),
  };
});

vi.mock("$lib/board/kanbanState", async () => {
  const { writable: w } = await import("svelte/store");
  return { kanbanState: w({} as Record<string, unknown>) };
});

vi.mock("$lib/gavinState", async () => {
  const { writable: w } = await import("svelte/store");
  return { gavinTrees: w({} as Record<string, unknown>) };
});

vi.mock("$lib/orchestration/orchestrationState", async () => {
  const { writable: w } = await import("svelte/store");
  return {
    orchestrations: w({} as Record<string, unknown>),
    resumeStep: vi.fn().mockResolvedValue(null),
  };
});

vi.mock("$lib/cards/cardRunActions", () => ({
  resumeCard: vi.fn().mockResolvedValue(null),
}));

vi.mock("$lib/autoResumeNotify", () => ({
  sendAutoResumeNotice: vi.fn().mockResolvedValue(undefined),
}));

import { layoutState, daemonCompat } from "$lib/layoutState";
import { kanbanState } from "$lib/board/kanbanState";
import { gavinTrees } from "$lib/gavinState";
import { orchestrations, resumeStep } from "$lib/orchestration/orchestrationState";
import { resumeCard } from "$lib/cards/cardRunActions";
import { sendAutoResumeNotice } from "$lib/autoResumeNotify";
import { __resetAutoResume, __setAutoResumeClock, resumeTrail, startAutoResume } from "$lib/autoResumeState";
import { STAGGER_SPREAD_MS, WAVE_ABORT_WINDOW_MS } from "$lib/autoResume";

const NETWORK = "API Error: Connection dropped (ECONNRESET)";
const AUTH = "Please run /login · API Error: 401 OAuth token has expired";

const BOARD = {
  columns: [
    { id: "c1", name: "To Do", position: 0 },
    { id: "c2", name: "In Progress", position: 1 },
    { id: "c3", name: "Done", position: 2 },
  ],
  labels: [],
  cardSessions: [] as unknown[],
};

function tree(status = "In Progress") {
  return {
    rootPath: "/ws",
    contexts: [
      {
        name: "root",
        folderPath: "/ws/.gavin-root",
        plans: [
          {
            path: "/ws/.gavin-root/plans/a.md",
            fileName: "a.md",
            title: "Ship the thing",
            status,
            priority: "medium",
            order: null,
            kind: "task",
            parent: null,
            labels: [],
            attachments: [],
            checklistDone: 0,
            checklistTotal: 0,
            parseWarning: false,
          },
        ],
      },
    ],
  };
}

/// A card bound to a session, with the workspace's consent set as asked.
function cardRun(over: { consented?: boolean; attempts?: number | null; conversationId?: string | null } = {}) {
  layoutState.set({
    workspaces: [{ id: "ws-1", autoResumeRuns: over.consented ?? true }],
    failureReasonById: { "sess-1": NETWORK },
    sessionNames: {},
    cwdBySessionId: {},
  } as never);
  kanbanState.set({
    "ws-1": {
      ...BOARD,
      cardSessions: [
        {
          path: "/ws/.gavin-root/plans/a.md",
          sessionId: "sess-1",
          cwd: "/ws",
          command: null,
          conversationId: over.conversationId === undefined ? "conv-1" : over.conversationId,
          launchCwd: "/ws",
          resumeAttempts: over.attempts ?? 0,
        },
      ],
    },
  } as never);
  gavinTrees.set({ "ws-1": tree() } as never);
}

/// One rail, one stage, with `mode` and as many steps as asked for --
/// each step's run row `running` on its own session.
function railRun(mode: "sequence" | "parallel", steps: string[], failed: string[], autoResume = true) {
  orchestrations.set({
    "ws-1": {
      rails: [
        {
          id: "r1",
          name: "backend",
          position: 0,
          worktreePath: "/ws",
          branch: null,
          autoResume,
          pageId: null,
          stages: [
            {
              id: "g1",
              position: 0,
              mode,
              name: null,
              steps: steps.map((id, i) => ({
                id,
                position: i,
                cardPath: "/ws/.gavin-root/plans/a.md",
                toolId: null,
                toolParams: {},
              })),
            },
          ],
        },
      ],
      conflictNotes: [],
      railRuns: [{ railId: "r1", state: "paused", currentStageId: "g1" }],
      stepRuns: steps.map((id) => ({
        stepId: id,
        state: "running",
        sessionId: `sess-${id}`,
        reason: null,
        conversationId: `conv-${id}`,
        launchCwd: "/ws",
        resumeAttempts: 0,
      })),
    },
  } as never);
  layoutState.set({
    workspaces: [{ id: "ws-1", autoResumeRuns: false }],
    failureReasonById: Object.fromEntries(failed.map((id) => [`sess-${id}`, NETWORK])),
    sessionNames: {},
    cwdBySessionId: {},
  } as never);
  gavinTrees.set({ "ws-1": tree() } as never);
  kanbanState.set({ "ws-1": BOARD } as never);
}

function fail(sessionId: string, previous = "working"): void {
  captured.hook?.(sessionId, NETWORK, previous);
}

let stop: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  __resetAutoResume();
  orchestrations.set({} as never);
  kanbanState.set({} as never);
  gavinTrees.set({} as never);
  daemonCompat.set({ daemonVersion: 22, appVersion: 22, degraded: false } as never);
  // No jitter, so a stagger's slots are exact and a test can name them.
  __setAutoResumeClock({ random: () => 0, online: () => true });
  stop = startAutoResume();
});

afterEach(() => {
  stop();
  __resetAutoResume();
  vi.useRealTimers();
});

describe("a standalone card run", () => {
  // The whole feature at one-step scale: no stage, no siblings, no
  // shared checkout beyond whatever the human already had.
  it("is reopened when its connection died and the workspace opted in", async () => {
    cardRun();
    fail("sess-1");
    expect(resumeCard).not.toHaveBeenCalled(); // never synchronously: the wave staggers
    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    expect(resumeCard).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ id: "/ws/.gavin-root/plans/a.md" }),
      { automatic: true }
    );
  });

  // Consent given in advance is the whole answer to "gavin made a
  // decision that was mine". Without it, nothing happens AND nothing is
  // said -- a workspace that never asked must not be nagged about a
  // choice it never made.
  it("is left alone, silently, when the workspace never opted in", async () => {
    cardRun({ consented: false });
    fail("sess-1");
    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    expect(resumeCard).not.toHaveBeenCalled();
    expect(sendAutoResumeNotice).not.toHaveBeenCalled();
  });

  // ...but a workspace that DID opt in has to hear why nothing happened,
  // or a stalled run is indistinguishable from a forgotten one.
  it("says why it declined, when the human asked it to try", async () => {
    cardRun();
    // The store carries what the daemon pushed, and that line is what
    // gets classified -- the hook's argument is only the wake-up.
    layoutState.update((s) => ({ ...s, failureReasonById: { "sess-1": AUTH } }) as never);
    captured.hook?.("sess-1", AUTH, "working");
    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    expect(resumeCard).not.toHaveBeenCalled();
    expect(sendAutoResumeNotice).toHaveBeenCalledWith(expect.stringContaining("login"));
  });

  it("spends its one attempt and stops", async () => {
    cardRun({ attempts: 1 });
    fail("sess-1");
    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    expect(resumeCard).not.toHaveBeenCalled();
    expect(sendAutoResumeNotice).toHaveBeenCalledWith(expect.stringContaining("already resumed"));
  });

  // It was asking a human a question. It still is.
  it("never resumes a session that was waiting for input", async () => {
    cardRun();
    fail("sess-1", "waiting_for_input");
    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    expect(resumeCard).not.toHaveBeenCalled();
  });

  // Gavin auto-resumes exactly the runs it launched and holds a
  // conversation id for. Everything else gets the notification and the
  // manual button.
  it("refuses a binding with no conversation to reopen", async () => {
    cardRun({ conversationId: null });
    fail("sess-1");
    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    expect(resumeCard).not.toHaveBeenCalled();
  });

  // An agent can complete its edits and die before reporting them.
  it("files nothing when the card already reached the done column", async () => {
    cardRun();
    gavinTrees.set({ "ws-1": tree("Done") } as never);
    fail("sess-1");
    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    expect(resumeCard).not.toHaveBeenCalled();
    expect(sendAutoResumeNotice).toHaveBeenCalledWith(expect.stringContaining("already finished"));
  });

  // A resume that leaves no trace is indistinguishable from a run that
  // never broke.
  it("records what it did, so the card can say so afterwards", async () => {
    cardRun();
    fail("sess-1");
    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    const trail = get(resumeTrail)["/ws/.gavin-root/plans/a.md"];
    expect(trail).toMatchObject({ cause: "network", reason: NETWORK });
    expect(sendAutoResumeNotice).toHaveBeenCalledWith(expect.stringContaining("resumed automatically"));
  });

  // The caller that takes a claim and then fails to launch gives it back
  // -- otherwise the human's own press does nothing for a minute.
  it("says so and releases its claim when the resume itself fails", async () => {
    vi.mocked(resumeCard).mockResolvedValueOnce("Couldn't resume the conversation: nope");
    cardRun();
    fail("sess-1");
    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    expect(sendAutoResumeNotice).toHaveBeenCalledWith(expect.stringContaining("nope"));
    // The second failure of the same session can arm again, because the
    // claim went back rather than standing for its full TTL.
    fail("sess-1");
    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    expect(resumeCard).toHaveBeenCalledTimes(2);
  });
});

describe("a rail step", () => {
  // A sequence group runs one member at a time, so at most one of its
  // steps was running: it reduces to the single-step problem.
  it("in a sequence stage is reopened as its own conversation", async () => {
    railRun("sequence", ["t1", "t2"], ["t1"]);
    fail("sess-t1");
    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    expect(resumeStep).toHaveBeenCalledWith("ws-1", "t1", { automatic: true });
  });

  it("takes its consent from the rail, not the workspace", async () => {
    railRun("sequence", ["t1"], ["t1"], false);
    fail("sess-t1");
    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    expect(resumeStep).not.toHaveBeenCalled();
  });

  // A parallel stage with ONE broken member is the same shape as a
  // sequence one: there are no siblings for it to be stale against.
  it("in a parallel stage is reopened when it is the only one that broke", async () => {
    railRun("parallel", ["t1", "t2"], ["t1"]);
    fail("sess-t1");
    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    expect(resumeStep).toHaveBeenCalledWith("ws-1", "t1", { automatic: true });
  });

  // The hard case. Each returning agent holds a transcript describing the
  // checkout as of the moment IT was cut off, while its siblings kept
  // editing right up to that same moment -- strictly worse than the
  // same-worktree conflict detectConflicts already warns about. So the
  // stage resumes as a unit or not at all, and a unit of two is not one
  // gavin can put back.
  it("in a parallel stage stays stalled when two of them broke together", async () => {
    railRun("parallel", ["t1", "t2"], ["t1", "t2"]);
    fail("sess-t1");
    fail("sess-t2");
    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    expect(resumeStep).not.toHaveBeenCalled();
    expect(sendAutoResumeNotice).toHaveBeenCalledWith(
      expect.stringContaining("parallel stage broke together")
    );
  });

  // The burst arrives one push at a time, so the first failure can look
  // lonely. The delay exists precisely so the sibling lands before
  // anything fires, and the decision is re-taken at fire time.
  it("cancels a resume when its sibling's failure arrives after it armed", async () => {
    railRun("parallel", ["t1", "t2"], ["t1"]);
    fail("sess-t1");
    // The sibling breaks a moment later, as a second push.
    layoutState.update(
      (s) => ({ ...s, failureReasonById: { "sess-t1": NETWORK, "sess-t2": NETWORK } }) as never
    );
    fail("sess-t2");
    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    expect(resumeStep).not.toHaveBeenCalled();
  });
});

describe("the wave", () => {
  // N agents hitting the API the instant a flaky network returns is the
  // most reliable way to spend every budget at the worst possible
  // moment.
  it("staggers two independent resumes rather than firing them together", async () => {
    railRun("sequence", ["t1"], ["t1"]);
    // A card run in the same workspace, broken by the same interruption.
    kanbanState.set({
      "ws-1": {
        ...BOARD,
        cardSessions: [
          {
            path: "/ws/.gavin-root/plans/a.md",
            sessionId: "sess-card",
            cwd: "/ws",
            command: null,
            conversationId: "conv-card",
            launchCwd: "/ws",
            resumeAttempts: 0,
          },
        ],
      },
    } as never);
    layoutState.set({
      workspaces: [{ id: "ws-1", autoResumeRuns: true }],
      failureReasonById: { "sess-t1": NETWORK, "sess-card": NETWORK },
      sessionNames: {},
      cwdBySessionId: {},
    } as never);

    fail("sess-t1");
    fail("sess-card");

    // The first slot lands; the second is still waiting.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(resumeStep).toHaveBeenCalledTimes(1);
    expect(resumeCard).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    expect(resumeCard).toHaveBeenCalledTimes(1);
  });

  // Reachability is a gate, not a guarantee. An agent that breaks again
  // within seconds of being resumed is evidence about the network, not
  // about that one run.
  it("stops resuming the rest when a resumed agent breaks again straight away", async () => {
    railRun("sequence", ["t1"], ["t1"]);
    kanbanState.set({
      "ws-1": {
        ...BOARD,
        cardSessions: [
          {
            path: "/ws/.gavin-root/plans/a.md",
            sessionId: "sess-card",
            cwd: "/ws",
            command: null,
            conversationId: "conv-card",
            launchCwd: "/ws",
            resumeAttempts: 0,
          },
        ],
      },
    } as never);
    layoutState.set({
      workspaces: [{ id: "ws-1", autoResumeRuns: true }],
      failureReasonById: { "sess-t1": NETWORK, "sess-card": NETWORK },
      sessionNames: {},
      cwdBySessionId: {},
    } as never);
    // The step's resume comes back on a NEW session id, which is what a
    // second failure has to be recognised against.
    vi.mocked(resumeStep).mockImplementation(async () => {
      orchestrations.update(
        (o) =>
          ({
            ...o,
            "ws-1": {
              ...(o as Record<string, { stepRuns: unknown[] }>)["ws-1"],
              stepRuns: [
                {
                  stepId: "t1",
                  state: "running",
                  sessionId: "sess-t1b",
                  reason: null,
                  conversationId: "conv-t1",
                  launchCwd: "/ws",
                  resumeAttempts: 1,
                },
              ],
            },
          }) as never
      );
      return null;
    });

    fail("sess-t1");
    fail("sess-card");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(resumeStep).toHaveBeenCalledTimes(1);

    // The replacement dies immediately: the connection is not back.
    layoutState.update(
      (s) => ({ ...s, failureReasonById: { ...(s as never as { failureReasonById: object }).failureReasonById, "sess-t1b": NETWORK } }) as never
    );
    fail("sess-t1b");

    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS + WAVE_ABORT_WINDOW_MS);
    expect(resumeCard).not.toHaveBeenCalled();
    expect(sendAutoResumeNotice).toHaveBeenCalledWith(expect.stringContaining("not back"));
  });

  // An interface that is still down means the signal has not really
  // arrived. Waiting beats spending the one attempt on it.
  it("waits rather than spending its attempt while the machine is offline", async () => {
    __setAutoResumeClock({ online: () => false });
    cardRun();
    fail("sess-1");
    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    expect(resumeCard).not.toHaveBeenCalled();

    __setAutoResumeClock({ online: () => true });
    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    expect(resumeCard).toHaveBeenCalledTimes(1);
  });
});

describe("the guards", () => {
  // The claim guards the WINDOW; this guards everything after it. The
  // driver keys on the FAILED session's id, so the moment anything
  // replaces that run -- most obviously the human pressing Resume while
  // gavin was still waiting for the network -- the fire-time lookup finds
  // nothing and gavin does not resume on top of them.
  it("does nothing once the human has already resumed the run themselves", async () => {
    __setAutoResumeClock({ online: () => false });
    cardRun();
    fail("sess-1");
    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    expect(resumeCard).not.toHaveBeenCalled();

    // The human's press: a new session on the same card, and the failed
    // id is no longer bound to anything.
    kanbanState.update(
      (b) =>
        ({
          ...b,
          "ws-1": {
            ...BOARD,
            cardSessions: [
              {
                path: "/ws/.gavin-root/plans/a.md",
                sessionId: "sess-2",
                cwd: "/ws",
                command: null,
                conversationId: "conv-1",
                launchCwd: "/ws",
                resumeAttempts: 0,
              },
            ],
          },
        }) as never
    );
    __setAutoResumeClock({ online: () => true });
    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    expect(resumeCard).not.toHaveBeenCalled();
  });

  // The automatic resume landing at the same moment as the human's press
  // is the likeliest double-fire of the lot -- the notification that
  // prompts them arrives exactly when the trigger does.
  it("arms once for a session, however many times the failure is reported", async () => {
    cardRun();
    fail("sess-1");
    fail("sess-1");
    fail("sess-1");
    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    expect(resumeCard).toHaveBeenCalledTimes(1);
  });

  // A v21 daemon parses the widened requests and drops resumeAttempts on
  // the floor, so every resume would read the budget back as absent and
  // resume again: an unbounded loop wearing the costume of a limit.
  it("refuses to arm at all against a daemon that cannot persist the budget", async () => {
    daemonCompat.set({ daemonVersion: 21, appVersion: 22, degraded: true } as never);
    cardRun();
    fail("sess-1");
    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    expect(resumeCard).not.toHaveBeenCalled();
  });

  // A session gavin launched nothing for -- someone typed `claude` into
  // a terminal. It gets the truthful status the failure card gives it,
  // and nothing further.
  it("ignores a session that belongs to no run gavin launched", async () => {
    cardRun();
    fail("sess-nobody");
    await vi.advanceTimersByTimeAsync(STAGGER_SPREAD_MS);
    expect(resumeCard).not.toHaveBeenCalled();
    expect(sendAutoResumeNotice).not.toHaveBeenCalled();
  });
});
