// Seam 2 for the settings screens: the desktop's own settings loaders and
// writers (`layoutState.ts`, `agentPauseState.ts`, `launchQueue.ts`, the
// theme) on one end of the channel, the Demo Workstation on the other, and
// the wire read message by message.
//
// What is held here is what crosses: which command each setting travels
// as and with what arguments, that the Workstation holds the new value
// afterwards, that a workspace's settings move without its layout (ADR
// 0006), that a change made at the desk reaches the phone, and that a
// write that fails says so on the phone instead of in the desk's overlay.
import { afterEach, describe, expect, it } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { get } from "svelte/store";
import { DEFAULT_CYCLE, type PauseCycle } from "$lib/agents/agentPause";
import { agentPauseStore, saveAgentPauseFor } from "$lib/agents/agentPauseState";
import { launchConfigStore, saveLaunchConfig } from "$lib/agents/launchQueue";
import { EMPTY_AGENT_DEFAULTS } from "$lib/cards/complexity";
import * as backend from "$lib/core/backend";
import { gavinTrees } from "$lib/core/gavinState";
import {
  agentDefaultsStore,
  agentModelDefaultsStore,
  agentProfilesStore,
  autoCommitDefault,
  gitTrackingDefault,
  layoutState,
  renameWorkspace,
  requireReviewDefault,
  setAgentDefaults,
  setAgentField,
  setAgentModelDefault,
  setAutoCommitDefault,
  setGitTrackingDefault,
  setRequireReviewDefault,
  setTerminalFontSizeDefault,
  setWorkspaceAutoCommit,
  setWorkspaceColor,
  setWorkspaceComplexityTable,
  setWorkspaceCustomProfiles,
  setWorkspaceFallback,
  setWorkspaceFlag,
  setWorkspaceFontSize,
  setWorkspacePause,
  setWorkspacePromptParams,
  setWorkspaceRequireReview,
  terminalFontSizeDefault,
} from "$lib/core/layoutState";
import { themeState } from "$lib/ui/themeState.svelte";
import { loopback } from "$companion/channel/port";
import { DEMO } from "$companion/demo/sampleData";
import { createDemoWorkstation, type DemoWorkstation } from "$companion/demo/workstation";
import { disconnectChannel } from "$companion/remote/connection";
import { LAYOUT_SAVING_COMMANDS } from "$companion/remote/remoteRole";
import { connectWorkstation, loadSettings, saveProblem, saveSetting } from "$companion/state/workstation";
import { settle } from "$companion/testing/demoBench";
import { deviceStorage, resetDesktopStores } from "$companion/testing/desktopStores";
import { allowedToRemoteRole, tableSize } from "$companion/testing/remoteTable";
import { argsOf, mark, traffic } from "$companion/testing/wire";

let disconnect: (() => void) | null = null;

afterEach(() => {
  disconnect?.();
  disconnect = null;
  disconnectChannel();
  resetDesktopStores();
});

async function connected(demo = createDemoWorkstation()): Promise<DemoWorkstation> {
  disconnect = await connectWorkstation(loopback(demo), deviceStorage());
  await settle();
  return demo;
}

function invokes(demo: DemoWorkstation, from: number): string[] {
  return traffic(demo, from).filter((line) => line.startsWith("invoke "));
}

function atlas() {
  const ws = get(layoutState).workspaces.find((w) => w.id === DEMO.atlas);
  if (!ws) throw new Error("the bundle has no atlas-api");
  return ws;
}

function demoAtlas(demo: DemoWorkstation) {
  const ws = demo.state.workspaces.workspaces.find((w) => w.id === DEMO.atlas);
  if (!ws) throw new Error("the demo has no atlas-api");
  return ws;
}

const CYCLE: PauseCycle = { ...DEFAULT_CYCLE, enabled: true, pauseMinutes: 20, periodMinutes: 300, anchorMs: 1 };

