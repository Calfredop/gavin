import { describe, it, expect } from "vitest";
import {
  TYPING_FRESH_MS,
  deviceNameBySession,
  placeDeviceSession,
  presenceLine,
  presencesFromList,
  sessionsToPlace,
  typingBySession,
  typingChangesAt,
  typingText,
  workspaceForStarted,
  type PresenceNaming,
} from "$lib/core/devicePresence";
import { AGENTS_PAGE_NAME, type Page, type Workspace, type WorkspacesData } from "$lib/core/workspace";
import type { LayoutNode } from "$lib/panes/layout";
import type { DeviceInfo, DevicePresence, DeviceStartedSession } from "$lib/core/remoteAccess";

const NOW_S = 1_770_000_000;
const NOW = NOW_S * 1000;

const dev = (id: string, name: string, presence?: DevicePresence): DeviceInfo => ({
  deviceId: id,
  name,
  role: "remote",
  createdAt: NOW_S - 86_400,
  lastSeenAt: NOW_S - 60,
  revokedAt: null,
  stale: false,
  ...(presence ? { presence } : {}),
});

const started = (sessionId: string, over: Partial<DeviceStartedSession> = {}): DeviceStartedSession => ({
  sessionId,
  at: NOW_S,
  ...over,
});

const leaf = (tabs: string[], activeTabIndex = 0): LayoutNode => ({ type: "leaf", tabs, activeTabIndex });
const page = (id: string, name: string, tabs: string[]): Page => ({
  id,
  name,
  layout: leaf(tabs),
  focusedSessionId: null,
});
const ws = (id: string, pages: Page[], rootPath?: string): Workspace => ({
  id,
  name: id,
  pages,
  activePageId: pages[0]?.id ?? null,
  ...(rootPath ? { rootPath } : {}),
});
const data = (...workspaces: Workspace[]): WorkspacesData => ({ workspaces, activeWorkspaceId: workspaces[0]?.id ?? null });

describe("which started sessions a push places", () => {
  it("places a session the window has not handled", () => {
    const p: DevicePresence = { started: [started("s1")] };
    expect(sessionsToPlace(p, new Set(), NOW_S - 5).map((s) => s.sessionId)).toEqual(["s1"]);
  });

  it("does not place one twice", () => {
    const p: DevicePresence = { started: [started("s1"), started("s2")] };
    expect(sessionsToPlace(p, new Set(["s1"]), NOW_S - 5).map((s) => s.sessionId)).toEqual(["s2"]);
  });

  // A reload: the first push lists what the Device started before this
  // window existed, and the human may have closed those tabs since.
  it("leaves a session started before the window began listening alone", () => {
    const p: DevicePresence = { started: [started("old", { at: NOW_S - 600 }), started("new")] };
    expect(sessionsToPlace(p, new Set(), NOW_S - 5).map((s) => s.sessionId)).toEqual(["new"]);
  });

  it("places nothing for typing or a workspace", () => {
    const p: DevicePresence = { workspaceId: "w1", typing: { sessionId: "s9", at: NOW_S }, started: [] };
    expect(sessionsToPlace(p, new Set(), 0)).toEqual([]);
  });
});

describe("which workspace a Device-started session belongs in", () => {
  const workspaces = [
    { id: "app", rootPath: "/work/app" },
    { id: "nested", rootPath: "/work/app/packages/ui/" },
    { id: "loose" },
  ];

  it("is the one whose root the Device named", () => {
    expect(workspaceForStarted(workspaces, { workspaceRoot: "/work/app/", cwd: "/elsewhere" })).toBe("app");
  });

  it("falls back to the deepest root its cwd is under", () => {
    expect(workspaceForStarted(workspaces, { cwd: "/work/app/src" })).toBe("app");
    expect(workspaceForStarted(workspaces, { cwd: "/work/app/packages/ui/lib" })).toBe("nested");
    expect(workspaceForStarted(workspaces, { cwd: "/work/app" })).toBe("app");
  });

  it("is none for a path under no workspace, or a sibling that shares a prefix", () => {
    expect(workspaceForStarted(workspaces, { cwd: "/work/application" })).toBeNull();
    expect(workspaceForStarted(workspaces, { workspaceRoot: "/nowhere" })).toBeNull();
    expect(workspaceForStarted(workspaces, {})).toBeNull();
  });
});

