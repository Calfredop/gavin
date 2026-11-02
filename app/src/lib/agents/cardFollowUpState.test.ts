import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get, writable } from "svelte/store";
import type { SessionStatus } from "$lib/core/notifications";

vi.mock("$lib/core/layoutState", () => ({
  layoutState: writable({
    workspaces: [
      {
        id: "ws-1",
        pages: [{ id: "p", layout: { type: "leaf", tabs: ["s-1"], activeTabIndex: 0 } }],
      },
    ],
    sessionStatusById: {} as Record<string, SessionStatus>,
    interruptedSessionIds: new Set<string>(),
  }),
  daemonCompat: writable(null),
}));
vi.mock("$lib/core/gavinState", () => ({ gavinTrees: writable({}) }));
vi.mock("$lib/board/kanbanState", () => ({
  kanbanState: writable({}),
  cardSessionFor: vi.fn(() => null),
}));
vi.mock("$lib/shell/appWindowState", () => ({ currentWindowLabel: () => "main" }));
vi.mock("$lib/agents/turnVerdictState", () => ({ turnVerdictById: writable({}) }));
vi.mock("$lib/core/sessionOwnershipState", () => ({ inputLockedReason: () => null }));
vi.mock("$lib/cards/cardRunActions", () => ({
  runCard: vi.fn(async () => null),
  launchCardAsNewSession: vi.fn(async () => null),
}));

import { layoutState } from "$lib/core/layoutState";
import { gavinTrees } from "$lib/core/gavinState";
import { cardSessionFor } from "$lib/board/kanbanState";
import { turnVerdictById } from "$lib/agents/turnVerdictState";
import { runCard, launchCardAsNewSession } from "$lib/cards/cardRunActions";
import {
  __resetCardFollowUpsForTesting,
  cancelCardFollowUp,
  cardFollowUpsById,
  holdCardFollowUp,
  openCardFollowUpNow,
  startCardFollowUps,
} from "$lib/agents/cardFollowUpState";

const PATH = "/ws/.gavin-root/plans/next.md";

