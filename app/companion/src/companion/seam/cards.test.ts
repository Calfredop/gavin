// A card, acted on from the phone: every action's traffic, read at the
// wire against the Demo Workstation, and what the phone hears back.
//
// What each test pins is what a Workstation is ASKED -- the commands, in
// order, with their arguments -- because that is the whole of what a
// Device does to a desk. What the phone then shows is the tree and the
// board the Workstation pushes back, read through the desktop's own
// stores.
import { afterEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import { cardSessionState } from "$lib/board/columnRunAction";
import { kanbanState } from "$lib/board/kanbanState";
import { parseChecklist } from "$lib/cards/planChecklist";
import { answerDialog, dialogRequest } from "$lib/core/dialog";
import type { HumanItem } from "$lib/core/gavin";
import { gavinTrees } from "$lib/core/gavinState";
import { layoutState } from "$lib/core/layoutState";
import { mergePlanCards, type CardView } from "$lib/core/planBoard";
import { answerOutcome, failAndCloseOutcome, failOutcome, passOutcome } from "$lib/decisions/decisions";
import { allSessionIds } from "$lib/panes/layout";
import type { BundleMessage } from "$companion/channel/messages";
import { loopback } from "$companion/channel/port";
import { DEMO } from "$companion/demo/sampleData";
import { createDemoWorkstation, type DemoWorkstation } from "$companion/demo/workstation";
import { disconnectChannel } from "$companion/remote/connection";
import { LAYOUT_SAVING_COMMANDS } from "$companion/remote/remoteRole";
import {
  answerItem,
  archiveCard,
  fileCard,
  followFile,
  launch,
  moveCard,
  renameCard,
  tickItem,
} from "$companion/state/cards";
import { endSession, startedHere } from "$companion/state/sessions";
import {
  closePage,
  connectWorkstation,
  openCard,
  openWorkspace,
  returnedFrom,
  showWorkspaces,
  view,
} from "$companion/state/workstation";
import { findCard, owedItems, prdPathOf } from "$companion/surfaces/phoneCard";
import { settle } from "$companion/testing/demoBench";
import { deviceStorage, resetDesktopStores } from "$companion/testing/desktopStores";

let disconnect: (() => void) | null = null;

afterEach(() => {
  disconnect?.();
  disconnect = null;
  disconnectChannel();
  resetDesktopStores();
});

const ATLAS_PLANS = `${DEMO.atlasRoot}/.gavin-root/plans`;

async function visit(demo: DemoWorkstation = createDemoWorkstation()): Promise<DemoWorkstation> {
  disconnect = await connectWorkstation(loopback(demo), deviceStorage());
  await settle();
  openWorkspace(DEMO.atlas);
  await settle();
  return demo;
}

/// A card as the board draws it, found by its file name.
function card(fileName: string): CardView {
  const tree = get(gavinTrees)[DEMO.atlas];
  const path = tree.contexts.flatMap((ctx) => ctx.plans).find((p) => p.fileName === fileName)?.path;
  const found = path ? findCard(mergePlanCards(get(kanbanState)[DEMO.atlas], tree), path) : null;
  if (!found) throw new Error(`no card ${fileName} on the board`);
  return found;
}

const columns = () => get(kanbanState)[DEMO.atlas].columns;

/// What the phone asked the Workstation to do from a point on: every
/// command, with its arguments.
function sentSince(demo: DemoWorkstation, from: number): { cmd: string; args: Record<string, unknown> }[] {
  return demo
    .received()
    .slice(from)
    .flatMap((m: BundleMessage) => (m.type === "invoke" ? [{ cmd: m.cmd, args: m.args }] : []));
}

/// The commands alone, reads of the board and the tree left out: those
/// are the phone catching up on a push, not something it did.
function actedSince(demo: DemoWorkstation, from: number): string[] {
  return sentSince(demo, from)
    .map((s) => s.cmd)
    .filter((cmd) => !["get_board", "get_gavin_tree", "worktree_setup"].includes(cmd));
}

/// ...and only the ones that change something at the Workstation.
function wroteSince(demo: DemoWorkstation, from: number): string[] {
  const READS = ["read_file_for_viewer", "attachment_status", "agent_profiles", "git_head_sha"];
  return actedSince(demo, from).filter((cmd) => !cmd.startsWith("get_") && !READS.includes(cmd));
}

/// Answers the dialog the phone has up.
async function answer(confirmed: boolean, checked = false): Promise<void> {
  await settle();
  const request = get(dialogRequest);
  if (!request) throw new Error("no dialog is up");
  answerDialog(request.id, confirmed, checked);
}

/// Starts an action that asks a question, answers it, and waits for it.
async function asked<T>(action: Promise<T>, confirmed: boolean, checked = false): Promise<T> {
  await answer(confirmed, checked);
  const result = await action;
  await settle();
  return result;
}

function itemOn(fileName: string): HumanItem {
  return owedItems(get(gavinTrees)[DEMO.atlas], card(fileName).id)[0];
}

describe("moving a card", () => {
  it("is one status write, and the board hears it back", async () => {
    const demo = await visit();
    const at = demo.received().length;
    expect(await moveCard(DEMO.atlas, card("flaky-expiry-test.md"), "In Progress", columns())).toBeNull();
    await settle();

    expect(sentSince(demo, at)).toEqual([
      {
        cmd: "set_plan_frontmatter_field",
        args: { path: `${ATLAS_PLANS}/flaky-expiry-test.md`, key: "status", value: "In Progress" },
      },
      ...sentSince(demo, at).slice(1),
    ]);
    expect(actedSince(demo, at)).toEqual(["set_plan_frontmatter_field"]);
    expect(card("flaky-expiry-test.md").status).toBe("In Progress");
  });

  it("asks first when a plan would take its tasks into done/, and the open card follows the file", async () => {
    const demo = await visit();
    const plan = card("token-refresh.md");
    openCard(plan.id);
    const at = demo.received().length;
    expect(await asked(moveCard(DEMO.atlas, plan, "Done", columns()), true)).toBeNull();

    expect(actedSince(demo, at)).toEqual(["set_plan_frontmatter_field"]);
    expect(get(view).page).toEqual({ kind: "card", path: `${ATLAS_PLANS}/done/token-refresh.md` });
    expect(card("rotate-on-use.md").id).toBe(`${ATLAS_PLANS}/done/rotate-on-use.md`);
    // Its agent's binding followed the file, at the Workstation.
    expect(get(kanbanState)[DEMO.atlas].cardSessions.find((cs) => cs.sessionId === "s-atlas-auth")?.path).toBe(
      `${ATLAS_PLANS}/done/token-refresh.md`
    );
  });

  it("writes nothing when that question is declined", async () => {
    const demo = await visit();
    const at = demo.received().length;
    expect(await asked(moveCard(DEMO.atlas, card("token-refresh.md"), "Done", columns()), false)).toBeNull();
    expect(actedSince(demo, at)).toEqual([]);
  });
});

describe("renaming a card", () => {
  it("writes its title, and its file keeps its name", async () => {
    const demo = await visit();
    const at = demo.received().length;
    expect(await renameCard(DEMO.atlas, card("proration.md"), "  Prorate plan changes to the day ")).toBeNull();
    await settle();

    expect(sentSince(demo, at)[0]).toEqual({
      cmd: "set_plan_frontmatter_field",
      args: {
        path: `${DEMO.atlasRoot}/services/billing/.gavin/plans/proration.md`,
        key: "title",
        value: "Prorate plan changes to the day",
      },
    });
    expect(card("proration.md").title).toBe("Prorate plan changes to the day");
  });

  it("sends nothing for a title left as it was", async () => {
    const demo = await visit();
    const at = demo.received().length;
    await renameCard(DEMO.atlas, card("proration.md"), "Proration on plan change");
    expect(actedSince(demo, at)).toEqual([]);
  });
});

describe("ticking a checklist item", () => {
  it("is one guarded write, and the count moves", async () => {
    const demo = await visit();
    const plan = card("token-refresh.md");
    const file = demo.state.files[plan.id];
    const item = parseChecklist(file).find((i) => !i.checked)!;
    const at = demo.received().length;
    expect(await tickItem(plan.id, item)).toBeNull();
    await settle();

    expect(sentSince(demo, at)[0]).toEqual({
      cmd: "set_checklist_item",
      args: { path: plan.id, lineIndex: item.lineIndex, expectedText: item.rawText, checked: true },
    });
    expect(card("token-refresh.md").checklistDone).toBe(plan.checklistDone + 1);
  });

  it("is refused when an agent rewrote the line meanwhile, and says to try again", async () => {
    const demo = await visit();
    const plan = card("token-refresh.md");
    const item = parseChecklist(demo.state.files[plan.id]).find((i) => !i.checked)!;
    const error = await tickItem(plan.id, { ...item, rawText: "Something an agent has since rewritten" });
    expect(error).toMatch(/try once more/);
    expect(card("token-refresh.md").checklistDone).toBe(plan.checklistDone);
  });
});

describe("a decision", () => {
  it("is answered on its card, and the card's agent is told once it is free to hear it", async () => {
    const demo = await visit();
    const decision = itemOn("session-store.md");
    const at = demo.received().length;
    const result = await answerItem(DEMO.atlas, card("session-store.md").id, decision, answerOutcome("Postgres", ""));
    await settle();

    expect(sentSince(demo, at)[0]).toEqual({
      cmd: "resolve_human_item",
      args: {
        path: `${ATLAS_PLANS}/session-store.md`,
        expectedText: "Decision: Redis or Postgres for the session store?",
        outcome: { kind: "answer", text: "Postgres" },
      },
    });
    // Its agent has a menu of its own on screen, so the message waits in
    // its queue at the Workstation rather than being typed over the menu.
    expect(actedSince(demo, at)).toEqual(["resolve_human_item", "queue_input"]);
    expect(result).toEqual({ wrote: true, error: null, notice: null });
    expect(demo.state.queuedInputs).toMatchObject([{ sessionId: "s-atlas-store" }]);
    expect(owedItems(get(gavinTrees)[DEMO.atlas], card("session-store.md").id)).toEqual([]);
    expect(demo.state.files[`${ATLAS_PLANS}/session-store.md`]).toMatch(
      /- \[x\] Decision: Redis or Postgres for the session store\?\n {2}Options: A\) Redis B\) Postgres\n {2}Answer \(\d{4}-\d{2}-\d{2}\): Postgres/
    );
  });
});

