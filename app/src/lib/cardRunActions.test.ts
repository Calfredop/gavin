import { describe, it, expect, vi, beforeEach } from "vitest";
import { get, writable } from "svelte/store";
import type { DaemonCompat } from "./daemonCompat";
import type { SessionStatus } from "./notifications";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("./backend", () => ({
  createSession: vi.fn(),
  readFileForViewer: vi.fn(),
  setPlanFrontmatterField: vi.fn(),
  linkCardSession: vi.fn(),
  unlinkCardSession: vi.fn(),
  writeInput: vi.fn(),
  getBoard: vi.fn(),
  attachmentStatus: vi.fn(),
  // Resolved by default with an empty queue: the reply is applied to the
  // store, not asserted on, so every test that is not about queueing
  // just needs it not to reject.
  queueInput: vi.fn().mockResolvedValue([]),
}));
/// Hoisted so the `vi.mock` factory below (which is hoisted above every
/// import) can close over it, and so `resolvedAgentFor` and
/// `agentForCard` can be the same function object.
const agentMock = vi.hoisted(() =>
  vi.fn(() => ({
    profileId: "claude-code",
    label: "Claude Code",
    file: "CLAUDE.md",
    command: "claude --model opus",
    launchCommand: "claude --model opus",
    mcpSupported: true,
    failurePatterns: ["API Error:"],
    failureCauses: [
      { pattern: "/login", cause: "auth" },
      { pattern: "Connection dropped", cause: "network" },
    ],
    sessionIdArgs: "",
    resumeArgs: "",
    promptArgs: "",
  }))
);

vi.mock("./layoutState", () => ({
  layoutState: writable({
    workspaces: [
      {
        id: "ws-1",
        name: "ws",
        pages: [
          {
            id: "pg-1",
            name: "Agents",
            layout: { type: "leaf", tabs: ["s-live"], activeTab: "s-live" },
          },
        ],
        activePageId: "pg-1",
      },
    ],
    sessionStatusById: {},
    sessionNames: {},
    cwdBySessionId: {},
    interruptedSessionIds: new Set<string>(),
    failureReasonById: {} as Record<string, string>,
  }),
  // The three the follow-up queue reads through queuedInputActions.
  // `daemonCompat` null means "not connected yet", which
  // featureBlockedReason treats as ungated -- so the default here is a
  // daemon that CAN queue, and the version-blocked path is set per test.
  daemonCompat: writable(null as DaemonCompat | null),
  queuedInputsById: writable({} as Record<string, unknown[]>),
  handleQueuedInputsChanged: vi.fn(),
  setDevelopingCards: vi.fn().mockResolvedValue(undefined),
  handleAgentSessionSpawned: vi.fn(),
  armFailureDetection: vi.fn().mockResolvedValue(undefined),
  // The DAEMON half of the conversation-resume gate lives here, so the
  // tests drive it from one place: null is "no id", which is both a
  // profile with no verified argv and a daemon too old to persist one.
  conversationIdForLaunch: vi.fn(() => null as string | null),
  // The baseline half of the same gate: null is "this run has none",
  // which covers a launch outside a repo, an unborn HEAD and a daemon
  // too old to store the sha.
  baseShaForLaunch: vi.fn(async () => null as string | null),
  setSessionName: vi.fn().mockResolvedValue(undefined),
  switchWorkspaceView: vi.fn().mockResolvedValue(undefined),
  switchToSessionInPage: vi.fn().mockResolvedValue(undefined),
  workspaceRootPath: vi.fn(() => "/ws"),
  resolvedAgentFor: agentMock,
  // The SAME mock function, deliberately: no fixture here carries a
  // complexity, so `agentForCard` really does resolve to the workspace's
  // agent -- and a test that moves one has to move both, or half the
  // launches in a single run would use a different agent.
  agentForCard: agentMock,
}));
vi.mock("./workspace", () => {
  const findSessionLocation = vi.fn();
  return {
    findSessionLocation,
    // Built on the SAME mock the tests drive, so "in a layout tree" and
    // "live" can never disagree about one session id in here.
    sessionLiveness: (
      state: { interruptedSessionIds?: ReadonlySet<string>; failureReasonById?: Record<string, string> },
      sessionId: string
    ) => {
      const location = findSessionLocation(state, sessionId);
      if (!location) return "gone";
      const failed = (state as { failureReasonById?: Record<string, string> }).failureReasonById;
      if (failed?.[sessionId] !== undefined) return "failed";
      return state.interruptedSessionIds?.has(sessionId) ? "interrupted" : "live";
    },
  };
});

import * as backend from "./backend";
import { handleAgentSessionSpawned, setSessionName, switchToSessionInPage, switchWorkspaceView, layoutState, daemonCompat, workspaceRootPath, resolvedAgentFor, conversationIdForLaunch, baseShaForLaunch, armFailureDetection, setDevelopingCards } from "./layoutState";
import { findSessionLocation } from "./workspace";
import { kanbanState } from "./kanbanState";
import { gavinTrees } from "./gavinState";
import {
  runCard,
  resumeCard,
  developCard,
  relaunchCard,
  jumpToBoundSession,
  sendToMainAgent,
} from "./cardRunActions";
import type { CardView } from "./planBoard";
import type { Board } from "./kanban";

function card(kind: "note" | "task" | "plan", status: string | null): CardView {
  return {
    id: "/ws/.gavin-root/plans/t.md",
    title: "Fix login",
    status,
    priority: null,
    order: null,
    kind,
    parent: null,
    parentTitle: null,
    parentBroken: false,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    contextName: "root",
    contextFolder: "/ws",
    fileName: "t.md",
    parseWarning: false,
    nestedChildren: [],
  };
}

function board(cardSessions: Board["cardSessions"] = []): Board {
  return { columns: [{ id: "c1", name: "To Do", position: 0 }], labels: [], cardSessions };
}