describe("reading the settings", () => {
  it("reads every app-wide setting and the agent table through the desktop's own loaders", async () => {
    const demo = createDemoWorkstation();
    demo.state.settings.autoCommit = true;
    demo.state.settings.terminalFontSize = 15;
    demo.state.settings.agentModels = { "claude-code": "opus" };
    demo.state.settings.agentDefaults = {
      ...demo.state.settings.agentDefaults,
      pauseCycles: { "claude-code": CYCLE },
    };
    demo.state.settings.launch = { maxInFlight: 2, holdOnPressure: false, reclaimDoneSessions: true };
    await connected(demo);
    const from = mark(demo);

    await loadSettings();
    await settle();

    expect(invokes(demo, from).sort()).toEqual(
      [
        "invoke agent_model_catalog",
        "invoke agent_profiles",
        "invoke get_agent_defaults",
        "invoke get_agent_model_defaults",
        "invoke get_auto_commit",
        "invoke get_custom_resume_args",
        "invoke get_git_tracking_default",
        "invoke get_launch_config",
        "invoke get_require_review",
        "invoke get_terminal_font_size",
        "invoke get_theme_pref",
      ].sort()
    );
    expect(get(autoCommitDefault)).toBe(true);
    expect(get(terminalFontSizeDefault)).toBe(15);
    expect(get(agentModelDefaultsStore)).toEqual({ "claude-code": "opus" });
    // The cycles ride the agent defaults, per agent: no command of their own.
    expect(get(agentPauseStore)).toEqual({ "claude-code": CYCLE });
    expect(get(launchConfigStore)).toEqual({ maxInFlight: 2, holdOnPressure: false, reclaimDoneSessions: true });
    expect(get(agentProfilesStore).map((p) => [p.id, p.models])).toEqual([
      ["claude-code", ["opus", "sonnet", "haiku"]],
      // The catalogue folded in, as the desk folds it in.
      ["codex", ["gpt-5-codex", "gpt-5"]],
    ]);
  });

  it("asks for the agent table once a connection, and the settings every time a screen opens", async () => {
    const demo = await connected();
    await loadSettings();
    await settle();
    const from = mark(demo);

    await loadSettings();
    await settle();

    expect(invokes(demo, from)).not.toContain("invoke agent_profiles");
    expect(invokes(demo, from)).not.toContain("invoke agent_model_catalog");
    expect(invokes(demo, from)).toContain("invoke get_agent_defaults");
  });
});

