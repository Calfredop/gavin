import { describe, it, expect } from "vitest";
import type { Workspace } from "$lib/core/workspace";
import {
  WORKSPACE_LAYOUT_KEYS,
  WORKSPACE_SETTINGS_KEYS,
  isSettingsKey,
  normalizeSettingsPatch,
  patchWorkspaceSettings,
  settingsRecordOf,
  adoptSettingsRecord,
} from "$lib/workspace/workspaceSettings";

// The split between a workspace's SETTINGS (Workstation data, which a
// Companion may change) and the desk's LAYOUT (pages and tabs, which it
// never may). See docs/adr/0006-workspace-settings-apart-from-layout.md.

/// A workspace with every key present, so a test that walks the key lists
/// cannot pass by finding nothing to compare.
function everyKey(id: string, flavour: string): Workspace {
  return {
    id,
    name: `name-${flavour}`,
    pages: [
      {
        id: `page-${flavour}`,
        name: `Page ${flavour}`,
        layout: { type: "leaf", tabs: [`s-${flavour}`], activeTabIndex: 0 },
        focusedSessionId: `s-${flavour}`,
      },
    ],
    activePageId: `page-${flavour}`,
    activeView: `view-${flavour}`,
    hubView: `hub-${flavour}`,
    rootPath: `/root/${flavour}`,
    ssh: { host: `host-${flavour}` },
    mainSessionId: `main-${flavour}`,
    orchestrationAgent: { sessionId: `orch-${flavour}`, label: "Generate" },
    developingCards: [{ path: `/card-${flavour}.md`, sessionId: `dev-${flavour}` }],
    color: `#${flavour}${flavour}${flavour}`,
    notifyNeedsInput: false,
    notifyFinished: false,
    confirmTabClose: false,
    terminalFontSize: flavour === "a" ? 14 : 16,
    autoCommit: flavour === "a",
    homeAgentShare: flavour === "a" ? 0.3 : 0.6,
    autoResumeRuns: flavour === "a",
    gitView: { navWidth: flavour === "a" ? 100 : 200 },
    lastActiveAt: flavour === "a" ? 1 : 2,
    agentPause: {
      enabled: true,
      periodMinutes: 300,
      pauseMinutes: 10,
      anchorMs: flavour === "a" ? 1 : 2,
      limitPercent: 95,
      limitEnabled: true,
    },
    agentFallback: [`fb-${flavour}`],
    armedAgents: [`armed-${flavour}`],
    declinedAgents: [`declined-${flavour}`],
    pinnedAt: flavour === "a" ? 10 : 20,
    complexityAgents: { complex: { profile: `p-${flavour}`, model: `m-${flavour}` } },
    gitTrackingAsked: flavour === "a",
    trustedConfigHash: `hash-${flavour}`,
    mcpForeignServersChoice: { hash: `mcp-${flavour}`, action: "keep" },
    reviewedCards: { [`/card-${flavour}.md`]: `digest-${flavour}` },
    requireReview: flavour === "a",
    requireReviewAsked: flavour === "a",
    headroom: flavour === "a",
    headroomAsked: flavour === "a",
    customResumeArgs: `--resume-${flavour}`,
    actionPromptOverrides: { "action:run-task": `prompt-${flavour}` },
  };
}

describe("the key partition", () => {
  it("classifies every key of a workspace as exactly one of id, layout or settings", () => {
    const keys = Object.keys(everyKey("ws", "a")).sort();
    const classified = ["id", ...WORKSPACE_LAYOUT_KEYS, ...WORKSPACE_SETTINGS_KEYS].sort();
    expect(classified).toEqual(keys);
    expect(new Set(classified).size).toBe(classified.length);
  });

  it("puts pages and tabs on the layout side and the Settings tab's switches on the other", () => {
    expect(WORKSPACE_LAYOUT_KEYS).toContain("pages");
    expect(WORKSPACE_LAYOUT_KEYS).toContain("activePageId");
    for (const key of ["autoCommit", "requireReview", "gitTrackingAsked", "rootPath", "name"] as const) {
      expect(WORKSPACE_SETTINGS_KEYS).toContain(key);
    }
  });

  it("answers isSettingsKey for settings only", () => {
    expect(isSettingsKey("autoCommit")).toBe(true);
    expect(isSettingsKey("pages")).toBe(false);
    expect(isSettingsKey("id")).toBe(false);
    expect(isSettingsKey("nonsense")).toBe(false);
  });
});