/// The default profile: verified failure patterns, and NO conversation
/// resume -- which is what codex, gemini and opencode look like, and
/// what claude-code looks like against a daemon too old to persist the
/// id. The tests that want resume opt in.
const NO_RESUME_AGENT = {
  profileId: "claude-code",
  file: "CLAUDE.md",
  command: "claude --model opus",
  launchCommand: "claude --model opus",
  promptArgs: "",
  mcpSupported: true,
  failurePatterns: ["API Error:"],
      failureCauses: [{ pattern: "/login", cause: "auth" }, { pattern: "Connection dropped", cause: "network" }],
  sessionIdArgs: "",
  resumeArgs: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  kanbanState.set({ "ws-1": board() });
  gavinTrees.set({});
  // Both v21 maps reset per test: these stores are module-level, so one
  // test's broken session would otherwise decide what the next one sees.
  layoutState.update((s) => ({
    ...s,
    interruptedSessionIds: new Set<string>(),
    failureReasonById: {},
    // And the develop records, for the same reason: a card left locked by
    // one test would refuse every launch in the next one.
    workspaces: s.workspaces.map((w) => ({ ...w, developingCards: undefined })),
  }));
  // clearAllMocks clears CALLS, not implementations, so a test that
  // swaps the profile in has to be undone here or it leaks forward.
  vi.mocked(resolvedAgentFor).mockReturnValue(NO_RESUME_AGENT as never);
  vi.mocked(conversationIdForLaunch).mockReturnValue(null);
  vi.mocked(baseShaForLaunch).mockResolvedValue(null);
  vi.mocked(findSessionLocation).mockReturnValue(null);
});

describe("runCard", () => {
  it("task: reads the body, composes the command, lands on Agents, links, sets In Progress", async () => {
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\nkind: task\ntitle: Fix login\nstatus: To Do\n---\nDo the thing.\n",
      truncated: false,
      exists: true,
    });
    vi.mocked(backend.createSession).mockResolvedValue("s-9");
    vi.mocked(backend.linkCardSession).mockResolvedValue(undefined);
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);

    const err = await runCard("ws-1", card("task", "To Do"));

    expect(err).toBeNull();
    const [cwd, command] = vi.mocked(backend.createSession).mock.calls[0];
    expect(cwd).toBe("/ws");
    expect(command).toContain("claude --model opus '");
    expect(command).toContain("Do the thing.");
    expect(command).toContain('the task card at /ws/.gavin-root/plans/t.md');
    expect(handleAgentSessionSpawned).toHaveBeenCalledWith("ws-1", "s-9");
    expect(backend.linkCardSession).toHaveBeenCalled();
    expect(backend.setPlanFrontmatterField).toHaveBeenCalledWith(
      "/ws/.gavin-root/plans/t.md",
      "status",
      "In Progress"
    );
  });

  it("plan: a card in done/ is un-archived first, and the prompt names where it landed", async () => {
    vi.mocked(backend.createSession).mockResolvedValue("s-9");
    vi.mocked(backend.linkCardSession).mockResolvedValue(undefined);
    vi.mocked(backend.setPlanFrontmatterField).mockResolvedValue("/ws/.gavin-root/plans/t.md");

    const archived = card("plan", "Done");
    archived.id = "/ws/.gavin-root/plans/done/t.md";
    const err = await runCard("ws-1", archived);

    expect(err).toBeNull();
    // Status first, from the path the card is at now...
    expect(backend.setPlanFrontmatterField).toHaveBeenCalledWith(
      "/ws/.gavin-root/plans/done/t.md",
      "status",
      "In Progress"
    );
    // ...then the prompt, naming the path the write moved it to.
    const [, command] = vi.mocked(backend.createSession).mock.calls[0];
    expect(command).toContain("/ws/.gavin-root/plans/t.md");
    expect(command).not.toContain("done/t.md");
    expect(vi.mocked(backend.linkCardSession).mock.calls[0][1]).toBe("/ws/.gavin-root/plans/t.md");
  });

  it("plan: a failed status write stops the run before the agent starts", async () => {
    vi.mocked(backend.setPlanFrontmatterField).mockRejectedValue(new Error("read-only"));

    const err = await runCard("ws-1", card("plan", "To Do"));

    expect(err).toContain("In Progress");
    expect(backend.createSession).not.toHaveBeenCalled();
  });

  it("plan: pointer prompt, never reads the body", async () => {
    vi.mocked(backend.createSession).mockResolvedValue("s-9");
    vi.mocked(backend.linkCardSession).mockResolvedValue(undefined);
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);

    const err = await runCard("ws-1", card("plan", "In Progress"));

    expect(err).toBeNull();
    expect(backend.readFileForViewer).not.toHaveBeenCalled();
    const [, command] = vi.mocked(backend.createSession).mock.calls[0];
    expect(command).toContain("Read /ws/.gavin-root/plans/t.md and execute that plan");
    // Already slug-matching In Progress: no status write.
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
  });

  it("names the tab from the card title at launch, so it is never a bare session id", async () => {
    // The agent renames itself over this via gavin_name_session. Until it
    // does -- and if the gavin tools are unreachable, it never will -- the
    // tab has to say which card it is running.
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\nkind: task\n---\nDo the thing.\n",
      truncated: false,
      exists: true,
    });
    vi.mocked(backend.createSession).mockResolvedValue("s-9");
    vi.mocked(backend.linkCardSession).mockResolvedValue(undefined);
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);

    await runCard("ws-1", card("task", "To Do"));

    expect(setSessionName).toHaveBeenCalledWith("s-9", "Fix login");
  });

  it("jumps instead of spawning when a live binding exists", async () => {
    kanbanState.set({
      "ws-1": board([{ path: "/ws/.gavin-root/plans/t.md", sessionId: "s-live", cwd: "/ws", command: "x" }]),
    });
    vi.mocked(findSessionLocation).mockReturnValue({ workspaceId: "ws-1", pageId: "pg-1" });

    const err = await runCard("ws-1", card("task", "To Do"));

    expect(err).toBeNull();
    expect(backend.createSession).not.toHaveBeenCalled();
    expect(switchToSessionInPage).toHaveBeenCalledWith("ws-1", "pg-1", "s-live");
  });

  it("notes are not runnable; createSession failures surface without linking", async () => {
    expect(await runCard("ws-1", card("note", null))).toContain("not runnable");

    vi.mocked(backend.readFileForViewer).mockResolvedValue({ content: "x", truncated: false, exists: true });
    vi.mocked(backend.createSession).mockRejectedValue(new Error("spawn failed"));
    const err = await runCard("ws-1", card("task", null));
    expect(err).toContain("spawn failed");
    expect(backend.linkCardSession).not.toHaveBeenCalled();
  });
});