describe("changing an app-wide setting", () => {
  const WRITES: [string, () => Promise<unknown>, string, Record<string, unknown>][] = [
    ["the theme", () => themeState.setPref("dark"), "set_theme_pref", { theme: "dark" }],
    ["the font size", () => setTerminalFontSizeDefault(15), "set_terminal_font_size", { size: 15 }],
    ["auto commit", () => setAutoCommitDefault(true), "set_auto_commit", { enabled: true }],
    ["require review", () => setRequireReviewDefault(false), "set_require_review", { enabled: false }],
    ["git tracking", () => setGitTrackingDefault(false), "set_git_tracking_default", { tracked: false }],
    [
      "an agent's model",
      () => setAgentModelDefault("claude-code", "sonnet"),
      "set_agent_model_default",
      { profileId: "claude-code", model: "sonnet" },
    ],
    [
      "the agent defaults",
      () =>
        setAgentDefaults({
          ...EMPTY_AGENT_DEFAULTS,
          customProfiles: [
            { id: "my-agent", label: "My agent", command: "my-agent", modelFlag: "--model" },
          ],
          agentEfforts: { codex: "high" },
        }),
      "set_agent_defaults",
      {
        agentDefaults: {
          ...EMPTY_AGENT_DEFAULTS,
          customProfiles: [
            { id: "my-agent", label: "My agent", command: "my-agent", modelFlag: "--model" },
          ],
          agentEfforts: { codex: "high" },
        },
      },
    ],
    [
      "an agent's pause cycle",
      () => saveAgentPauseFor("claude-code", CYCLE),
      "set_agent_defaults",
      { agentDefaults: { ...EMPTY_AGENT_DEFAULTS, pauseCycles: { "claude-code": CYCLE } } },
    ],
    [
      "the memory wall",
      () => saveLaunchConfig({ maxInFlight: null, holdOnPressure: true, reclaimDoneSessions: false }),
      "set_launch_config",
      { launch: { maxInFlight: null, holdOnPressure: true, reclaimDoneSessions: false } },
    ],
  ];

  it.each(WRITES)("sends %s as its own command, and the Workstation holds it", async (_name, write, cmd, args) => {
    const demo = await connected();
    const from = mark(demo);

    await saveSetting(write);
    await settle();

    expect(argsOf(demo, cmd, from)).toEqual([args]);
    expect(get(saveProblem)).toBeNull();
  });

  it("leaves the Workstation holding what was chosen", async () => {
    const demo = await connected();
    await saveSetting(() => setAutoCommitDefault(true));
    await saveSetting(() => setAgentModelDefault("claude-code", "sonnet"));
    await saveSetting(() => saveLaunchConfig({ maxInFlight: 6, holdOnPressure: true, reclaimDoneSessions: true }));

    expect(demo.state.settings.autoCommit).toBe(true);
    expect(demo.state.settings.agentModels).toEqual({ "claude-code": "sonnet" });
    expect(demo.state.settings.launch?.maxInFlight).toBe(6);
  });

  it("clears a setting back to gavin's default with null, and an empty model with nothing", async () => {
    const demo = createDemoWorkstation();
    demo.state.settings.terminalFontSize = 15;
    demo.state.settings.agentModels = { "claude-code": "opus" };
    await connected(demo);

    await saveSetting(() => setTerminalFontSizeDefault(null));
    await saveSetting(() => setAgentModelDefault("claude-code", ""));

    expect(demo.state.settings.terminalFontSize).toBeNull();
    expect(demo.state.settings.agentModels).toEqual({});
  });

  it("is announced to every window under the Device's origin, which no desk window has", async () => {
    const demo = await connected();
    const heard: unknown[] = [];
    const stop = await listen("app-settings-synced", (event) => void heard.push(event.payload));

    await saveSetting(() => setRequireReviewDefault(false));
    await settle();

    expect(heard).toEqual([{ origin: "companion" }]);
    stop();
    expect(demo.listening("app-settings-synced")).toBeGreaterThan(0);
  });

  it("follows a change made at the desk, once a settings screen has drawn them", async () => {
    const demo = await connected();
    await loadSettings();
    await settle();
    expect(get(requireReviewDefault)).toBeNull();

    demo.state.settings.requireReview = false;
    demo.state.settings.agentModels = { codex: "gpt-5" };
    demo.emit("app-settings-synced", { origin: "main" });
    await settle();

    expect(get(requireReviewDefault)).toBe(false);
    expect(get(agentModelDefaultsStore)).toEqual({ codex: "gpt-5" });
  });

  it("costs the phone only the theme while no settings screen has been opened", async () => {
    const demo = await connected();
    await settle();
    const from = mark(demo);

    demo.state.settings.theme = "light";
    demo.emit("app-settings-synced", { origin: "main" });
    await settle();

    // Every screen is drawn in the theme, so a change at the desk shows.
    expect(invokes(demo, from)).toEqual(["invoke get_theme_pref"]);
    expect(themeState.pref).toBe("light");
  });

  it("says on the phone when a change was not saved, and leaves the desk's error state as it was", async () => {
    const demo = await connected();
    demo.unavailable = "desktop app not running";

    await saveSetting(() => setGitTrackingDefault(false));
    expect(get(saveProblem)).toContain("desktop app not running");
    expect(get(layoutState).status).toBe("ready");

    await saveSetting(() => saveAgentPauseFor("claude-code", CYCLE));
    expect(get(saveProblem)).toContain("desktop app not running");
  });
});

