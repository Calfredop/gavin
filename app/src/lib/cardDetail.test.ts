import { describe, it, expect } from "vitest";
import {
  CARD_SECTION_KEY,
  DEFAULT_SECTIONS_OPEN,
  cardSessionBar,
  loadSectionsOpen,
  railSummary,
  runLabel,
  saveSectionsOpen,
  settingsSummary,
  type CardSectionsOpen,
  type CardSituation,
} from "./cardDetail";

const ids = (situation: CardSituation): string[] =>
  (cardSessionBar(situation)?.actions ?? []).map((a) => a.id);
const enabled = (situation: CardSituation): string[] =>
  (cardSessionBar(situation)?.actions ?? []).filter((a) => a.enabled).map((a) => a.id);

describe("cardSessionBar", () => {
  it("draws nothing for a card with no agent story", () => {
    expect(cardSessionBar({ kind: "none" })).toBeNull();
  });

  it("says a live agent is waiting for a human, and tints for it", () => {
    // The whole reason the bar is pinned above the scroller: this is the
    // state where the panel has something urgent to say, and it used to
    // be the state whose one control sat below a page of prompt text.
    const bar = cardSessionBar({
      kind: "bound",
      phase: "live",
      status: "waiting_for_input",
      orphan: false,
    })!;
    expect(bar.headline).toBe("Waiting for you");
    expect(bar.wantsHuman).toBe(true);
    expect(bar.tone).toBe("warning");
    expect(bar.actions[0]).toMatchObject({ id: "jump", enabled: true });
  });

  it("does not claim a working agent wants anything", () => {
    const bar = cardSessionBar({ kind: "bound", phase: "live", status: "working", orphan: false })!;
    expect(bar.wantsHuman).toBe(false);
    expect(bar.tone).toBe("accent");
  });

  it("never calls an idle agent finished", () => {
    // An `idle` session is one that has been QUIET for two seconds. A
    // headline of "done" over that is the mistake that made a
    // connection-killed agent read as a finished turn.
    const bar = cardSessionBar({ kind: "bound", phase: "live", status: "idle", orphan: false })!;
    expect(bar.headline).toBe("Idle at its prompt");
    expect(bar.tone).toBe("neutral");
  });

  it("offers Jump and Re-launch as a pair, with only the possible one live", () => {
    expect(ids({ kind: "bound", phase: "live", status: "working", orphan: false })).toEqual([
      "jump",
      "relaunch",
    ]);
    expect(enabled({ kind: "bound", phase: "live", status: "working", orphan: false })).toEqual([
      "jump",
    ]);
    expect(enabled({ kind: "bound", phase: "exited", status: null, orphan: false })).toEqual([
      "relaunch",
    ]);
  });

  it("adds Resume to an interrupted or failed run, ahead of the pair", () => {
    for (const phase of ["interrupted", "failed"] as const) {
      expect(ids({ kind: "bound", phase, status: null, orphan: false })).toEqual([
        "resume",
        "jump",
        "relaunch",
      ]);
    }
    const interrupted = cardSessionBar({
      kind: "bound",
      phase: "interrupted",
      status: null,
      orphan: false,
    })!;
    expect(interrupted.wantsHuman).toBe(true);
  });

  it("puts ending an orphan process ahead of resuming beside it", () => {
    // Resuming next to an agent that never stopped is the
    // second-agent-in-one-checkout outcome, and the two buttons are
    // neighbours.
    const bar = cardSessionBar({
      kind: "bound",
      phase: "interrupted",
      status: null,
      orphan: true,
    })!;
    expect(bar.actions[0]).toMatchObject({ id: "end-orphan", danger: true });
    expect(bar.actions.map((a) => a.id)).toEqual(["end-orphan", "resume", "jump", "relaunch"]);
    expect(bar.tone).toBe("danger");
    expect(bar.wantsHuman).toBe(true);
    expect(bar.headline).toContain("its process is still running");
  });

  it("reads an exited session as neither broken nor waiting", () => {
    const bar = cardSessionBar({ kind: "bound", phase: "exited", status: null, orphan: false })!;
    expect(bar.wantsHuman).toBe(false);
    expect(bar.tone).toBe("neutral");
  });

  it("leads an unbound card with Run, and names the kind in the label", () => {
    const task = cardSessionBar({
      kind: "unbound",
      cardKind: "task",
      canDevelop: false,
      runBlocked: false,
    })!;
    expect(task.actions[0]).toMatchObject({ id: "run", enabled: true });
    expect(task.actions[0].label).toBe(runLabel("task"));
    expect(runLabel("plan")).toContain("this plan");
    expect(runLabel("task")).toContain("this task");
  });

  it("offers the interview only where a thin card can still have one", () => {
    expect(
      ids({ kind: "unbound", cardKind: "task", canDevelop: true, runBlocked: false })
    ).toEqual(["run", "develop", "best-of-n"]);
    expect(
      ids({ kind: "unbound", cardKind: "task", canDevelop: false, runBlocked: false })
    ).toEqual(["run", "best-of-n"]);
  });

  it("blocks every launch when the workspace's agent takes no prompt", () => {
    // All three compose a command line. Re-launch never appears here --
    // it replays a stored command, so the blocker does not reach it.
    expect(
      enabled({ kind: "unbound", cardKind: "plan", canDevelop: true, runBlocked: true })
    ).toEqual([]);
  });

  it("replaces every launch with one jump while the card is being developed", () => {
    const bar = cardSessionBar({ kind: "developing" })!;
    expect(bar.actions.map((a) => a.id)).toEqual(["develop-jump"]);
    expect(bar.wantsHuman).toBe(false);
  });

  it("states a best-of-N decision without a button, because the rows carry it", () => {
    const bar = cardSessionBar({ kind: "best-of-n", summary: "2 of 3 running" })!;
    expect(bar.actions).toEqual([]);
    expect(bar.headline).toContain("2 of 3 running");
    expect(bar.wantsHuman).toBe(true);
  });
});