describe("resumeCard", () => {
  it("task: the resume prompt, and no status write on a card already In Progress", async () => {
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\nkind: task\ntitle: Fix login\nstatus: In Progress\n---\nDo the thing.\n",
      truncated: false,
      exists: true,
    });
    vi.mocked(backend.createSession).mockResolvedValue("s-9");
    vi.mocked(backend.linkCardSession).mockResolvedValue(undefined);

    const err = await resumeCard("ws-1", card("task", "In Progress"));

    expect(err).toBeNull();
    const [cwd, command] = vi.mocked(backend.createSession).mock.calls[0];
    expect(cwd).toBe("/ws");
    expect(command).toContain("Use the gavin-resume skill");
    expect(command).toContain("Do the thing.");
    expect(command).not.toContain("You are executing the task card");
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
  });

  it("plan: the resume pointer prompt, body never read", async () => {
    vi.mocked(backend.createSession).mockResolvedValue("s-9");
    vi.mocked(backend.linkCardSession).mockResolvedValue(undefined);

    expect(await resumeCard("ws-1", card("plan", "In Progress"))).toBeNull();

    expect(backend.readFileForViewer).not.toHaveBeenCalled();
    const [, command] = vi.mocked(backend.createSession).mock.calls[0];
    expect(command).toContain("resume the plan at /ws/.gavin-root/plans/t.md");
  });

  it("spawns over an EXITED binding — that is what resuming is — and re-links", async () => {
    kanbanState.set({
      "ws-1": board([
        { path: "/ws/.gavin-root/plans/t.md", sessionId: "s-dead", cwd: "/ws", command: "x" },
      ]),
    });
    vi.mocked(findSessionLocation).mockReturnValue(null);
    vi.mocked(backend.createSession).mockResolvedValue("s-new");
    vi.mocked(backend.linkCardSession).mockResolvedValue(undefined);

    expect(await resumeCard("ws-1", card("plan", "In Progress"))).toBeNull();

    expect(backend.createSession).toHaveBeenCalled();
    expect(handleAgentSessionSpawned).toHaveBeenCalledWith("ws-1", "s-new");
    expect(vi.mocked(backend.linkCardSession).mock.calls[0].slice(0, 3)).toEqual([
      "ws-1",
      "/ws/.gavin-root/plans/t.md",
      "s-new",
    ]);
  });

  it("jumps to a LIVE session instead of spawning a second agent", async () => {
    kanbanState.set({
      "ws-1": board([
        { path: "/ws/.gavin-root/plans/t.md", sessionId: "s-live", cwd: "/ws", command: "x" },
      ]),
    });
    vi.mocked(findSessionLocation).mockReturnValue({ workspaceId: "ws-1", pageId: "pg-1" });

    expect(await resumeCard("ws-1", card("plan", "In Progress"))).toBeNull();

    expect(backend.createSession).not.toHaveBeenCalled();
    expect(switchToSessionInPage).toHaveBeenCalledWith("ws-1", "pg-1", "s-live");
  });

  it("refuses notes, like every other run", async () => {
    expect(await resumeCard("ws-1", card("note", "In Progress"))).toContain("not runnable");
  });
});

describe("developCard", () => {
  it("spawns the develop prompt without writing a status or binding the card", async () => {
    vi.mocked(backend.createSession).mockResolvedValue("s-9");

    const err = await developCard("ws-1", card("task", "To Do"));

    expect(err).toBeNull();
    const [cwd, command] = vi.mocked(backend.createSession).mock.calls[0];
    expect(cwd).toBe("/ws");
    expect(command).toContain("Use the gavin-develop skill on the card at /ws/.gavin-root/plans/t.md");
    expect(handleAgentSessionSpawned).toHaveBeenCalledWith("ws-1", "s-9");
    expect(setSessionName).toHaveBeenCalledWith("s-9", "Fix login");
    // Developing is not starting: the card stays in To Do, and it stays
    // UNBOUND -- a binding would take it out of the To Do column's
    // "Start all" (unbound-only) and turn its menu entry into
    // "Re-launch agent", which would develop it a second time.
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
    expect(backend.linkCardSession).not.toHaveBeenCalled();
  });

  // Develop is the one launch with no binding and no status write, so
  // the board it was started from shows nothing at all afterwards -- and
  // the agent's first move is to ask a question. Left on the board the
  // human waits for an answer they cannot see, in a tab they have to go
  // find on the Agents page.
  it("jumps to the spawned session's tab on the page it landed on", async () => {
    vi.mocked(backend.createSession).mockResolvedValue("s-9");
    vi.mocked(findSessionLocation).mockImplementation((_state, id) =>
      id === "s-9" ? { workspaceId: "ws-1", pageId: "pg-1" } : null
    );

    expect(await developCard("ws-1", card("task", "To Do"))).toBeNull();

    expect(switchWorkspaceView).toHaveBeenCalledWith("ws-1", "terminal");
    expect(switchToSessionInPage).toHaveBeenCalledWith("ws-1", "pg-1", "s-9");
  });

  // The jump is the point of the action; the provisional name is
  // cosmetic, and the agent's own gavin_name_session replaces it anyway.
  // Ordered so the cosmetic one cannot swallow the point.
  it("jumps before it renames the tab", async () => {
    vi.mocked(backend.createSession).mockResolvedValue("s-9");
    vi.mocked(findSessionLocation).mockImplementation((_state, id) =>
      id === "s-9" ? { workspaceId: "ws-1", pageId: "pg-1" } : null
    );

    expect(await developCard("ws-1", card("task", "To Do"))).toBeNull();

    expect(vi.mocked(switchToSessionInPage).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(setSessionName).mock.invocationCallOrder[0]
    );
  });

  // handleAgentSessionSpawned kills a session it has no workspace for,
  // so "no page holds it" is a real outcome -- and a missed jump, never
  // a failed launch: the spawn already happened.
  it("reports no error when no page holds the session", async () => {
    vi.mocked(backend.createSession).mockResolvedValue("s-9");
    vi.mocked(findSessionLocation).mockReturnValue(null);

    expect(await developCard("ws-1", card("task", "To Do"))).toBeNull();

    expect(switchToSessionInPage).not.toHaveBeenCalled();
  });

  it("never reads the body: the card file is the agent's to read", async () => {
    vi.mocked(backend.createSession).mockResolvedValue("s-9");

    expect(await developCard("ws-1", card("task", "To Do"))).toBeNull();

    expect(backend.readFileForViewer).not.toHaveBeenCalled();
  });

  it("refuses while a live agent holds the card, rather than editing under it", async () => {
    kanbanState.set({
      "ws-1": board([
        { path: "/ws/.gavin-root/plans/t.md", sessionId: "s-live", cwd: "/ws", command: "x" },
      ]),
    });
    vi.mocked(findSessionLocation).mockReturnValue({ workspaceId: "ws-1", pageId: "pg-1" });

    const err = await developCard("ws-1", card("task", "To Do"));

    expect(err).toContain("live agent");
    expect(backend.createSession).not.toHaveBeenCalled();
  });

  it("develops over an EXITED binding and leaves that binding alone", async () => {
    kanbanState.set({
      "ws-1": board([
        { path: "/ws/.gavin-root/plans/t.md", sessionId: "s-dead", cwd: "/ws", command: "x" },
      ]),
    });
    vi.mocked(findSessionLocation).mockReturnValue(null);
    vi.mocked(backend.createSession).mockResolvedValue("s-new");

    expect(await developCard("ws-1", card("plan", "To Do"))).toBeNull();

    expect(backend.createSession).toHaveBeenCalled();
    expect(backend.linkCardSession).not.toHaveBeenCalled();
  });

  it("notes are not developable; a spawn failure surfaces", async () => {
    expect(await developCard("ws-1", card("note", null))).toContain("not runnable");

    vi.mocked(backend.createSession).mockRejectedValue(new Error("spawn failed"));
    expect(await developCard("ws-1", card("task", "To Do"))).toContain("spawn failed");
  });
});