describe("changing a workspace's settings", () => {
  const WRITES: [string, () => Promise<unknown>, Record<string, unknown>][] = [
    ["its name", () => renameWorkspace(DEMO.atlas, "atlas"), { name: "atlas" }],
    ["its colour", () => setWorkspaceColor(DEMO.atlas, "#f472b6"), { color: "#f472b6" }],
    ["its font size", () => setWorkspaceFontSize(DEMO.atlas, 15), { terminalFontSize: 15 }],
    ["its font size, back to the default", () => setWorkspaceFontSize(DEMO.atlas, null), { terminalFontSize: null }],
    ["auto commit", () => setWorkspaceAutoCommit(DEMO.atlas, false), { autoCommit: false }],
    ["require review", () => setWorkspaceRequireReview(DEMO.atlas, true), { requireReview: true }],
    [
      "its pause for one agent",
      () => setWorkspacePause(DEMO.atlas, "claude-code", CYCLE),
      { pauseCycles: { "claude-code": CYCLE } },
    ],
    [
      "its prompt lines for one agent",
      () => setWorkspacePromptParams(DEMO.atlas, "codex", "promptExtras", ["Be brief."]),
      { promptExtras: { codex: ["Be brief."] } },
    ],
    [
      "its CLI arguments for one agent",
      () => setWorkspacePromptParams(DEMO.atlas, "codex", "extraCliArgs", ["--flag"]),
      { extraCliArgs: { codex: ["--flag"] } },
    ],
    ["its fallback chain", () => setWorkspaceFallback(DEMO.atlas, "claude-code", ["codex"]), { fallbackChains: { "claude-code": ["codex"] } }],
    [
      "a notification",
      () => setWorkspaceFlag(DEMO.atlas, "notifyFinished", false),
      { notifyFinished: false },
    ],
    [
      "unattended recovery",
      () => setWorkspaceFlag(DEMO.atlas, "autoResumeRuns", true),
      { autoResumeRuns: true },
    ],
    [
      "its complexity table",
      () =>
        setWorkspaceComplexityTable(DEMO.atlas, "claude-code", {
          complex: { profile: "codex", model: "", effort: "high" },
        }),
      { complexityTables: { "claude-code": { complex: { profile: "codex", model: "", effort: "high" } } } },
    ],
    [
      "its local custom profiles",
      () =>
        setWorkspaceCustomProfiles(DEMO.atlas, [
          { id: "local:helper", label: "Helper", command: "helper", modelFlag: "--m" },
        ]),
      {
        customProfiles: [{ id: "local:helper", label: "Helper", command: "helper", modelFlag: "--m" }],
      },
    ],
  ];

  it.each(WRITES)("sends %s through ticket 04's command, as a patch of just that", async (_name, write, patch) => {
    const demo = await connected();
    const from = mark(demo);

    await saveSetting(write);
    await settle();

    expect(invokes(demo, from)).toEqual(["invoke set_workspace_settings"]);
    expect(argsOf(demo, "set_workspace_settings", from)).toEqual([{ workspaceId: DEMO.atlas, patch }]);
    expect(get(saveProblem)).toBeNull();
  });

  it("changes the Workstation's settings of the workspace and leaves the desk's layout of it alone", async () => {
    const demo = await connected();
    const layoutBefore = JSON.stringify({
      pages: demoAtlas(demo).pages,
      activePageId: demoAtlas(demo).activePageId,
    });

    await saveSetting(() => renameWorkspace(DEMO.atlas, "atlas"));
    await saveSetting(() => setWorkspaceColor(DEMO.atlas, "#f472b6"));
    await saveSetting(() => setWorkspaceAutoCommit(DEMO.atlas, true));
    await settle();

    expect(demoAtlas(demo)).toMatchObject({ name: "atlas", color: "#f472b6", autoCommit: true });
    expect(JSON.stringify({ pages: demoAtlas(demo).pages, activePageId: demoAtlas(demo).activePageId })).toBe(
      layoutBefore
    );
    expect(atlas()).toMatchObject({ name: "atlas", color: "#f472b6", autoCommit: true });
  });

  it("is refused whole, as the host refuses it, when a patch names layout", async () => {
    const demo = await connected();
    await expect(
      backend.setWorkspaceSettings(DEMO.atlas, { color: "#f472b6", pages: [] } as never)
    ).rejects.toBe("`pages` is not a workspace setting");
    expect(demoAtlas(demo).color).toBe("#2dd4bf");
  });

  it("takes a change made at the desk: its settings, never its layout", async () => {
    const demo = await connected();
    const pages = atlas().pages;

    demo.emit("workspace-settings-synced", {
      origin: "main",
      record: { id: DEMO.atlas, name: "Atlas API", rootPath: DEMO.atlasRoot, color: "#fbbf24" },
    });
    await settle();

    expect(atlas()).toMatchObject({ name: "Atlas API", color: "#fbbf24" });
    expect(atlas().pages).toEqual(pages);
  });

  it("writes the agent's model and effort to its folder's config, and the phone sees them come back", async () => {
    const demo = await connected();
    const from = mark(demo);

    await saveSetting(() => setAgentField(DEMO.atlas, "model", "sonnet"));
    await saveSetting(() => setAgentField(DEMO.atlas, "effort", "high"));
    await settle();

    expect(argsOf(demo, "set_root_config_field", from)).toEqual([
      { rootPath: DEMO.atlasRoot, key: "model", value: "sonnet" },
      { rootPath: DEMO.atlasRoot, key: "effort", value: "high" },
    ]);
    const agent = get(gavinTrees)[DEMO.atlas]?.contexts.find((c) => c.kind === "root")?.agent;
    expect(agent).toMatchObject({ model: "sonnet", effort: "high" });
  });
});