describe("a human test", () => {
  const INVOICE = `${DEMO.atlasRoot}/services/billing/.gavin/plans/invoice-pdf.md`;

  it("is passed on its card, and the card's agent is told", async () => {
    const demo = await visit();
    const test = itemOn("invoice-pdf.md");
    const at = demo.received().length;
    const result = await answerItem(DEMO.atlas, INVOICE, test, passOutcome());
    await settle();

    const sent = sentSince(demo, at);
    expect(sent[0]).toEqual({
      cmd: "resolve_human_item",
      args: { path: INVOICE, expectedText: test.lineText, outcome: { kind: "pass" } },
    });
    expect(sent.find((s) => s.cmd === "queue_input")?.args).toMatchObject({ sessionId: "s-atlas-billing" });
    expect(result).toEqual({ wrote: true, error: null, notice: null });
    expect(get(gavinTrees)[DEMO.atlas].contexts[1].plans.find((p) => p.path === INVOICE)?.humanItems?.[0]).toMatchObject(
      { state: "passed", done: true }
    );
  });

  it("is failed with a note, and stays owed by the agent", async () => {
    const demo = await visit();
    const at = demo.received().length;
    await answerItem(DEMO.atlas, INVOICE, itemOn("invoice-pdf.md"), failOutcome("the tax line is cut off"));
    await settle();

    expect(sentSince(demo, at)[0].args.outcome).toEqual({ kind: "fail", note: "the tax line is cut off" });
    expect(owedItems(get(gavinTrees)[DEMO.atlas], INVOICE)).toMatchObject([{ state: "failed", done: false }]);
  });

  it("is closed as failed only once the human says so", async () => {
    const demo = await visit();
    const test = itemOn("invoice-pdf.md");
    let at = demo.received().length;
    expect(await asked(answerItem(DEMO.atlas, INVOICE, test, failAndCloseOutcome("wrong font")), false)).toMatchObject({
      wrote: false,
    });
    expect(actedSince(demo, at)).toEqual([]);

    at = demo.received().length;
    await asked(answerItem(DEMO.atlas, INVOICE, test, failAndCloseOutcome("wrong font")), true);
    expect(sentSince(demo, at)[0].args.outcome).toEqual({ kind: "failAndClose", note: "wrong font" });
    expect(owedItems(get(gavinTrees)[DEMO.atlas], INVOICE)).toEqual([]);
  });
});