describe("placing a Device-started session as a tab", () => {
  it("adds it to the workspace's Agents page, keeping the active page", () => {
    const before = data(ws("w1", [page("p1", "Main", ["a"]), page("p2", AGENTS_PAGE_NAME, ["agent-1"])]));
    const after = placeDeviceSession(before, "w1", "phone-1", "new-page")!;
    expect(after.workspaces[0].pages[1].layout).toEqual(leaf(["agent-1", "phone-1"], 1));
    expect(after.workspaces[0].activePageId).toBe("p1");
  });

  it("creates the Agents page when there is none, keeping the active page", () => {
    const before = data(ws("w1", [page("p1", "Main", ["a"])]));
    const after = placeDeviceSession(before, "w1", "phone-1", "new-page")!;
    const agents = after.workspaces[0].pages.find((p) => p.name === AGENTS_PAGE_NAME);
    expect(agents?.id).toBe("new-page");
    expect(agents?.layout).toEqual(leaf(["phone-1"]));
    expect(after.workspaces[0].activePageId).toBe("p1");
  });

  it("does nothing for a session already showing anywhere", () => {
    const before = data(ws("w1", [page("p1", "Main", ["a"])]), ws("w2", [page("p9", "Main", ["phone-1"])]));
    expect(placeDeviceSession(before, "w1", "phone-1", "new-page")).toBeNull();
  });

  it("does nothing for a workspace this desk does not hold", () => {
    expect(placeDeviceSession(data(ws("w1", [page("p1", "Main", ["a"])])), "gone", "phone-1", "x")).toBeNull();
  });

  it("makes one the Device started as the workspace agent that agent, on no page", () => {
    const before = data(ws("w1", [page("p1", "Main", ["a"])], "/work"));
    const after = placeDeviceSession(before, "w1", "phone-1", "new-page", true)!;
    expect(after.workspaces[0].mainSessionId).toBe("phone-1");
    expect(after.workspaces[0].pages).toEqual(before.workspaces[0].pages);
  });

  // Two phones racing, or the desk's own Start landing first: the agent
  // already there stays, and the late one is a tab rather than lost.
  it("places a workspace agent as a tab when the workspace already has one", () => {
    const before = data({ ...ws("w1", [page("p1", "Main", ["a"])], "/work"), mainSessionId: "desk-main" });
    const after = placeDeviceSession(before, "w1", "phone-1", "new-page", true)!;
    expect(after.workspaces[0].mainSessionId).toBe("desk-main");
    expect(after.workspaces[0].pages.find((p) => p.name === AGENTS_PAGE_NAME)?.layout).toEqual(leaf(["phone-1"]));
  });

  // The desk's Start needs a folder too: the Home agent works in the root.
  it("places a workspace agent as a tab in a workspace with no folder", () => {
    const after = placeDeviceSession(data(ws("w1", [page("p1", "Main", ["a"])])), "w1", "phone-1", "new-page", true)!;
    expect(after.workspaces[0].mainSessionId).toBeUndefined();
    expect(after.workspaces[0].pages).toHaveLength(2);
  });

  it("leaves the workspace agent where it is when a push names it again", () => {
    const before = data({ ...ws("w1", [page("p1", "Main", ["a"])], "/work"), mainSessionId: "phone-1" });
    expect(placeDeviceSession(before, "w1", "phone-1", "new-page", true)).toBeNull();
  });

  // The desk's own launches never pass through here, so the only way one
  // could be touched is by being named in a Device's presence.
  it("leaves every session the desk launched itself where it was", () => {
    const before = data(ws("w1", [page("p1", "Main", ["desk-1"]), page("p2", AGENTS_PAGE_NAME, ["desk-2"])], "/work"));
    const p: DevicePresence = { started: [started("phone-1", { workspaceRoot: "/work" })] };
    let after = before;
    for (const s of sessionsToPlace(p, new Set(), NOW_S - 5)) {
      after = placeDeviceSession(after, workspaceForStarted(after.workspaces, s)!, s.sessionId, "x") ?? after;
    }
    expect(after.workspaces[0].pages[0]).toEqual(before.workspaces[0].pages[0]);
    expect(after.workspaces[0].pages[1].layout).toEqual(leaf(["desk-2", "phone-1"], 1));
    expect(deviceNameBySession([dev("d1", "Pixel", p)], { d1: p })).toEqual({ "phone-1": "Pixel" });
  });
});