/// A develop run REWRITES the card file, and it deliberately binds
/// nothing and writes no status -- so without a record of its own the
/// board had no idea, and offered every launch it has on a card whose
/// prompt was about to be replaced. The record is both halves of the fix:
/// the card's only indication, and the lock every launch reads.
describe("a card being developed", () => {
  const PATH = "/ws/.gavin-root/plans/t.md";

  function developing(records: { path: string; sessionId: string }[]): void {
    layoutState.update((st) => ({
      ...st,
      workspaces: st.workspaces.map((w) =>
        w.id === "ws-1" ? { ...w, developingCards: records } : w
      ),
    }));
  }

  it("is recorded by developCard, before the jump that follows it", async () => {
    vi.mocked(backend.createSession).mockResolvedValue("s-9");
    vi.mocked(findSessionLocation).mockReturnValue({ workspaceId: "ws-1", pageId: "pg-1" });

    expect(await developCard("ws-1", card("task", "To Do"))).toBeNull();

    expect(setDevelopingCards).toHaveBeenCalledWith("ws-1", [{ path: PATH, sessionId: "s-9" }]);
    // The record is the lock. Written after the jump, a window closed
    // mid-jump would leave an agent rewriting a card nothing knows about.
    expect(vi.mocked(setDevelopingCards).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(switchToSessionInPage).mock.invocationCallOrder[0]
    );
  });

  it("keeps the other workspaces' records when it adds one", async () => {
    developing([{ path: "/ws/.gavin-root/plans/other.md", sessionId: "s-old" }]);
    vi.mocked(backend.createSession).mockResolvedValue("s-9");

    expect(await developCard("ws-1", card("task", "To Do"))).toBeNull();

    expect(setDevelopingCards).toHaveBeenCalledWith("ws-1", [
      { path: "/ws/.gavin-root/plans/other.md", sessionId: "s-old" },
      { path: PATH, sessionId: "s-9" },
    ]);
  });

  // Two develop agents on one card is the worst version of the conflict:
  // both of them rewrite the whole file.
  it("makes a second Develop a jump, not a second run", async () => {
    developing([{ path: PATH, sessionId: "s-dev" }]);
    vi.mocked(findSessionLocation).mockReturnValue({ workspaceId: "ws-1", pageId: "pg-1" });

    expect(await developCard("ws-1", card("task", "To Do"))).toBeNull();

    expect(backend.createSession).not.toHaveBeenCalled();
    expect(switchToSessionInPage).toHaveBeenCalledWith("ws-1", "pg-1", "s-dev");
  });

  it("develops afresh when the recorded run's session is nowhere to be found", async () => {
    developing([{ path: PATH, sessionId: "s-dev" }]);
    vi.mocked(findSessionLocation).mockReturnValue(null);
    vi.mocked(backend.createSession).mockResolvedValue("s-9");

    await developCard("ws-1", card("task", "To Do"));

    // "No page holds it" is the same evidence the sweep clears the record
    // on, so falling through to a fresh run is right rather than merely
    // tolerated: the recorded agent is gone, and refusing here would
    // strand the card behind a lock nothing is holding. Asserted so a
    // change to it is a decision rather than an accident.
    expect(backend.createSession).toHaveBeenCalled();
  });

  it("refuses a Run, and leaves the card's status exactly where it was", async () => {
    developing([{ path: PATH, sessionId: "s-dev" }]);

    const err = await runCard("ws-1", card("task", "To Do"));

    expect(err).toContain("developing this card");
    expect(backend.createSession).not.toHaveBeenCalled();
    // The refusal is BEFORE the status write, so a refused launch leaves
    // the board untouched instead of moving a card for a run that never
    // happened.
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
  });

  it("refuses a Resume and a Send to the workspace agent", async () => {
    developing([{ path: PATH, sessionId: "s-dev" }]);
    layoutState.update((st) => ({
      ...st,
      workspaces: st.workspaces.map((w) => ({ ...w, mainSessionId: "main-1" })),
    }));

    expect(await resumeCard("ws-1", card("task", "In Progress"))).toContain("developing this card");
    expect(await sendToMainAgent("ws-1", card("task", "To Do"))).toContain("developing this card");
    expect(backend.createSession).not.toHaveBeenCalled();
    expect(backend.writeInput).not.toHaveBeenCalled();
  });

  // Re-launch replays the ORIGINAL prompt, which is the very text the
  // develop agent is replacing -- the launch with the most to lose here,
  // not the least.
  it("refuses a Re-launch of the card's remembered command", async () => {
    kanbanState.set({
      "ws-1": board([{ path: PATH, sessionId: "s-dead", cwd: "/ws", command: "claude -p x" }]),
    });
    developing([{ path: PATH, sessionId: "s-dev" }]);

    expect(await relaunchCard("ws-1", PATH)).toContain("developing this card");
    expect(backend.createSession).not.toHaveBeenCalled();
  });

  it("lets every OTHER card run: the lock is one card's, not the board's", async () => {
    developing([{ path: "/ws/.gavin-root/plans/other.md", sessionId: "s-dev" }]);
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\nkind: task\n---\nDo it.\n",
      truncated: false,
      exists: true,
    });
    vi.mocked(backend.createSession).mockResolvedValue("s-9");
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);

    expect(await runCard("ws-1", card("task", "To Do"))).toBeNull();
    expect(backend.createSession).toHaveBeenCalled();
  });
});