describe("archiving a card", () => {
  it("asks before it ends the card's agent, ends it at the Workstation, and restores the card", async () => {
    const demo = await visit();
    const store = card("session-store.md");
    let at = demo.received().length;
    expect(await asked(archiveCard(DEMO.atlas, store, false), true)).toBeNull();

    expect(actedSince(demo, at)).toEqual(["archive_card", "kill_session"]);
    expect(sentSince(demo, at).find((s) => s.cmd === "kill_session")?.args).toEqual({ sessionId: "s-atlas-store" });
    const archived = card("session-store.md");
    expect(archived.id).toBe(`${ATLAS_PLANS}/archive/session-store.md`);

    at = demo.received().length;
    expect(await archiveCard(DEMO.atlas, archived, true)).toBeNull();
    await settle();
    expect(actedSince(demo, at)).toEqual(["unarchive_card"]);
    expect(card("session-store.md").id).toBe(`${ATLAS_PLANS}/session-store.md`);
  });

  it("ends nothing when it is declined", async () => {
    const demo = await visit();
    const at = demo.received().length;
    expect(await asked(archiveCard(DEMO.atlas, card("session-store.md"), false), false)).toBe("");
    expect(actedSince(demo, at)).toEqual([]);
  });

  it("takes a plan's nested tasks into the archive with it", async () => {
    const demo = await visit();
    await asked(archiveCard(DEMO.atlas, card("token-refresh.md"), false), true);
    expect(card("migrate-sessions.md").id).toBe(`${ATLAS_PLANS}/archive/migrate-sessions.md`);
    expect(demo.state.files[`${ATLAS_PLANS}/migrate-sessions.md`]).toBeUndefined();
  });
});

