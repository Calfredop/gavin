// An Orchestrated plan (v80, ADR 0012) -- every plan with a Nested task,
// `children:` line or not (ADR 0014) -- from the phone: what its card and
// its rail say about each Nested task, the Children control, and Run --
// which does what the desk's does, the plan's own rail -- read at the wire
// against the Demo Workstation.
import { afterEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import { kanbanState } from "$lib/board/kanbanState";
import { gavinTrees } from "$lib/core/gavinState";
import { answerDialog, dialogRequest } from "$lib/core/dialog";
import { mergePlanCards, type CardView } from "$lib/core/planBoard";
import { childCards } from "$lib/cards/cardRelations";
import { orchestrations } from "$lib/orchestration/orchestrationState";
import type { BundleMessage } from "$companion/channel/messages";
import { loopback } from "$companion/channel/port";
import { DEMO } from "$companion/demo/sampleData";
import { createDemoWorkstation, type DemoWorkstation } from "$companion/demo/workstation";
import { disconnectChannel } from "$companion/remote/connection";
import { launch, setChildren } from "$companion/state/cards";
import { loadNestedRuns } from "$companion/state/rails";
import { connectWorkstation, openWorkspace } from "$companion/state/workstation";
import { allCards, childRows, findCard } from "$companion/surfaces/phoneCard";
import { railRows } from "$companion/surfaces/phoneRails";
import { settle } from "$companion/testing/demoBench";
import { deviceStorage, resetDesktopStores } from "$companion/testing/desktopStores";

let disconnect: (() => void) | null = null;

afterEach(() => {
  disconnect?.();
  disconnect = null;
  disconnectChannel();
  resetDesktopStores();
});

const PLANS = `${DEMO.notesRoot}/.gavin-root/plans`;

async function visit(demo: DemoWorkstation = createDemoWorkstation()): Promise<DemoWorkstation> {
  disconnect = await connectWorkstation(loopback(demo), deviceStorage());
  await settle();
  openWorkspace(DEMO.notes);
  await settle();
  // What an Orchestrated plan's card reads as it opens.
  await loadNestedRuns(DEMO.notes);
  await settle();
  return demo;
}

function projection() {
  return mergePlanCards(get(kanbanState)[DEMO.notes], get(gavinTrees)[DEMO.notes]);
}

function card(fileName: string): CardView {
  const found = findCard(projection(), `${PLANS}/${fileName}`);
  if (!found) throw new Error(`no card ${fileName} on the board`);
  return found;
}

function sentSince(demo: DemoWorkstation, from: number): { cmd: string; args: Record<string, unknown> }[] {
  return demo
    .received()
    .slice(from)
    .flatMap((m: BundleMessage) => (m.type === "invoke" ? [{ cmd: m.cmd, args: m.args }] : []));
}

/// Approves every first-Run review the phone raises until it asks no more,
/// and says which cards it was asked about.
async function approveReviews(): Promise<string[]> {
  const titles: string[] = [];
  for (;;) {
    await settle();
    const request = get(dialogRequest);
    if (!request) return titles;
    titles.push(request.title);
    answerDialog(request.id, true, false);
  }
}

describe("an Orchestrated plan's card on the phone", () => {
  it("lists each nested task with its own run and its tick, not a column it does not have", async () => {
    await visit();
    const plan = card("notebook-search.md");
    const rows = childRows(plan, childCards(plan, allCards(projection())), get(orchestrations)[DEMO.notes]);
    expect(rows.map((r) => [r.title, r.state, r.said])).toEqual([
      ["Build the search index", "done", "ticked"],
      ["Rank results by recency", "running", "running"],
      ["Search box in the toolbar", "stalled", "stalled"],
    ]);
  });

  it("lists the nested task of a plan with no `children:` line by its own run too", async () => {
    await visit();
    const plan = card("offline-sync.md");
    expect(plan.children).toBeNull();
    const rows = childRows(plan, childCards(plan, allCards(projection())), get(orchestrations)[DEMO.notes]);
    expect(rows.map((r) => [r.state, r.said])).toEqual([["pending", "not run yet"]]);
  });

  it("says on its rail step how many of its nested tasks are ticked", async () => {
    await visit();
    const rail = railRows({
      orch: get(orchestrations)[DEMO.notes],
      tree: get(gavinTrees)[DEMO.notes],
      board: get(kanbanState)[DEMO.notes],
    })[0];
    expect(rail.name).toBe("Notebook search");
    expect(rail.stages[0].steps[0].nested).toBe("1/3 nested");
  });
});

describe("the Children control on the phone", () => {
  it("writes the plan's line, and the card reads it back", async () => {
    const demo = await visit();
    const at = demo.received().length;
    expect(await setChildren(DEMO.notes, card("offline-sync.md"), "parallel")).toBeNull();
    await settle();
    expect(sentSince(demo, at).find((s) => s.cmd === "set_plan_frontmatter_field")?.args).toMatchObject({
      path: `${PLANS}/offline-sync.md`,
      key: "children",
      value: "parallel",
    });
    expect(card("offline-sync.md").children).toBe("parallel");
    expect(await setChildren(DEMO.notes, card("offline-sync.md"), "sequence")).toBeNull();
    await settle();
    expect(card("offline-sync.md").children).toBe("sequence");
  });

  it("writes nothing when a plan with no line is set to sequence, which it already runs as", async () => {
    const demo = await visit();
    const at = demo.received().length;
    expect(await setChildren(DEMO.notes, card("offline-sync.md"), "sequence")).toBeNull();
    await settle();
    expect(sentSince(demo, at).some((s) => s.cmd === "set_plan_frontmatter_field")).toBe(false);
  });
});

describe("Run on an Orchestrated plan from the phone", () => {
  it("puts the plan on a rail of its own and starts it, and the desk runs its nested task as its own session", async () => {
    // No `children:` line: a plan with a Nested task runs this way anyway.
    const demo = await visit();
    const at = demo.received().length;

    const running = launch(DEMO.notes, card("offline-sync.md"), "run");
    // The rail cannot ask the first-Run review, so the press does -- for
    // the plan itself, whose session the rail launches last.
    expect((await approveReviews()).some((t) => t.includes("Offline sync"))).toBe(true);
    expect(await running).toBeNull();
    await settle();

    const writes = sentSince(demo, at).filter((s) => s.cmd === "set_orchestration" || s.cmd === "set_rail_run");
    expect(writes.map((s) => s.cmd)).toEqual(["set_orchestration", "set_orchestration", "set_rail_run"]);
    const own = demo.state.orchestrations[DEMO.notes].rails.find((r) => r.name === "Offline sync");
    expect(own?.stages.flatMap((s) => s.steps).map((t) => t.cardPath)).toEqual([`${PLANS}/offline-sync.md`]);

    // The desk took it from there: the nested task runs in a session of
    // its own, and stays nested -- no status was ever written to it.
    const child = `${PLANS}/conflict-merge.md`;
    const run = demo.state.orchestrations[DEMO.notes].nestedRuns?.find((r) => r.childPath === child);
    expect(run?.state).toBe("running");
    expect(demo.state.files[child]).not.toContain("status:");
    expect(demo.state.files[`${PLANS}/offline-sync.md`]).toContain("- [ ] [Merge conflicting edits by paragraph](./conflict-merge.md)");
  });
});
