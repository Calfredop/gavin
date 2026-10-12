// Seam 2 for the connection coming and going while a surface is open: the
// bundle's own way in (`connectWorkstation`) and the desktop's Git and
// board state on one end of the channel, the Demo Workstation playing a
// dropped connection on the other (`reach`), and the wire read between.
//
// What each surface does on the way back up is the function its template
// registers with `onReconnect` -- `recoverGit`, `recoverBoard` -- so this
// is what the phone does with nobody touching it.
import { afterEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import { boardError, kanbanState, refreshBoard } from "$lib/board/kanbanState";
import { dismissError, ensureGitView, gitStore, noteError, refresh } from "$lib/git/gitState";
import { CORE_MESSAGES, NOT_REACHABLE } from "$companion/channel/messages";
import { loopback } from "$companion/channel/port";
import { DEMO } from "$companion/demo/sampleData";
import { createDemoWorkstation, type DemoOptions, type DemoWorkstation } from "$companion/demo/workstation";
import { disconnectChannel } from "$companion/remote/connection";
import {
  isReachabilityError,
  onReconnect,
  reachability,
  reachabilityLine,
  shownError,
} from "$companion/state/reachability";
import { connectWorkstation } from "$companion/state/workstation";
import { recoverBoard } from "$companion/surfaces/phoneBoard";
import { recoverGit } from "$companion/surfaces/phoneGit";
import { settle } from "$companion/testing/demoBench";
import { deviceStorage, resetDesktopStores } from "$companion/testing/desktopStores";
import { mark, traffic } from "$companion/testing/wire";

const ROOT = DEMO.atlasRoot;
const WS = DEMO.atlas;

const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  disconnectChannel();
  gitStore.set({});
  resetDesktopStores();
});

async function visit(options?: DemoOptions): Promise<DemoWorkstation> {
  const demo = createDemoWorkstation(options);
  stops.push(await connectWorkstation(loopback(demo), deviceStorage()));
  await settle();
  return demo;
}

/// The Git surface, open: its view, its first read, and what its
/// template registers for the way back up.
async function openGit(): Promise<void> {
  ensureGitView(WS, ROOT);
  await refresh(WS);
  stops.push(onReconnect(() => void recoverGit(WS)));
}

const gitError = (): string | null => get(gitStore)[WS]?.error ?? null;

describe("the Git surface, when the connection drops and comes back", () => {
  it("says so once while it is down, then clears the banner and reads once, untouched", async () => {
    const demo = await visit();
    await openGit();

    demo.reach({ state: "down", reason: "unreachable" });
    await settle();
    expect(get(reachability)).toEqual({ state: "down", reason: "unreachable" });
    expect(reachabilityLine(get(reachability), "Studio Mac")).toBe("Can’t reach Studio Mac. Trying again…");

    // The human pulls to refresh, as the owner did: the read fails for
    // want of a connection, and the banner says nothing the line does not.
    await refresh(WS);
    expect(gitError()).toBe(`Refresh failed: ${NOT_REACHABLE}`);
    expect(shownError(gitError(), get(reachability))).toBeNull();

    const from = mark(demo);
    demo.reach({ state: "up" });
    await settle();

    expect(get(reachability)).toEqual({ state: "up" });
    expect(reachabilityLine(get(reachability), "Studio Mac")).toBeNull();
    expect(gitError()).toBeNull();
    expect(get(gitStore)[WS]?.repo?.branch).toBe("main");
    const reads = traffic(demo, from);
    expect(reads.filter((t) => t === "invoke git_repo_info")).toHaveLength(1);
    // What every screen draws from, read again too: the pushes sent
    // while it was down reached nobody.
    expect(reads.filter((t) => t === "invoke get_workspaces_state")).toHaveLength(1);
  });

  it("keeps a banner that is git's own, and still reads again", async () => {
    const demo = await visit();
    await openGit();
    noteError(WS, "Commit failed: nothing to commit");

    demo.reach({ state: "down", reason: "asleep" });
    await settle();
    expect(shownError(gitError(), get(reachability))).toBe("Commit failed: nothing to commit");

    const from = mark(demo);
    demo.reach({ state: "up" });
    await settle();
    expect(gitError()).toBe("Commit failed: nothing to commit");
    expect(traffic(demo, from)).toContain("invoke git_repo_info");
  });

  it("reads nothing once the surface has closed", async () => {
    const demo = await visit();
    await openGit();
    for (const stop of stops.splice(1)) stop();

    demo.reach({ state: "down", reason: "unreachable" });
    await settle();
    const from = mark(demo);
    demo.reach({ state: "up" });
    await settle();
    expect(traffic(demo, from)).not.toContain("invoke git_repo_info");
  });

  it("does nothing on an up it was never told was down", async () => {
    const demo = await visit();
    await openGit();
    const from = mark(demo);
    demo.reach({ state: "up" });
    await settle();
    expect(traffic(demo, from)).toEqual([]);
  });
});

describe("the board, when the connection drops and comes back", () => {
  it("loads the board it could not read, and its error goes with it", async () => {
    const demo = await visit();
    stops.push(onReconnect(() => void recoverBoard(WS)));
    demo.reach({ state: "down", reason: "desktop-app-not-running" });
    await settle();
    // A board that never loaded: the one case with an error of its own.
    kanbanState.update(({ [WS]: _gone, ...rest }) => rest);
    await refreshBoard(WS);
    expect(boardError(WS)).toContain(NOT_REACHABLE);
    expect(shownError(boardError(WS), get(reachability))).toBeNull();

    demo.reach({ state: "up" });
    await settle();
    expect(boardError(WS)).toBeNull();
    expect(get(kanbanState)[WS]).toBeDefined();
  });
});

describe("against a shell older than the bundle", () => {
  it("is never told, and shows each failure as it did", async () => {
    // The core set and nothing else: an end that does not carry
    // `connection` sends none, and the bundle carries on without it.
    const demo = await visit({ messages: CORE_MESSAGES });
    await openGit();
    demo.reach({ state: "down", reason: "unreachable" });
    await settle();
    expect(get(reachability)).toEqual({ state: "up" });

    await refresh(WS);
    // Still told apart from git's own words, by the code on the wire --
    // shown, since nothing else on the page says it.
    expect(isReachabilityError(gitError())).toBe(true);
    expect(shownError(gitError(), get(reachability))).toBe(`Refresh failed: ${NOT_REACHABLE}`);

    demo.reach({ state: "up" });
    dismissError(WS);
    await refresh(WS);
    expect(gitError()).toBeNull();
  });
});