describe("filing a card", () => {
  it("creates it in its column, reads it as reviewed, and puts it at the column's end", async () => {
    const demo = await visit();
    const at = demo.received().length;
    const filed = await fileCard(DEMO.atlas, {
      kind: "task",
      title: "Rotate the signing key",
      body: "Roll the JWT signing key without logging anyone out.",
      status: "To Do",
      contextFolder: DEMO.atlasRoot,
    });
    await settle();

    expect(filed).toEqual({ path: `${ATLAS_PLANS}/rotate-the-signing-key.md`, warning: null });
    const sent = sentSince(demo, at);
    expect(sent[0]).toEqual({
      cmd: "create_plan",
      args: {
        contextFolder: DEMO.atlasRoot,
        fileName: "rotate-the-signing-key.md",
        title: "Rotate the signing key",
        status: "To Do",
        body: "Roll the JWT signing key without logging anyone out.",
        kind: "task",
      },
    });
    expect(sent.find((s) => s.cmd === "set_workspace_settings")?.args).toMatchObject({
      workspaceId: DEMO.atlas,
      patch: { reviewedCards: { [`${ATLAS_PLANS}/rotate-the-signing-key.md`]: expect.any(String) } },
    });
    // Placed after the column's last card, the way the composer places one.
    expect(sent.filter((s) => s.cmd === "set_plan_frontmatter_field").map((s) => s.args.key)).toContain("order");
    const toDo = mergePlanCards(get(kanbanState)[DEMO.atlas], get(gavinTrees)[DEMO.atlas]).columns[0].planCards;
    expect(toDo.at(-1)?.title).toBe("Rotate the signing key");
  });

  it("refuses a card with no title without asking the Workstation", async () => {
    const demo = await visit();
    const at = demo.received().length;
    const filed = await fileCard(DEMO.atlas, { kind: "note", title: "  ", body: "", status: "To Do", contextFolder: DEMO.atlasRoot });
    expect(filed).toEqual({ error: "Card title is empty" });
    expect(actedSince(demo, at)).toEqual([]);
  });
});