describe("the tab label and the typing marker", () => {
  const phone: DevicePresence = {
    workspaceId: "w1",
    typing: { sessionId: "desk-1", at: NOW_S - 1 },
    started: [started("phone-1")],
  };
  const tablet: DevicePresence = { typing: { sessionId: "desk-1", at: NOW_S - 2 }, started: [] };
  const devices = [dev("d1", "Pixel", phone), dev("d2", "iPad", tablet), dev("d3", "Idle")];

  it("names each session a Device started after that Device", () => {
    expect(deviceNameBySession(devices, presencesFromList(devices))).toEqual({ "phone-1": "Pixel" });
  });

  it("marks a session while a Device's last keystroke is fresh", () => {
    expect(typingBySession(devices, presencesFromList(devices), NOW)).toEqual({ "desk-1": ["Pixel", "iPad"] });
    expect(typingText(["Pixel"])).toBe("Pixel is typing");
    expect(typingText(["Pixel", "iPad"])).toBe("Pixel and iPad are typing");
  });

  it("takes the marker down once the keystrokes stop", () => {
    const later = NOW + TYPING_FRESH_MS;
    expect(typingBySession(devices, presencesFromList(devices), later)).toEqual({});
  });

  it("says when the markers next change on their own", () => {
    expect(typingChangesAt(presencesFromList(devices), NOW)).toBe((NOW_S - 1) * 1000 + TYPING_FRESH_MS);
    expect(typingChangesAt(presencesFromList(devices), NOW + TYPING_FRESH_MS)).toBeNull();
    expect(typingChangesAt({}, NOW)).toBeNull();
  });
});

describe("the Devices panel's presence line", () => {
  const naming: PresenceNaming = {
    workspaceName: (id) => (id === "w1" ? "gavin" : null),
    sessionName: (id) => `name of ${id}`,
  };

  it("says where a connected Device is, what it is typing into and what it started", () => {
    const p: DevicePresence = {
      workspaceId: "w1",
      typing: { sessionId: "s1", at: NOW_S },
      started: [started("a"), started("b"), started("c")],
    };
    expect(presenceLine(p, true, naming, NOW)).toBe(
      "in gavin · typing into name of s1 · started name of c, name of b +1"
    );
  });

  it("keeps only what the Device started once it has gone", () => {
    const p: DevicePresence = { workspaceId: "w1", typing: { sessionId: "s1", at: NOW_S }, started: [started("a")] };
    expect(presenceLine(p, false, naming, NOW)).toBe("started name of a");
  });

  it("says nothing of a workspace the desk does not hold, or typing gone quiet", () => {
    const p: DevicePresence = { workspaceId: "gone", typing: { sessionId: "s1", at: NOW_S - 60 }, started: [] };
    expect(presenceLine(p, true, naming, NOW)).toBeNull();
    expect(presenceLine(undefined, true, naming, NOW)).toBeNull();
  });
});