describe("normalizeSettingsPatch", () => {
  it("turns an undefined value into null, so the clear survives the wire", () => {
    // JSON.stringify drops an undefined key, so `{ autoCommit: undefined }`
    // would reach the host as `{}` -- a patch that changes nothing.
    const wire = normalizeSettingsPatch({ autoCommit: undefined, color: "#123456" });
    expect(wire).toEqual({ autoCommit: null, color: "#123456" });
    expect(JSON.parse(JSON.stringify(wire))).toEqual({ autoCommit: null, color: "#123456" });
  });
});

describe("patchWorkspaceSettings", () => {
  it("sets the named keys on the named workspace and leaves everything else alone", () => {
    const a = everyKey("ws-a", "a");
    const b = everyKey("ws-b", "b");
    const next = patchWorkspaceSettings([a, b], "ws-a", { autoCommit: false, color: "#abcdef" });
    expect(next[0]).toEqual({ ...a, autoCommit: false, color: "#abcdef" });
    expect(next[1]).toBe(b);
  });

  it("removes a key patched with null, which is what inherit means", () => {
    const a = everyKey("ws-a", "a");
    const next = patchWorkspaceSettings([a], "ws-a", { agentPause: null, requireReview: null });
    expect("agentPause" in next[0]).toBe(false);
    expect("requireReview" in next[0]).toBe(false);
    expect(next[0].pages).toBe(a.pages);
  });

  it("returns the same array for a workspace it does not know", () => {
    const workspaces = [everyKey("ws-a", "a")];
    expect(patchWorkspaceSettings(workspaces, "ws-z", { autoCommit: true })).toBe(workspaces);
  });

  it("never touches a layout key, even one smuggled into the patch", () => {
    const a = everyKey("ws-a", "a");
    const smuggled = { autoCommit: false, pages: [] } as unknown as Parameters<typeof patchWorkspaceSettings>[2];
    const next = patchWorkspaceSettings([a], "ws-a", smuggled);
    expect(next[0].pages).toBe(a.pages);
    expect(next[0].autoCommit).toBe(false);
  });
});

describe("settingsRecordOf", () => {
  it("carries the id and every settings key the workspace has, and no layout", () => {
    const record = settingsRecordOf(everyKey("ws-a", "a"));
    expect(Object.keys(record).sort()).toEqual(["id", ...WORKSPACE_SETTINGS_KEYS].sort());
    expect(record.id).toBe("ws-a");
  });

  it("leaves out a settings key the workspace does not have", () => {
    const ws: Workspace = { id: "ws", name: "W", pages: [], activePageId: null };
    expect(settingsRecordOf(ws)).toEqual({ id: "ws", name: "W" });
  });
});

describe("adoptSettingsRecord", () => {
  it("takes another writer's settings and keeps this window's layout", () => {
    const mine = everyKey("ws-a", "a");
    const theirs = everyKey("ws-a", "b");
    const [adopted] = adoptSettingsRecord([mine], settingsRecordOf(theirs));
    for (const key of WORKSPACE_SETTINGS_KEYS) expect(adopted[key]).toEqual(theirs[key]);
    for (const key of WORKSPACE_LAYOUT_KEYS) expect(adopted[key]).toEqual(mine[key]);
  });

  it("drops a setting the record no longer carries", () => {
    const mine = everyKey("ws-a", "a");
    const [adopted] = adoptSettingsRecord([mine], { id: "ws-a", name: "Renamed" });
    expect(adopted.name).toBe("Renamed");
    expect("autoCommit" in adopted).toBe(false);
    expect(adopted.pages).toBe(mine.pages);
  });

  it("ignores layout a record should never have carried", () => {
    const mine = everyKey("ws-a", "a");
    const record = { ...settingsRecordOf(mine), pages: [] } as unknown as Parameters<typeof adoptSettingsRecord>[1];
    const [adopted] = adoptSettingsRecord([mine], record);
    expect(adopted.pages).toBe(mine.pages);
  });

  it("returns the same array for a workspace this window does not hold", () => {
    const workspaces = [everyKey("ws-a", "a")];
    expect(adoptSettingsRecord(workspaces, { id: "ws-z", name: "Z" })).toBe(workspaces);
  });
});