describe("everything the settings screens send", () => {
  it("is a command the Remote role may call, never a layout save, and one the demo answers", async () => {
    expect(tableSize()).toBeGreaterThan(100);
    const demo = await connected();
    await loadSettings();
    await saveSetting(() => themeState.setPref("light"));
    await saveSetting(() => setTerminalFontSizeDefault(14));
    await saveSetting(() => setAutoCommitDefault(false));
    await saveSetting(() => setRequireReviewDefault(true));
    await saveSetting(() => setGitTrackingDefault(true));
    await saveSetting(() => setAgentModelDefault("codex", "gpt-5"));
    await saveSetting(() => setAgentDefaults({ ...get(agentDefaultsStore), fallbackChains: { "claude-code": ["codex"] } }));
    await saveSetting(() => saveAgentPauseFor("claude-code", CYCLE));
    await saveSetting(() => saveLaunchConfig({ maxInFlight: 3, holdOnPressure: true, reclaimDoneSessions: true }));
    await saveSetting(() => renameWorkspace(DEMO.notes, "notes"));
    await saveSetting(() => setWorkspaceColor(DEMO.notes, "#60a5fa"));
    await saveSetting(() => setWorkspaceFontSize(DEMO.notes, 12));
    await saveSetting(() => setWorkspacePause(DEMO.notes, "claude-code", null));
    await saveSetting(() => setWorkspaceFallback(DEMO.notes, "claude-code", null));
    await saveSetting(() => setAgentField(DEMO.notes, "model", "opus"));
    await settle();

    const sent = [...new Set(demo.commands())];
    expect(sent.filter((cmd) => !allowedToRemoteRole(cmd))).toEqual([]);
    expect(sent.filter((cmd) => (LAYOUT_SAVING_COMMANDS as readonly string[]).includes(cmd))).toEqual([]);
    expect(demo.unanswered()).toEqual([]);
    expect(get(gitTrackingDefault)).toBe(true);
    expect(get(saveProblem)).toBeNull();
  });
});