function seedTree(): void {
  gavinTrees.set({
    "ws-1": {
      rootPath: "/ws",
      rootMissing: false,
      contexts: [
        {
          folderPath: "/ws",
          kind: "root",
          name: "root",
          plans: [
            {
              path: PATH,
              fileName: "next.md",
              title: "Next thing",
              status: "To Do",
              priority: null,
              order: null,
              kind: "task",
              parent: null,
              labels: [],
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

function setStatus(status: SessionStatus | undefined): void {
  layoutState.update((s) => {
    const sessionStatusById = { ...s.sessionStatusById };
    if (status === undefined) delete sessionStatusById["s-1"];
    else sessionStatusById["s-1"] = status;
    return { ...s, sessionStatusById };
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// The suite runs in node, which has no localStorage of its own: a Map
// behind the Storage methods the module uses is the whole of it.
const stored = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => void stored.set(k, v),
  removeItem: (k: string) => void stored.delete(k),
  clear: () => stored.clear(),
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  __resetCardFollowUpsForTesting();
  seedTree();
  turnVerdictById.set({});
  setStatus("working");
  vi.mocked(runCard).mockResolvedValue(null);
  vi.mocked(cardSessionFor).mockReturnValue(null);
});

afterEach(() => __resetCardFollowUpsForTesting());

describe("a card held for a new session", () => {
  it("waits while the agent works and opens when its turn ends", async () => {
    startCardFollowUps();
    holdCardFollowUp("s-1", "ws-1", { id: PATH, title: "Next thing" });
    await flush();
    expect(runCard).not.toHaveBeenCalled();
    expect(get(cardFollowUpsById)["s-1"]).toHaveLength(1);

    setStatus("idle");
    await flush();

    expect(runCard).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runCard).mock.calls[0][0]).toBe("ws-1");
    expect(vi.mocked(runCard).mock.calls[0][1].id).toBe(PATH);
    expect(get(cardFollowUpsById)["s-1"]).toBeUndefined();
  });

  it("opens at once when the agent is already idle", async () => {
    setStatus("idle");
    startCardFollowUps();
    holdCardFollowUp("s-1", "ws-1", { id: PATH, title: "Next thing" });
    await flush();
    expect(runCard).toHaveBeenCalledTimes(1);
  });

  it("launches once, however many store changes land mid-launch", async () => {
    let finish!: (v: null) => void;
    vi.mocked(runCard).mockReturnValue(new Promise((r) => (finish = r)));
    setStatus("idle");
    startCardFollowUps();
    holdCardFollowUp("s-1", "ws-1", { id: PATH, title: "Next thing" });
    // A launch moves the stores the watcher listens to.
    setStatus("idle");
    turnVerdictById.set({});
    setStatus("idle");
    finish(null);
    await flush();
    expect(runCard).toHaveBeenCalledTimes(1);
  });

  it("does not open on a turn that ended on a question", async () => {
    startCardFollowUps();
    holdCardFollowUp("s-1", "ws-1", { id: PATH, title: "Next thing" });
    turnVerdictById.set({ "s-1": { state: "read", reading: { kind: "asking" } } } as never);
    setStatus("idle");
    await flush();
    expect(runCard).not.toHaveBeenCalled();
  });

  it("puts a refused launch back with its reason, and stops firing it", async () => {
    vi.mocked(runCard).mockResolvedValue("Attachment missing: spec.md");
    setStatus("idle");
    startCardFollowUps();
    holdCardFollowUp("s-1", "ws-1", { id: PATH, title: "Next thing" });
    await flush();
    const [entry] = get(cardFollowUpsById)["s-1"];
    expect(entry.error).toBe("Attachment missing: spec.md");

    // Every later status change would otherwise repaint the same refusal.
    setStatus("working");
    setStatus("idle");
    await flush();
    expect(runCard).toHaveBeenCalledTimes(1);

    // The human can still send it again by hand.
    vi.mocked(runCard).mockResolvedValue(null);
    await openCardFollowUpNow("s-1", entry.id);
    expect(runCard).toHaveBeenCalledTimes(2);
    expect(get(cardFollowUpsById)["s-1"]).toBeUndefined();
  });

  it("starts a FRESH session for a card that already has one, rather than jumping", async () => {
    vi.mocked(cardSessionFor).mockReturnValue({ path: PATH, sessionId: "old" } as never);
    setStatus("idle");
    startCardFollowUps();
    holdCardFollowUp("s-1", "ws-1", { id: PATH, title: "Next thing" });
    await flush();
    expect(launchCardAsNewSession).toHaveBeenCalledTimes(1);
    expect(runCard).not.toHaveBeenCalled();
  });

  it("reports a card that left the board instead of launching nothing", async () => {
    gavinTrees.set({});
    setStatus("idle");
    startCardFollowUps();
    holdCardFollowUp("s-1", "ws-1", { id: PATH, title: "Next thing" });
    await flush();
    expect(runCard).not.toHaveBeenCalled();
    expect(get(cardFollowUpsById)["s-1"][0].error).toContain("no longer on the board");
  });

  it("can be cancelled", async () => {
    startCardFollowUps();
    holdCardFollowUp("s-1", "ws-1", { id: PATH, title: "Next thing" });
    const [entry] = get(cardFollowUpsById)["s-1"];
    cancelCardFollowUp("s-1", entry.id);
    setStatus("idle");
    await flush();
    expect(runCard).not.toHaveBeenCalled();
  });

  it("survives a reload", async () => {
    startCardFollowUps();
    holdCardFollowUp("s-1", "ws-1", { id: PATH, title: "Next thing" });
    // The window reloads: the module state is gone, localStorage is not.
    __resetCardFollowUpsForTesting();
    expect(get(cardFollowUpsById)).toEqual({});
    startCardFollowUps();
    expect(get(cardFollowUpsById)["s-1"]).toHaveLength(1);
    setStatus("idle");
    await flush();
    expect(runCard).toHaveBeenCalledTimes(1);
  });

  it("forgets the cards of a session that was closed", async () => {
    startCardFollowUps();
    holdCardFollowUp("s-9", "ws-1", { id: PATH, title: "Next thing" });
    await flush();
    // No workspace holds s-9 and the daemon says nothing of it: its turn
    // will never end, so its card would wait, invisible, for ever.
    expect(get(cardFollowUpsById)["s-9"]).toBeUndefined();
  });
});