/// The baseline is the one field on a binding that cannot be
/// reconstructed after the fact: by the time anybody asks where a run
/// started, the agent has moved HEAD and dirtied the tree. So it is
/// resolved before the session exists, carried by a resume, and
/// re-resolved by a re-launch -- three rules, one per launch shape.
describe("the run's baseline", () => {
  const BASE = "1111111111111111111111111111111111111111";

  it("runCard resolves it in the launch directory and records it on the binding", async () => {
    vi.mocked(baseShaForLaunch).mockResolvedValue(BASE);
    vi.mocked(backend.createSession).mockResolvedValue("s-9");
    vi.mocked(backend.linkCardSession).mockResolvedValue(undefined);
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);

    expect(await runCard("ws-1", card("plan", "To Do"))).toBeNull();

    expect(baseShaForLaunch).toHaveBeenCalledWith("/ws");
    // Before the agent: a sha resolved after `createSession` would
    // already include whatever the agent had done by then.
    expect(vi.mocked(baseShaForLaunch).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(backend.createSession).mock.invocationCallOrder[0]
    );
    expect(vi.mocked(backend.linkCardSession).mock.calls[0].at(-1)).toBe(BASE);
  });

  it("a launch with no baseline links a null rather than nothing", async () => {
    // Outside a repository, on an unborn HEAD, or against a daemon too
    // old to keep it. The null is passed explicitly so the row is
    // CLEARED: a previous run's baseline left in place would credit this
    // run with the last one's work.
    vi.mocked(baseShaForLaunch).mockResolvedValue(null);
    vi.mocked(backend.createSession).mockResolvedValue("s-9");
    vi.mocked(backend.linkCardSession).mockResolvedValue(undefined);
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);

    expect(await runCard("ws-1", card("plan", "To Do"))).toBeNull();
    expect(vi.mocked(backend.linkCardSession).mock.calls[0].at(-1)).toBeNull();
  });

  it("a resume carries the baseline it found instead of re-resolving one", async () => {
    kanbanState.set({
      "ws-1": board([
        {
          path: "/ws/.gavin-root/plans/t.md",
          sessionId: "s-dead",
          cwd: "/ws",
          command: "x",
          baseSha: BASE,
        },
      ]),
    });
    vi.mocked(findSessionLocation).mockReturnValue(null);
    vi.mocked(baseShaForLaunch).mockResolvedValue("2222222222222222222222222222222222222222");
    vi.mocked(backend.createSession).mockResolvedValue("s-new");
    vi.mocked(backend.linkCardSession).mockResolvedValue(undefined);

    expect(await resumeCard("ws-1", card("plan", "In Progress"))).toBeNull();

    // The run's OWN baseline, not the one the checkout is on now: a
    // resume is this run continuing, and everything the first attempt
    // wrote is still this run's work.
    expect(vi.mocked(backend.linkCardSession).mock.calls[0].at(-1)).toBe(BASE);
  });

  it("a re-launch resolves a new one, in the directory the run was launched in", async () => {
    kanbanState.set({
      "ws-1": board([
        {
          path: "/p/t.md",
          sessionId: "s-dead",
          cwd: "/p/drifted",
          command: "claude 'x'",
          launchCwd: "/p/wt",
          baseSha: BASE,
        },
      ]),
    });
    vi.mocked(baseShaForLaunch).mockResolvedValue("3333333333333333333333333333333333333333");
    vi.mocked(backend.createSession).mockResolvedValue("s-new");
    vi.mocked(backend.linkCardSession).mockResolvedValue(undefined);

    expect(await relaunchCard("ws-1", "/p/t.md")).toBeNull();

    // The LAUNCH directory, not `cwd`: `cwd` follows OSC 7 and the dead
    // agent may have left it anywhere.
    expect(baseShaForLaunch).toHaveBeenCalledWith("/p/wt");
    expect(vi.mocked(backend.linkCardSession).mock.calls[0].at(-1)).toBe(
      "3333333333333333333333333333333333333333"
    );
  });
});