describe("running a card", () => {
  it("is the desk's launch: read first, In Progress, an agent started, named and bound", async () => {
    const demo = await visit();
    const task = card("flaky-expiry-test.md");
    const at = demo.received().length;
    const running = launch(DEMO.atlas, task, "run");
    // A card nobody has read is shown before its first run, as at the desk.
    await settle();
    expect(get(dialogRequest)?.block?.text).toContain("Inject the clock");
    expect(await asked(running, true)).toBeNull();

    expect(wroteSince(demo, at)).toEqual([
      "set_workspace_settings",
      "set_plan_frontmatter_field",
      "create_session",
      "set_session_name",
      "link_card_session",
    ]);
    const sent = sentSince(demo, at);
    const created = sent.find((s) => s.cmd === "create_session")!.args;
    expect(created).toMatchObject({ cwd: DEMO.atlasRoot, workspaceRoot: DEMO.atlasRoot, profileId: "claude-code" });
    expect(String(created.command)).toContain(`${ATLAS_PLANS}/flaky-expiry-test.md`);

    const binding = get(kanbanState)[DEMO.atlas].cardSessions.find((cs) => cs.path === task.id)!;
    expect(sent.find((s) => s.cmd === "link_card_session")?.args).toMatchObject({
      workspaceId: DEMO.atlas,
      path: task.id,
      sessionId: binding.sessionId,
    });
    expect(card("flaky-expiry-test.md").status).toBe("In Progress");
    // The desk placed it, as a tab on the workspace's Agents page; this
    // Device only noted that it started it, and its copy of the desk's
    // layout is the desk's, not one it arranged itself.
    const atlas = get(layoutState).workspaces.find((w) => w.id === DEMO.atlas)!;
    expect(allSessionIds(atlas.pages.find((p) => p.name === "Agents")!.layout)).toEqual([binding.sessionId]);
    expect(get(layoutState).workspaces).toEqual(demo.state.workspaces.workspaces);
    expect(get(startedHere)).toEqual({ [binding.sessionId]: DEMO.atlas });
    expect(cardSessionState(get(layoutState), binding)).toBe("live");
  });

  it("writes nothing when the human would rather not have the card run", async () => {
    const demo = await visit();
    const at = demo.received().length;
    expect(await asked(launch(DEMO.atlas, card("flaky-expiry-test.md"), "run"), false)).toBeNull();
    expect(wroteSince(demo, at)).toEqual([]);
  });

  it("opens the terminal of a card's live agent instead of starting a second", async () => {
    const demo = await visit();
    const at = demo.received().length;
    expect(await launch(DEMO.atlas, card("session-store.md"), "run")).toBeNull();
    expect(actedSince(demo, at)).not.toContain("create_session");
    expect(get(view)).toMatchObject({ workspaceId: DEMO.atlas, sessionId: "s-atlas-store" });
  });

  it("runs again what it ran before, once its session is gone", async () => {
    const demo = await visit();
    await asked(launch(DEMO.atlas, card("flaky-expiry-test.md"), "run"), true);
    const first = demo.received().flatMap((m) => (m.type === "invoke" && m.cmd === "create_session" ? [m.args] : []))[0];
    const bound = get(kanbanState)[DEMO.atlas].cardSessions.find((cs) => cs.path.endsWith("/flaky-expiry-test.md"))!;
    await endSession(bound.sessionId);
    await settle();
    expect(cardSessionState(get(layoutState), bound)).toBe("exited");

    const at = demo.received().length;
    expect(await launch(DEMO.atlas, card("flaky-expiry-test.md"), "relaunch")).toBeNull();
    await settle();
    const sent = sentSince(demo, at);
    expect(sent.find((s) => s.cmd === "card_session")?.args).toEqual({ workspaceId: DEMO.atlas, path: bound.path });
    expect(sent.find((s) => s.cmd === "create_session")?.args.command).toBe(first.command);
    const rebound = get(kanbanState)[DEMO.atlas].cardSessions.find((cs) => cs.path === bound.path)!;
    expect(rebound.sessionId).not.toBe(bound.sessionId);
  });
});

