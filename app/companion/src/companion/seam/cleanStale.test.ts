// "Clean stale decisions" and "Clean stale tests" from the phone, read at
// the wire against the Demo Workstation. The desk's own request: the
// same confirm before anything starts, and the same prompt over the same
// cards. What the desk's launch would do to the DESK -- queue it, place
// it as a tab, jump the window -- is the phone's instead: the run's
// terminal opens here, and the phone only notes that it started it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { answerDialog, dialogRequest } from "$lib/core/dialog";
import { kanbanState } from "$lib/board/kanbanState";
import { gavinTrees } from "$lib/core/gavinState";
import type { CleanKind } from "$lib/decisions/cleanStale";
import type { BundleMessage } from "$companion/channel/messages";
import { loopback } from "$companion/channel/port";
import { DEMO } from "$companion/demo/sampleData";
import { createDemoWorkstation, type DemoWorkstation } from "$companion/demo/workstation";
import { disconnectChannel } from "$companion/remote/connection";
import { cleanStale } from "$companion/state/decisions";
import { startedHere } from "$companion/state/sessions";
import { connectWorkstation, openWorkspace, showSurface, view } from "$companion/state/workstation";
import { phoneItems } from "$companion/surfaces/phoneItems";
import { settle } from "$companion/testing/demoBench";
import { deviceStorage, resetDesktopStores } from "$companion/testing/desktopStores";

let disconnect: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  disconnect?.();
  disconnect = null;
  disconnectChannel();
  resetDesktopStores();
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function visit(surface: "decisions" | "review"): Promise<DemoWorkstation> {
  const demo = createDemoWorkstation();
  disconnect = await connectWorkstation(loopback(demo), deviceStorage());
  await settle();
  openWorkspace(DEMO.atlas);
  showSurface(surface);
  await settle();
  return demo;
}

/// The list as the surface reads it, from what the phone holds now.
function list(kind: CleanKind, root = true) {
  return phoneItems(kind, {
    workspaceId: DEMO.atlas,
    tree: get(gavinTrees)[DEMO.atlas],
    board: get(kanbanState)[DEMO.atlas],
    hasRoot: root,
    itemsBlockedReason: null,
  });
}

function sentSince(demo: DemoWorkstation, from: number): { cmd: string; args: Record<string, unknown> }[] {
  return demo
    .received()
    .slice(from)
    .flatMap((m: BundleMessage) => (m.type === "invoke" ? [{ cmd: m.cmd, args: m.args }] : []))
    .filter((s) => !s.cmd.startsWith("get_"));
}

/// Answers the confirm the press put up, and lets the launch finish.
async function confirm(yes: boolean): Promise<void> {
  await settle();
  const request = get(dialogRequest);
  if (!request) throw new Error("no dialog is up");
  answerDialog(request.id, yes, false);
  await settle();
}

describe("cleaning stale items from the phone", () => {
  it("asks first, then starts an agent in the root over the open decisions, shown here", async () => {
    const demo = await visit("decisions");
    const at = demo.received().length;
    const pressed = cleanStale(DEMO.atlas, "decisions", list("decisions"));
    await settle();
    expect(get(dialogRequest)?.title).toBe("Clean stale decisions?");
    expect(sentSince(demo, at).map((s) => s.cmd)).not.toContain("create_session");

    await confirm(true);
    expect(await pressed).toBeNull();
    const created = sentSince(demo, at).find((s) => s.cmd === "create_session")!;
    expect(created.args).toMatchObject({ cwd: DEMO.atlasRoot, workspaceRoot: DEMO.atlasRoot });
    expect(String(created.args.command)).toContain("Decision: Redis or Postgres for the session store?");

    const sessionId = get(view).sessionId;
    expect(sessionId).not.toBeNull();
    expect(get(view)).toMatchObject({ workspaceId: DEMO.atlas, sessionId });
    expect(get(startedHere)).toEqual({ [sessionId!]: DEMO.atlas });
  });

  it("hands Review's clean the human tests, not the decisions", async () => {
    const demo = await visit("review");
    const at = demo.received().length;
    const pressed = cleanStale(DEMO.atlas, "tests", list("tests"));
    await settle();
    expect(get(dialogRequest)?.title).toBe("Clean stale tests?");
    await confirm(true);
    expect(await pressed).toBeNull();
    const command = String(sentSince(demo, at).find((s) => s.cmd === "create_session")!.args.command);
    expect(command).toContain("Human test: Open a sample invoice PDF on a phone");
    expect(command).not.toContain("Decision: Redis or Postgres");
  });

  it("starts nothing when the human says not now", async () => {
    const demo = await visit("decisions");
    const at = demo.received().length;
    const pressed = cleanStale(DEMO.atlas, "decisions", list("decisions"));
    await confirm(false);
    expect(await pressed).toBeNull();
    expect(sentSince(demo, at).map((s) => s.cmd)).not.toContain("create_session");
    expect(get(view).sessionId).toBeNull();
  });

  it("says why it cannot start, and asks the Workstation nothing", async () => {
    const demo = await visit("review");
    const at = demo.received().length;
    expect(await cleanStale(DEMO.atlas, "tests", list("tests", false))).toMatch(/no root folder/);
    expect(get(dialogRequest)).toBeNull();
    expect(sentSince(demo, at)).toEqual([]);
  });
});