describe("relaunchCard", () => {
  it("recreates from the stored binding and re-links", async () => {
    kanbanState.set({
      "ws-1": board([{ path: "/p/t.md", sessionId: "s-dead", cwd: "/p", command: "claude 'x'" }]),
    });
    vi.mocked(backend.createSession).mockResolvedValue("s-new");
    vi.mocked(backend.linkCardSession).mockResolvedValue(undefined);

    const err = await relaunchCard("ws-1", "/p/t.md");

    expect(err).toBeNull();
    expect(backend.createSession).toHaveBeenCalledWith("/p", "claude 'x'");
    expect(handleAgentSessionSpawned).toHaveBeenCalledWith("ws-1", "s-new");
    expect(get(kanbanState)["ws-1"].cardSessions[0].sessionId).toBe("s-new");
  });

  // Measured against the real binary: `claude --session-id <uuid>` on an
  // id that already exists refuses outright -- "Session ID <uuid> is
  // already in use" -- so replaying the stored command would not start
  // at all. A fresh id is also what this button MEANS: re-launch is "run
  // this again from the beginning"; reopening the conversation is
  // Resume, which is a different entry with different words on it.
  it("mints a new conversation id rather than replaying the one baked into the command", async () => {
    vi.mocked(resolvedAgentFor).mockReturnValue({
      profileId: "claude-code",
      file: "CLAUDE.md",
      command: "claude",
      launchCommand: "claude",
      promptArgs: "",
      mcpSupported: true,
      failurePatterns: ["API Error:"],
      failureCauses: [{ pattern: "/login", cause: "auth" }, { pattern: "Connection dropped", cause: "network" }],
      sessionIdArgs: "--session-id",
      resumeArgs: "--resume",
    } as never);
    kanbanState.set({
      "ws-1": board([
        {
          path: "/p/t.md",
          sessionId: "s-dead",
          cwd: "/p",
          command: "claude --session-id 11111111-1111-1111-1111-111111111111 'x'",
          conversationId: "11111111-1111-1111-1111-111111111111",
          launchCwd: "/p",
        },
      ]),
    });
    vi.mocked(backend.createSession).mockResolvedValue("s-new");
    vi.mocked(backend.linkCardSession).mockResolvedValue(undefined);

    expect(await relaunchCard("ws-1", "/p/t.md")).toBeNull();

    const [, command] = vi.mocked(backend.createSession).mock.calls[0];
    expect(command).not.toContain("11111111-1111-1111-1111-111111111111");
    expect(command).toMatch(/^claude --session-id [0-9a-f-]{36} 'x'$/);
    const bound = get(kanbanState)["ws-1"].cardSessions[0];
    expect(bound.conversationId).not.toBe("11111111-1111-1111-1111-111111111111");
    expect(bound.command).toBe(command);
  });

  it("errors when nothing is remembered", async () => {
    expect(await relaunchCard("ws-1", "/p/absent.md")).toContain("No session");
  });
});

describe("jumpToBoundSession", () => {
  it("jumps when the binding's session is alive", async () => {
    kanbanState.set({
      "ws-1": board([{ path: "/p/t.md", sessionId: "s-live", cwd: "/p", command: null }]),
    });
    vi.mocked(findSessionLocation).mockReturnValue({ workspaceId: "ws-1", pageId: "pg-1" });

    expect(await jumpToBoundSession("ws-1", "/p/t.md")).toBe("jumped");
    expect(switchToSessionInPage).toHaveBeenCalledWith("ws-1", "pg-1", "s-live");
  });

  it("reports exited and none without navigating", async () => {
    kanbanState.set({
      "ws-1": board([{ path: "/p/t.md", sessionId: "s-dead", cwd: "/p", command: null }]),
    });
    vi.mocked(findSessionLocation).mockReturnValue(null);
    expect(await jumpToBoundSession("ws-1", "/p/t.md")).toBe("exited");
    expect(await jumpToBoundSession("ws-1", "/p/unbound.md")).toBe("none");
    expect(switchToSessionInPage).not.toHaveBeenCalled();
  });
});

// A binding whose session the daemon put back as a bare shell. It IS in
// a layout tree, and used to be indistinguishable from a live agent
// everywhere: Run jumped into the shell, Resume jumped into the shell,
// and Develop refused because "this card has a live agent".
describe("an interrupted binding", () => {
  function interrupt(sessionId: string): void {
    layoutState.update((s) => ({ ...s, interruptedSessionIds: new Set([sessionId]) }));
    vi.mocked(findSessionLocation).mockReturnValue({ workspaceId: "ws-1", pageId: "pg-1" });
  }

  it("reports interrupted from jumpToBoundSession, and navigates nowhere", async () => {
    kanbanState.set({
      "ws-1": board([{ path: "/p/t.md", sessionId: "s-live", cwd: "/p", command: null }]),
    });
    interrupt("s-live");

    expect(await jumpToBoundSession("ws-1", "/p/t.md")).toBe("interrupted");
    expect(switchToSessionInPage).not.toHaveBeenCalled();
  });

  it("lets resumeCard spawn over it and re-link, instead of jumping into the shell", async () => {
    kanbanState.set({
      "ws-1": board([
        { path: "/ws/.gavin-root/plans/t.md", sessionId: "s-live", cwd: "/ws", command: "x" },
      ]),
    });
    interrupt("s-live");
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\nkind: task\n---\nDo it.\n",
      truncated: false,
      exists: true,
    });
    vi.mocked(backend.createSession).mockResolvedValue("s-new");

    const err = await resumeCard("ws-1", card("task", "In Progress"));

    expect(err).toBeNull();
    expect(backend.createSession).toHaveBeenCalled();
    expect(get(kanbanState)["ws-1"].cardSessions[0].sessionId).toBe("s-new");
    // The resume prompt, not the from-scratch one: the killed agent's
    // edits are still in the checkout.
    expect(vi.mocked(backend.createSession).mock.calls[0][1]).toContain("gavin-resume");
  });

  it("lets developCard proceed — there is no live agent to edit under", async () => {
    kanbanState.set({
      "ws-1": board([{ path: "/p/t.md", sessionId: "s-live", cwd: "/p", command: null }]),
    });
    interrupt("s-live");
    vi.mocked(backend.createSession).mockResolvedValue("s-dev");

    expect(await developCard("ws-1", card("task", "To Do"))).toBeNull();
    expect(backend.createSession).toHaveBeenCalled();
  });
});