describe("reading a file", () => {
  it("reads the workspace's PRD, watched while it is open", async () => {
    const demo = await visit();
    const path = prdPathOf(DEMO.atlasRoot, get(gavinTrees)[DEMO.atlas])!;
    const read: (string | null)[] = [];
    const at = demo.received().length;
    const reading = followFile(path, (content) => read.push(content));
    await settle();

    expect(path).toBe(`${DEMO.atlasRoot}/.gavin-root/PRD.md`);
    expect(read).toHaveLength(1);
    expect(read[0]).toMatch(/^# atlas-api/);
    reading.stop();
    await settle();
    expect(sentSince(demo, at).map((s) => s.cmd)).toEqual([
      "read_file_for_viewer",
      "watch_file_for_viewer",
      "unwatch_file_for_viewer",
    ]);
    expect(demo.state.watches.files).toEqual({});
  });

  it("reads a card again when it changes at the Workstation", async () => {
    const demo = await visit();
    const plan = card("token-refresh.md");
    const read: (string | null)[] = [];
    const reading = followFile(plan.id, (content) => read.push(content));
    await settle();
    // An agent ticks an item, at the desk.
    demo.advance();
    demo.advance();
    await settle();

    expect(read.length).toBeGreaterThan(1);
    expect(parseChecklist(read.at(-1)!).filter((i) => i.checked)).toHaveLength(plan.checklistDone + 1);
    reading.stop();
  });

  it("hears null for a file that is not there", async () => {
    await visit();
    const read: (string | null)[] = [];
    const reading = followFile(`${DEMO.notesRoot}/docs/none.md`, (content) => read.push(content));
    await settle();
    expect(read).toEqual([null]);
    reading.stop();
  });
});

describe("the card page", () => {
  it("opens over the board, and closes back to it, on that card", async () => {
    await visit();
    openCard(card("proration.md").id);
    expect(get(view)).toMatchObject({ workspaceId: DEMO.atlas, surface: "board", page: { kind: "card" } });
    expect(get(returnedFrom)).toBeNull();
    closePage();
    expect(get(view).page).toBeUndefined();
    expect(get(returnedFrom)).toBe(card("proration.md").id);
    // ...until the human goes somewhere else.
    showWorkspaces();
    expect(get(returnedFrom)).toBeNull();
  });
});

describe("every card action, at the wire", () => {
  it("never saves the desk's layout", async () => {
    const demo = await visit();
    await moveCard(DEMO.atlas, card("proration.md"), "In Progress", columns());
    await renameCard(DEMO.atlas, card("proration.md"), "Prorate");
    await tickItem(card("token-refresh.md").id, parseChecklist(demo.state.files[card("token-refresh.md").id])[3]);
    await answerItem(DEMO.atlas, card("session-store.md").id, itemOn("session-store.md"), answerOutcome("Redis", ""));
    await fileCard(DEMO.atlas, { kind: "note", title: "Check the logs", body: "", status: "To Do", contextFolder: DEMO.atlasRoot });
    await asked(launch(DEMO.atlas, card("flaky-expiry-test.md"), "run"), true);
    // Nothing runs on it, so nothing is asked.
    await archiveCard(DEMO.atlas, card("login-rate-limit.md"), false);
    await settle();

    const sent = demo.commands();
    expect(sent.filter((cmd) => (LAYOUT_SAVING_COMMANDS as readonly string[]).includes(cmd))).toEqual([]);
    expect(demo.unanswered()).toEqual([]);
  });
});
