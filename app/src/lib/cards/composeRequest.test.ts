import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  requestedCompose,
  resolveComposeTarget,
  takeComposeRequest,
  type ComposeTarget,
} from "$lib/cards/composeRequest";
import type { Workspace } from "$lib/core/workspace";
import type { BoardTab } from "$lib/core/gavin";

function ws(over: Partial<Workspace> = {}): Workspace {
  return { id: "ws-1", name: "ws-1", pages: [], activePageId: null, ...over };
}

const boardTab = (workspaceId: string, contextFolder = "/r/.gavin-root"): BoardTab => ({
  workspaceId,
  contextFolder,
});

beforeEach(() => requestedCompose.set(null));

describe("resolveComposeTarget", () => {
  it("addresses the hub board when the Kanban hub tab is active", () => {
    expect(resolveComposeTarget(ws({ activeView: "kanban" }), "a", {})).toEqual({
      kind: "hub",
      workspaceId: "ws-1",
    });
  });

  it("addresses the focused board TAB in the terminal view", () => {
    const target = resolveComposeTarget(ws({ activeView: "terminal" }), "tab-2", {
      "tab-1": boardTab("ws-1"),
      "tab-2": boardTab("ws-1"),
    });
    expect(target).toEqual({ kind: "tab", workspaceId: "ws-1", tabId: "tab-2" });
  });

  it("uses the board tab's own workspace, not the active one", () => {
    const target = resolveComposeTarget(ws({ id: "ws-1", activeView: "terminal" }), "tab-1", {
      "tab-1": boardTab("ws-2"),
    });
    expect(target).toEqual({ kind: "tab", workspaceId: "ws-2", tabId: "tab-1" });
  });

  it("leaves the key alone when the focused tab is an ordinary terminal", () => {
    expect(resolveComposeTarget(ws({ activeView: "terminal" }), "a", {})).toBeNull();
  });

  it("leaves the key alone on another hub tab", () => {
    expect(resolveComposeTarget(ws({ activeView: "git" }), "a", { a: boardTab("ws-1") })).toBeNull();
  });

  it("leaves the key alone with no workspace at all", () => {
    expect(resolveComposeTarget(null, "a", {})).toBeNull();
  });

  it("a rooted workspace with no explicit view lands on Home, not a board", () => {
    // getActiveView's fallback: rooted workspaces open on the
    // orchestration home, so ⌘N there is nobody's.
    expect(resolveComposeTarget(ws({ rootPath: "/r" }), null, {})).toBeNull();
  });

  it("an unrooted workspace with no explicit view is a terminal", () => {
    expect(resolveComposeTarget(ws(), "tab-1", { "tab-1": boardTab("ws-1") })).toEqual({
      kind: "tab",
      workspaceId: "ws-1",
      tabId: "tab-1",
    });
  });
});

describe("takeComposeRequest", () => {
  const hub: ComposeTarget = { kind: "hub", workspaceId: "ws-1" };
  const tab: ComposeTarget = { kind: "tab", workspaceId: "ws-1", tabId: "tab-1" };

  it("the addressed board takes it and clears the store", () => {
    requestedCompose.set(hub);
    expect(takeComposeRequest(get(requestedCompose), hub)).toBe(true);
    expect(get(requestedCompose)).toBeNull();
  });

  it("another workspace's hub board leaves it standing", () => {
    requestedCompose.set(hub);
    expect(takeComposeRequest(get(requestedCompose), { kind: "hub", workspaceId: "ws-2" })).toBe(false);
    expect(get(requestedCompose)).toEqual(hub);
  });

  it("a board tab never answers a hub request, and vice versa", () => {
    requestedCompose.set(hub);
    expect(takeComposeRequest(get(requestedCompose), tab)).toBe(false);
    requestedCompose.set(tab);
    expect(takeComposeRequest(get(requestedCompose), hub)).toBe(false);
  });

  it("a second pane on the same context does not steal the focused one's request", () => {
    requestedCompose.set(tab);
    expect(takeComposeRequest(get(requestedCompose), { ...tab, tabId: "tab-2" })).toBe(false);
    expect(takeComposeRequest(get(requestedCompose), tab)).toBe(true);
  });

  it("no request is nobody's", () => {
    expect(takeComposeRequest(null, hub)).toBe(false);
  });
});