// The other cause of death, and the one with a resumable conversation
// behind it: the process is still alive at its prompt, so every check in
// the app used to read it as work in progress.
describe("a failed binding", () => {
  function broke(sessionId: string, reason = "API Error: Connection dropped"): void {
    layoutState.update((s) => ({ ...s, failureReasonById: { [sessionId]: reason } }));
    vi.mocked(findSessionLocation).mockReturnValue({ workspaceId: "ws-1", pageId: "pg-1" });
  }

  const claudeAgent = {
    profileId: "claude-code",
    file: "CLAUDE.md",
    command: "claude",
    launchCommand: "claude",
    promptArgs: "",
    mcpSupported: true,
    failurePatterns: ["API Error:"],
      failureCauses: [{ pattern: "/login", cause: "auth" }, { pattern: "Connection dropped", cause: "network" }],
    sessionIdArgs: "--session-id",
    resumeArgs: "--resume",
  };

  it("reports failed from jumpToBoundSession, and navigates nowhere", async () => {
    kanbanState.set({
      "ws-1": board([{ path: "/p/t.md", sessionId: "s-live", cwd: "/p", command: null }]),
    });
    broke("s-live");

    expect(await jumpToBoundSession("ws-1", "/p/t.md")).toBe("failed");
    expect(switchToSessionInPage).not.toHaveBeenCalled();
  });

  // The payoff of the whole conversation-id design: the agent reopens
  // its OWN transcript instead of a new agent reading an account of it.
  it("resumes the conversation by id, with no prompt and no file read", async () => {
    vi.mocked(resolvedAgentFor).mockReturnValue(claudeAgent as never);
    kanbanState.set({
      "ws-1": board([
        {
          path: "/ws/.gavin-root/plans/t.md",
          sessionId: "s-live",
          cwd: "/ws/drifted",
          command: "claude --session-id u-1 'go'",
          conversationId: "u-1",
          launchCwd: "/ws/worktree",
        },
      ]),
    });
    broke("s-live");
    vi.mocked(backend.createSession).mockResolvedValue("s-new");

    const err = await resumeCard("ws-1", card("task", "In Progress"));

    expect(err).toBeNull();
    // The LAUNCH cwd, not the session's: `cwd` follows OSC 7 and drifts
    // the moment the agent moves into a worktree.
    expect(backend.createSession).toHaveBeenCalledWith("/ws/worktree", "claude --resume u-1");
    // Nothing composed and nothing read: the transcript already holds
    // the whole task.
    expect(backend.readFileForViewer).not.toHaveBeenCalled();
    // The same conversation id: resuming appends to that transcript, so
    // the id stays the handle on this work.
    expect(get(kanbanState)["ws-1"].cardSessions[0]).toMatchObject({
      sessionId: "s-new",
      conversationId: "u-1",
      launchCwd: "/ws/worktree",
    });
  });

  // A profile with no verified resume argv keeps today's behaviour, and
  // so does a binding recorded before v21. The two layer cleanly.
  it("falls back to the written reconstruction with no conversation to reopen", async () => {
    vi.mocked(resolvedAgentFor).mockReturnValue(claudeAgent as never);
    kanbanState.set({
      "ws-1": board([
        { path: "/ws/.gavin-root/plans/t.md", sessionId: "s-live", cwd: "/ws", command: "x" },
      ]),
    });
    broke("s-live");
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\nkind: task\n---\nDo it.\n",
      truncated: false,
      exists: true,
    });
    vi.mocked(backend.createSession).mockResolvedValue("s-new");

    expect(await resumeCard("ws-1", card("task", "In Progress"))).toBeNull();
    expect(vi.mocked(backend.createSession).mock.calls[0][1]).toContain("gavin-resume");
  });
});

describe("sendToMainAgent", () => {
  function setMainSession(id: string | null): void {
    layoutState.update((st) => ({
      ...st,
      workspaces: st.workspaces.map((w) => ({ ...w, mainSessionId: id ?? undefined })),
    }));
  }

  it("bracketed-pastes the prompt into the main session, sets In Progress, jumps Home", async () => {
    setMainSession("main-1");
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\nkind: task\n---\nDo it.\n",
      truncated: false,
      exists: true,
    });
    vi.mocked(backend.writeInput).mockResolvedValue(undefined);
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);

    const err = await sendToMainAgent("ws-1", card("task", "To Do"));

    expect(err).toBeNull();
    const [sid, data] = vi.mocked(backend.writeInput).mock.calls[0];
    expect(sid).toBe("main-1");
    expect(data.startsWith("\x1b[200~")).toBe(true);
    expect(data.endsWith("\x1b[201~\r")).toBe(true);
    expect(data).toContain("Do it.");
    expect(backend.setPlanFrontmatterField).toHaveBeenCalledWith(
      "/ws/.gavin-root/plans/t.md",
      "status",
      "In Progress"
    );
    expect(switchWorkspaceView).toHaveBeenCalledWith("ws-1", "home");
    expect(backend.createSession).not.toHaveBeenCalled();
    expect(backend.linkCardSession).not.toHaveBeenCalled();
    setMainSession(null);
  });

  it("refuses without a running main agent, and for notes", async () => {
    setMainSession(null);
    expect(await sendToMainAgent("ws-1", card("plan", null))).toContain("start it on the Home tab");
    expect(await sendToMainAgent("ws-1", card("note", null))).toContain("not runnable");
    expect(backend.writeInput).not.toHaveBeenCalled();
  });

  /// Setting a status on the main session is how these drive the choice
  /// between a paste and a queue -- the whole decision is
  /// shouldQueueForMainAgent over that one value.
  function setMainStatus(status: SessionStatus | undefined): void {
    const sessionStatusById: Record<string, SessionStatus> = {};
    if (status !== undefined) sessionStatusById["main-1"] = status;
    layoutState.update((st) => ({ ...st, sessionStatusById }));
  }

  async function sendPlan(): Promise<string | null> {
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    return sendToMainAgent("ws-1", card("plan", "To Do"));
  }

  it("queues instead of pasting into an agent that is mid-turn", async () => {
    // A bracketed paste here lands somewhere in the agent's reasoning,
    // at a prompt that is not accepting input, and says nothing about
    // having done so.
    setMainSession("main-1");
    setMainStatus("working");

    expect(await sendPlan()).toBeNull();

    expect(backend.queueInput).toHaveBeenCalledWith("main-1", expect.stringContaining("/ws/.gavin-root/plans/t.md"));
    expect(backend.writeInput).not.toHaveBeenCalled();
    // Still lands the human on Home, which is where the strip showing
    // the follow-up they just queued lives.
    expect(switchWorkspaceView).toHaveBeenCalledWith("ws-1", "home");
    setMainSession(null);
    setMainStatus(undefined);
  });

  it("queues rather than answering an agent's question with a card", async () => {
    setMainSession("main-1");
    setMainStatus("waiting_for_input");

    expect(await sendPlan()).toBeNull();

    expect(backend.queueInput).toHaveBeenCalled();
    expect(backend.writeInput).not.toHaveBeenCalled();
    setMainSession(null);
    setMainStatus(undefined);
  });

  it("pastes into an idle agent, and into one whose status it never heard", async () => {
    setMainSession("main-1");
    for (const status of ["idle", "failed", undefined] as const) {
      vi.mocked(backend.writeInput).mockClear();
      vi.mocked(backend.queueInput).mockClear();
      setMainStatus(status);

      expect(await sendPlan()).toBeNull();

      expect(backend.writeInput).toHaveBeenCalled();
      expect(backend.queueInput).not.toHaveBeenCalled();
    }
    setMainSession(null);
    setMainStatus(undefined);
  });

  it("keeps the old paste against a daemon too old to hold a queue", async () => {
    // The request would never reach the wire, so queueing would drop the
    // card in silence -- strictly worse than a badly timed paste.
    setMainSession("main-1");
    setMainStatus("working");
    daemonCompat.set({ daemonVersion: 25, appVersion: 29, degraded: true });

    expect(await sendPlan()).toBeNull();

    expect(backend.writeInput).toHaveBeenCalled();
    expect(backend.queueInput).not.toHaveBeenCalled();
    daemonCompat.set(null);
    setMainSession(null);
    setMainStatus(undefined);
  });

  it("refuses an interrupted main agent instead of running the prompt as a command", async () => {
    // That tab holds a bare shell in the agent's old cwd. Pasting is a
    // line of prose at a shell prompt; queueing is a message that can
    // never be delivered, because `interrupted` is never cleared.
    setMainSession("main-1");
    setMainStatus("working");
    layoutState.update((st) => ({ ...st, interruptedSessionIds: new Set(["main-1"]) }));

    expect(await sendPlan()).toContain("Relaunch the agent");

    expect(backend.writeInput).not.toHaveBeenCalled();
    expect(backend.queueInput).not.toHaveBeenCalled();
    layoutState.update((st) => ({ ...st, interruptedSessionIds: new Set<string>() }));
    setMainSession(null);
    setMainStatus(undefined);
  });
});