describe("settingsSummary", () => {
  const base = {
    labels: 0,
    attachments: 0,
    brokenAttachments: 0,
    autoCommit: false,
    autoCommitApplies: true,
  };

  it("says what a folded section holds, so folding is not a second hunt", () => {
    expect(settingsSummary({ ...base, labels: 2, attachments: 1, autoCommit: true })).toBe(
      "2 labels · 1 attachment · auto commit on"
    );
  });

  it("says nothing about committing on a kind that cannot carry it", () => {
    expect(settingsSummary({ ...base, autoCommitApplies: false })).toBe(
      "no labels · no attachments"
    );
  });

  it("surfaces a missing attachment even folded, because it blocks every run", () => {
    const text = settingsSummary({ ...base, attachments: 2, brokenAttachments: 1 });
    expect(text).toContain("⚠ 1 missing attachment");
  });
});

describe("railSummary", () => {
  it("distinguishes no rails at all from a card on none of them", () => {
    const none = { railName: null, stageNumber: null, stageCount: null, stepState: null };
    expect(railSummary({ ...none, railCount: 0 })).toBe("no rails yet");
    expect(railSummary({ ...none, railCount: 3 })).toBe("not on a rail");
  });

  it("names the stage a placed card sits at", () => {
    expect(
      railSummary({
        railCount: 2,
        railName: "Rework",
        stageNumber: 2,
        stageCount: 4,
        stepState: "running",
      })
    ).toBe("Rework · stage 2 of 4 · running");
  });
});

describe("section folding", () => {
  function storage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial));
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  }

  it("leads with the run's own evidence and folds the two settings blocks", () => {
    expect(DEFAULT_SECTIONS_OPEN).toEqual({ session: true, settings: false, rail: false });
  });

  it("round-trips through storage", () => {
    const s = storage();
    const open: CardSectionsOpen = { session: false, settings: true, rail: false };
    saveSectionsOpen(open, s);
    expect(JSON.parse(s.map.get(CARD_SECTION_KEY)!)).toEqual(open);
    expect(loadSectionsOpen(s)).toEqual(open);
  });

  it("falls back to the defaults on absent, corrupt and partial payloads", () => {
    expect(loadSectionsOpen(storage())).toEqual(DEFAULT_SECTIONS_OPEN);
    expect(loadSectionsOpen(storage({ [CARD_SECTION_KEY]: "{" }))).toEqual(DEFAULT_SECTIONS_OPEN);
    expect(loadSectionsOpen(storage({ [CARD_SECTION_KEY]: "null" }))).toEqual(DEFAULT_SECTIONS_OPEN);
    // A key written by an older build knows nothing about `rail`; that
    // section must come back to its default rather than to `undefined`.
    expect(loadSectionsOpen(storage({ [CARD_SECTION_KEY]: '{"settings":true}' }))).toEqual({
      ...DEFAULT_SECTIONS_OPEN,
      settings: true,
    });
  });

  it("survives a storage that throws, rather than taking the panel with it", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadSectionsOpen(blocked)).toEqual(DEFAULT_SECTIONS_OPEN);
    expect(() => saveSectionsOpen(DEFAULT_SECTIONS_OPEN, blocked)).not.toThrow();
  });
});
