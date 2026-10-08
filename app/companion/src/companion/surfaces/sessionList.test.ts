// A workspace's sessions as the phone lists them.
import { describe, expect, it } from "vitest";
import type { Workspace } from "$lib/core/workspace";
import { DEMO, sampleState } from "$companion/demo/sampleData";
import {
  DESK_PLACES_WITHIN_MS,
  detailOf,
  sessionGroups,
  workspaceSessionIds,
  type SessionListInput,
} from "$companion/surfaces/sessionList";
import { agentIndicator } from "$lib/ui/indicators";
import { allSessionIds } from "$lib/panes/layout";

const NO_TABS = { fileTabsById: {}, boardTabsById: {}, cardTabsById: {} };

function atlas(): Workspace {
  return sampleState().workspaces.workspaces.find((w) => w.id === DEMO.atlas)!;
}

function input(workspace: Workspace, over: Partial<SessionListInput> = {}): SessionListInput {
  const state = sampleState();
  return {
    workspace,
    tabs: NO_TABS,
    statusById: Object.fromEntries(state.sessions.map((s) => [s.id, s.status])) as SessionListInput["statusById"],
    sessionNames: state.sessionNames,
    cwdBySessionId: Object.fromEntries(state.sessions.map((s) => [s.id, s.cwd])),
    failureReasonById: {},
    interruptedSessionIds: new Set(),
    startedHere: [],
    ...over,
  };
}

describe("a workspace's sessions", () => {
  it("are its own agent, then each page's terminals in tab order", () => {
    const groups = sessionGroups(input(atlas()));
    expect(groups.map((g) => [g.title, g.rows.map((r) => r.id)])).toEqual([
      ["Workspace agent", ["s-atlas-main"]],
      ["auth", ["s-atlas-auth", "s-atlas-store"]],
      ["billing", ["s-atlas-billing"]],
    ]);
  });

  it("go by the names the desk's tabs have, and say what each agent is doing in the badge's words", () => {
    const [, auth] = sessionGroups(input(atlas()));
    expect(auth.rows.map((r) => [r.name, r.said])).toEqual([
      ["token refresh", "working"],
      ["session store", "waiting for you"],
    ]);
    expect(auth.rows[1].badge).toEqual(agentIndicator("waiting_for_input"));
  });

  it("name an unnamed session by its folder, and do not say the folder twice", () => {
    const scratch = sampleState().workspaces.workspaces.find((w) => w.id === DEMO.scratch)!;
    const [page] = sessionGroups(input(scratch));
    expect(page.rows[0]).toMatchObject({ name: "demo", folder: null });
    const [, auth] = sessionGroups(input(atlas()));
    expect(auth.rows[0].folder).toBe("atlas-api");
  });

  it("say why an agent stopped, and that one was interrupted", () => {
    const [, auth] = sessionGroups(
      input(atlas(), {
        statusById: { "s-atlas-auth": "failed", "s-atlas-store": "idle" },
        failureReasonById: { "s-atlas-auth": "API Error: Connection dropped" },
        interruptedSessionIds: new Set(["s-atlas-store"]),
      })
    );
    expect(auth.rows.map((r) => r.said)).toEqual([
      "stopped — API Error: Connection dropped",
      "interrupted — the daemon restarted and this run was not resumed",
    ]);
  });

  it("leave out a page's files, boards and cards, and a page with nothing else", () => {
    const ws = atlas();
    const billing = ws.pages.find((p) => p.name === "billing")!;
    const groups = sessionGroups(
      input(ws, { tabs: { ...NO_TABS, fileTabsById: { [billing.focusedSessionId!]: { path: "/x.md" } as never } } })
    );
    expect(groups.map((g) => g.title)).toEqual(["Workspace agent", "auth"]);
  });

  it("add the ones this phone started that no page holds yet, and nothing twice", () => {
    const groups = sessionGroups(input(atlas(), { startedHere: ["s-demo-1", "s-atlas-auth"] }));
    expect(groups.at(-1)).toMatchObject({ title: "Started from this phone", rows: [{ id: "s-demo-1" }] });
    expect(groups.flatMap((g) => g.rows.map((r) => r.id)).filter((id) => id === "s-atlas-auth")).toHaveLength(1);
  });

  // The desk places a start within moments when it is listening; past
  // that, the phone says it has not instead of promising a tab.
  it("say the desk has not placed what this phone started once it has had its time", () => {
    const at = 1_000_000;
    const started = (now: number) =>
      sessionGroups(input(atlas(), { startedHere: ["s-demo-1"], startedAt: { "s-demo-1": at }, now })).at(-1)!;
    expect(started(at + 1000)).toMatchObject({ key: "started-here", placingUntil: at + DESK_PLACES_WITHIN_MS });
    expect(started(at + 1000).unplaced).toBeUndefined();
    expect(started(at + DESK_PLACES_WITHIN_MS)).toMatchObject({ unplaced: true });
    expect(started(at + DESK_PLACES_WITHIN_MS).placingUntil).toBeUndefined();
    // Placed, it is not this phone's to list at all.
    const placed = sessionGroups(
      input(atlas(), { startedHere: ["s-atlas-auth"], startedAt: { "s-atlas-auth": at }, now: at + 60_000 })
    );
    expect(placed.some((g) => g.key === "started-here")).toBe(false);
  });

  it("offer to start the workspace agent where there is a folder and no agent", () => {
    const groups = sessionGroups(input({ ...atlas(), mainSessionId: undefined }));
    expect(groups[0]).toEqual({ key: "main", title: "Workspace agent", rows: [], startAgent: true });
  });

  it("offer no workspace agent to a workspace with no folder", () => {
    const scratch = sampleState().workspaces.workspaces.find((w) => w.id === DEMO.scratch)!;
    expect(sessionGroups(input(scratch)).some((g) => g.key === "main")).toBe(false);
  });

  // Started from the phone, not yet recorded by the desk: it is the agent
  // already, so a second press cannot start another.
  it("show the workspace agent this phone started until the desk records it", () => {
    const groups = sessionGroups(
      input({ ...atlas(), mainSessionId: undefined }, { startedHere: ["s-demo-1"], agentStartedHere: "s-demo-1" })
    );
    expect(groups[0]).toMatchObject({ title: "Workspace agent", rows: [{ id: "s-demo-1" }] });
    expect(groups[0].startAgent).toBeUndefined();
    expect(groups.some((g) => g.key === "started-here")).toBe(false);
  });

  // The desk had one already and placed this phone's as a tab.
  it("list a workspace agent the desk placed on a page under that page, beside the desk's own", () => {
    const ws = atlas();
    const auth = ws.pages.find((p) => p.name === "auth")!;
    const groups = sessionGroups(input(ws, { agentStartedHere: allSessionIds(auth.layout)[0] }));
    expect(groups[0]).toMatchObject({ title: "Workspace agent", rows: [{ id: "s-atlas-main" }] });
  });

  it("offer no start where the agent sits on a page", () => {
    const ws = atlas();
    const groups = sessionGroups(input({ ...ws, mainSessionId: "s-atlas-auth" }));
    expect(groups.some((g) => g.key === "main")).toBe(false);
  });

  it("are every id the list can show, for a view to check a terminal against", () => {
    expect(workspaceSessionIds(atlas(), NO_TABS).sort()).toEqual(
      ["s-atlas-auth", "s-atlas-billing", "s-atlas-main", "s-atlas-store"].sort()
    );
  });

  it("take a badge's words without its axis", () => {
    expect(detailOf(agentIndicator("working"))).toBe("working");
  });
});