// --- the attachment run gate ----------------------------------------
// One test per path a card can be launched down (spec: a missing
// attachment blocks the run, naming the file). The rail-step path lives
// in orchestrationState.test.ts, which owns the scheduler.
describe("attachments gate the run", () => {
  function attached(): CardView {
    const c = card("task", "To Do");
    c.attachments = ["docs/spec.md"];
    return c;
  }

  beforeEach(() => {
    vi.mocked(workspaceRootPath).mockReturnValue("/ws");
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\nkind: task\n---\nDo the thing.\n",
      truncated: false,
      exists: true,
    });
    vi.mocked(backend.createSession).mockResolvedValue("s-9");
    vi.mocked(backend.linkCardSession).mockResolvedValue(undefined);
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
  });

  it("runCard: an attachment that resolves reaches the prompt as an absolute path", async () => {
    vi.mocked(backend.attachmentStatus).mockResolvedValue([
      { path: "docs/spec.md", absolutePath: "/ws/docs/spec.md", exists: true },
    ]);

    const err = await runCard("ws-1", attached());

    expect(err).toBeNull();
    expect(backend.attachmentStatus).toHaveBeenCalledWith("/ws", ["docs/spec.md"]);
    const [, command] = vi.mocked(backend.createSession).mock.calls[0];
    expect(command).toContain("/ws/docs/spec.md");
    expect(command).toContain("read them before you start");
  });

  it("runCard: a missing attachment refuses by name, spawns nothing, and leaves the status alone", async () => {
    vi.mocked(backend.attachmentStatus).mockResolvedValue([
      { path: "docs/spec.md", absolutePath: "/ws/docs/spec.md", exists: false },
    ]);

    const err = await runCard("ws-1", attached());

    expect(err).toContain("docs/spec.md");
    expect(backend.createSession).not.toHaveBeenCalled();
    // The gate runs BEFORE the status write: a refused run must not
    // move the card on the board.
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
  });

  it("resumeCard: the same gate, so a resume cannot slip past it", async () => {
    vi.mocked(backend.attachmentStatus).mockResolvedValue([
      { path: "docs/spec.md", absolutePath: null, exists: false },
    ]);

    const err = await resumeCard("ws-1", attached());

    expect(err).toContain("docs/spec.md");
    expect(backend.createSession).not.toHaveBeenCalled();
  });

  it("sendToMainAgent: refuses before pasting anything into the agent", async () => {
    layoutState.update((s) => ({
      ...s,
      workspaces: s.workspaces.map((w) => ({ ...w, mainSessionId: "s-main" })),
    }));
    vi.mocked(backend.attachmentStatus).mockResolvedValue([
      { path: "docs/spec.md", absolutePath: "/ws/docs/spec.md", exists: false },
    ]);

    const err = await sendToMainAgent("ws-1", attached());

    expect(err).toContain("docs/spec.md");
    expect(backend.writeInput).not.toHaveBeenCalled();
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
  });

  it("a card with no attachments never asks the host at all", async () => {
    const err = await runCard("ws-1", card("task", "To Do"));

    expect(err).toBeNull();
    expect(backend.attachmentStatus).not.toHaveBeenCalled();
  });

  it("a rootless workspace refuses rather than resolving against nothing", async () => {
    vi.mocked(workspaceRootPath).mockReturnValue(null);

    const err = await runCard("ws-1", attached());

    expect(err).toContain("no root folder");
    expect(backend.attachmentStatus).not.toHaveBeenCalled();
    expect(backend.createSession).not.toHaveBeenCalled();
  });
});
