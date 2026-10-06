// What the bundle's own code may not do, read off its source.
//
// The wire suites prove what is never SENT. These keep the code from
// reaching for the means in the first place, and they cover the one part
// no suite mounts: the templates. Like the desktop's own surface guards
// they read text, because drawing a surface needs a page.
import { describe, expect, it } from "vitest";
import { codeOf, companionSource, companionSources } from "$companion/testing/companionSources";
import layoutStateSource from "../../../../src/lib/core/layoutState.ts?raw";

/// One top-level function's text in a module's source, from its
/// declaration to the brace that closes it at the start of a line.
function functionBody(source: string, name: string): string {
  const start = new RegExp(`^(export )?(async )?function ${name}\\(`, "m").exec(source);
  if (!start) throw new Error(`no function ${name} in the source`);
  const end = source.indexOf("\n}\n", start.index);
  return source.slice(start.index, end === -1 ? undefined : end);
}

/// What `import { ... } from "<module>"` names in one source.
function importedFrom(text: string, module: string): string[] {
  const names: string[] = [];
  const pattern = new RegExp(`import\\s+(type\\s+)?\\{([^}]*)\\}\\s+from\\s+"${module.replace(/[$/]/g, "\\$&")}"`, "g");
  for (const match of text.matchAll(pattern)) {
    for (const name of match[2].split(",")) {
      const bare = name.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
      if (bare) names.push(bare);
    }
  }
  return names;
}

describe("what the bundle takes from the desktop's layout state", () => {
  // What the desktop's components read, and what only records what the
  // Workstation said: the stores, the handlers, the loaders.
  const STORES_AND_HANDLERS = [
    "layoutState",
    "attentionStatusById",
    "handleSessionStatusChanged",
    "handleCwdChanged",
    "loadAgentProfiles",
    "reloadAppSettings",
    "agentProfilesStore",
    "agentModelDefaultsStore",
    "agentDefaultsStore",
    "customResumeArgsDefault",
    "terminalFontSizeDefault",
    "autoCommitDefault",
    "requireReviewDefault",
    "gitTrackingDefault",
    "daemonCompat",
    "trustedAgentConfigs",
  ];
  // What a new session is made of at the desk -- the agent a workspace
  // resolves to, the profile a launch names, the failure patterns it arms.
  // They save nothing; placing the session is the action, and that is the
  // desk's.
  const LAUNCH_HELPERS = ["resolvedAgentFor", "profileIdForLaunch", "armFailureDetection"];
  // Most of that module's ACTIONS end in a save of the desk's pages and
  // tabs. These do not (ADR 0006): each writes Workstation data -- a
  // workspace's settings through `set_workspace_settings` (the review
  // stamp among them: which cards the human has read), its agent through
  // its config.toml, or an app-wide setting through its own command -- and
  // the guard below reads each one's body to hold it there.
  const SETTINGS_WRITERS = [
    "renameWorkspace",
    "setWorkspaceColor",
    "setWorkspaceFontSize",
    "setWorkspaceAutoCommit",
    "setWorkspaceRequireReview",
    "setWorkspaceComplexityTable",
    "setWorkspaceCustomProfiles",
    "setWorkspacePause",
    "setWorkspacePromptParams",
    "dropWorkspaceProfileRefs",
    "setWorkspaceFallback",
    "setWorkspaceFlag",
    "setAgentField",
    "setTerminalFontSizeDefault",
    "setAutoCommitDefault",
    "setRequireReviewDefault",
    "setGitTrackingDefault",
    "setAgentModelDefault",
    "setAgentDefaults",
    "stampCardReview",
  ];

  it("is its stores, its handlers, its launch helpers and its settings writers, never a layout action", () => {
    const allowed = [...STORES_AND_HANDLERS, ...LAUNCH_HELPERS, ...SETTINGS_WRITERS];
    const taken = Object.entries(companionSources()).flatMap(([name, text]) =>
      importedFrom(codeOf(text), "$lib/core/layoutState")
        .filter((imported) => !allowed.includes(imported))
        .map((imported) => `${name}: ${imported}`)
    );
    expect(taken).toEqual([]);
  });

  it("has settings writers that never reach the desk's layout save", () => {
    // One level down as well: the helpers the writers share.
    const reached = [...SETTINGS_WRITERS, "saveWorkspaceSettings", "stampConfigTrust"].flatMap((name) => {
      const body = functionBody(layoutStateSource, name);
      return /\bpersistWorkspaces\s*\(/.test(body) ? [name] : [];
    });
    expect(reached).toEqual([]);
    // And the read finds one where there is one: pinning a row is layout.
    expect(functionBody(layoutStateSource, "setWorkspacePinned")).toMatch(/\bpersistWorkspaces\s*\(/);
  });

  it("is never the whole module", () => {
    const whole = Object.entries(companionSources())
      .filter(([, text]) => /import\s+\*\s+as\s+\w+\s+from\s+"\$lib\/core\/layoutState"/.test(codeOf(text)))
      .map(([name]) => name);
    expect(whole).toEqual([]);
  });

  it("is read by this guard in the files that take the most", () => {
    expect(importedFrom(companionSource("companion/state/sessions.ts"), "$lib/core/layoutState").sort()).toEqual(
      [
        "agentDefaultsStore",
        "agentModelDefaultsStore",
        "agentProfilesStore",
        "armFailureDetection",
        "customResumeArgsDefault",
        "layoutState",
        "profileIdForLaunch",
        "requireReviewDefault",
        "resolvedAgentFor",
      ]
    );
    expect(importedFrom(companionSource("companion/state/workstation.ts"), "$lib/core/layoutState").sort()).toEqual(
      ["handleCwdChanged", "handleSessionStatusChanged", "layoutState", "loadAgentProfiles", "reloadAppSettings"]
    );
    expect(
      importedFrom(codeOf(companionSource("companion/surfaces/PhoneWorkspaceSettings.svelte")), "$lib/core/layoutState")
    ).toContain("setWorkspaceColor");
  });
});

describe("what the bundle builds when its modules load", () => {
  // The card's second trap: a module-level `derived` over a layoutState
  // export is evaluated at import, so every suite that mocks that module
  // partially breaks on a store it did not supply. The surfaces derive in
  // the component instead, where the store is only read once it is drawn.
  it("is no store derived from the desktop's", () => {
    const derivers = Object.entries(companionSources())
      .filter(([name]) => name.endsWith(".ts"))
      .filter(([, text]) => /\bderived\s*\(/.test(codeOf(text)))
      .map(([name]) => name);
    expect(derivers).toEqual([]);
  });
});

describe("the board surface", () => {
  const board = () => codeOf(companionSource("companion/surfaces/PhoneBoard.svelte"));

  it("draws the desktop's own card", () => {
    expect(board()).toContain('import BoardCard from "$lib/board/BoardCard.svelte"');
    expect(board()).toContain("<BoardCard");
  });

  it("gives the card no workspace, which is what gives it no controls", () => {
    // With a workspace id the desk's card draws its session badge as a
    // button that jumps to the session -- moving the desk's tabs -- and
    // offers Run. Without one it is the card the desk draws in previews.
    expect(board()).toContain("workspaceId={null}");
  });

  it.each(["onRun", "onSendToAgent", "onDelete", "onContextMenu"])("hands the card no %s", (prop) => {
    expect(board()).not.toMatch(new RegExp(`\\b${prop}\\b`));
  });

  it("takes nothing from the modules that act on a card", () => {
    for (const module of ["cardRunActions", "cardDelete", "kanbanDragGlue", "archiveActions"]) {
      expect(board()).not.toContain(module);
    }
  });
});

describe("acting on a card", () => {
  const cards = () => codeOf(companionSource("companion/state/cards.ts"));

  it("launches only with the Device's host, which places nothing at the desk", () => {
    // Without a host the desk's launch flow places the session as a tab,
    // jumps the desk's view to it and queues in the desk's queue -- the
    // desk's layout and duties, from a phone.
    const calls = [...cards().matchAll(/\b(runCard|resumeCard|relaunchCard)\(([^;]*?)\);/gs)];
    expect(calls.map((c) => c[1]).sort()).toEqual(["relaunchCard", "resumeCard", "runCard"]);
    for (const [call] of calls) expect(call).toContain("DEVICE_LAUNCH_HOST");
  });

  it("archives with its own ender, which leaves the desk's tabs to the desk", () => {
    expect(cards()).toMatch(/executeArchive\([^)]*,\s*endAway\)/);
  });

  it("is reached from the phone's surfaces only through this module", () => {
    for (const [name, text] of Object.entries(companionSources())) {
      if (name === "companion/state/cards.ts" || name.endsWith(".test.ts")) continue;
      for (const module of ["cardRunActions", "archiveActions", "decisionsActions", "cardCompletion"]) {
        expect(codeOf(text), `${name} imports ${module}`).not.toContain(`/${module}"`);
      }
    }
  });

  it("answers an item with the Decisions tab's own row", () => {
    const page = codeOf(companionSource("companion/surfaces/PhoneCard.svelte"));
    expect(page).toContain('import DecisionsItemRow from "$lib/decisions/DecisionsItemRow.svelte"');
    expect(page).toContain("<DecisionsItemRow");
  });
});

describe("the terminal surface", () => {
  const terminal = () => codeOf(companionSource("companion/surfaces/PhoneTerminal.svelte"));

  it("draws the desktop's own terminal, on the desktop's registry", () => {
    expect(terminal()).toContain('import TerminalPane from "$lib/terminal/TerminalPane.svelte"');
    expect(terminal()).toContain("<TerminalPane");
  });

  it("types through the dock's modules, not bytes of its own", () => {
    expect(terminal()).not.toMatch(/\\x1b|\\u001b|\\r/);
    expect(terminal()).not.toContain("backend.writeInput");
  });

  it("lets its terminal go when it closes, so no screen nobody sees keeps streaming", () => {
    expect(terminal()).toContain("destroyTerminal(sessionId)");
  });
});

describe("the Git surface", () => {
  const PARTS = [
    "companion/surfaces/PhoneGit.svelte",
    "companion/surfaces/PhoneGitChanges.svelte",
    "companion/surfaces/PhoneGitDiff.svelte",
    "companion/surfaces/PhoneGitBranches.svelte",
  ];
  const git = () => PARTS.map((part) => codeOf(companionSource(part))).join("\n");

  it.each(["GitCommitBox", "GitFileRow", "GitDiffUnified", "GitOpBar"])("draws the desktop's own %s", (component) => {
    expect(git()).toContain(`import ${component} from "$lib/git/${component}.svelte"`);
    expect(git()).toContain(`<${component}`);
  });

  it("acts through the desktop's own Git state, and nothing of its own", () => {
    for (const part of PARTS) {
      const text = codeOf(companionSource(part));
      expect(text).not.toMatch(/\bbackend\.git\w+\(/);
      expect(text).not.toContain("invoke(");
    }
    expect(git()).toContain('from "$lib/git/gitState"');
  });

  // The desk's tab and its columns save their widths, folds, diff layout
  // and worktree choice with `setGitViewPrefs` -- the desk's layout, which
  // the Companion never writes.
  it.each(["GitHubView", "GitToolbar", "GitNav", "GitChanges", "GitDiff", "GitWorktreeSwitcher"])(
    "leaves the desk's %s at the desk",
    (component) => {
      expect(git()).not.toMatch(new RegExp(`import ${component} from`));
    }
  );

  it.each(["setGitViewPrefs", "switchWorktree", "setGraphAll", "commitViaAgent", "openMergeTool"])(
    "never reaches for %s",
    (action) => {
      expect(git()).not.toMatch(new RegExp(`\\b${action}\\b`));
    }
  );

  it("always reads the workspace's root, never a worktree the desk chose", () => {
    const frame = codeOf(companionSource("companion/surfaces/PhoneGit.svelte"));
    expect(frame).toContain("ensureGitView(id, target)");
    expect(frame).toContain("workspace.rootPath");
    expect(frame).not.toContain("gitView");
  });
});

describe("the Files surface", () => {
  const files = () => codeOf(companionSource("companion/surfaces/PhoneFiles.svelte"));

  it("opens a file in the desktop's own editor, with no way to open it at the desk", () => {
    expect(files()).toContain('import FileEditor from "$lib/files/FileEditor.svelte"');
    expect(files()).toMatch(/<FileEditor[^>]*canOpenExternally=\{false\}/);
  });

  it("walks the desktop's own tree state", () => {
    expect(files()).toContain('from "$lib/files/fileTree"');
    expect(files()).toContain("withChildren(");
  });

  it.each(["openPathExternally", "revealPathExternally", "saveFilesMemory", "openFileInSplit", "confirmDestructive"])(
    "never reaches for %s",
    (action) => {
      expect(files()).not.toMatch(new RegExp(`\\b${action}\\b`));
    }
  );
});

describe("the Agents settings hub", () => {
  const app = () => codeOf(companionSource("companion/surfaces/PhoneAppSettings.svelte"));
  const workspace = () => codeOf(companionSource("companion/surfaces/PhoneWorkspaceSettings.svelte"));

  it("reuses the desk's tab shell on both screens", () => {
    for (const text of [app(), workspace()]) {
      expect(text).toContain('import AgentsHubTabs from "$lib/agents/AgentsHubTabs.svelte"');
      expect(text).toContain("<AgentsHubTabs");
      expect(text).toContain('title="Agents"');
      expect(text).toContain("agentsHubTabs");
      expect(text).toContain("GENERAL_TAB");
    }
  });

  it("app screen: General + per-agent tabs, customs inline, the + tab, setAgentDefaults", () => {
    expect(app()).toContain("Default agent");
    expect(app()).toContain("Add custom");
    expect(app()).toContain("addCustomProfile");
    expect(app()).toContain("customProfiles:");
    expect(app()).toContain("agentsHubTabs(allProfiles, ADD_TAB_HINT.app)");
    expect(app()).toContain("{:else if agentsTab === ADD_TAB}");
    expect(app()).not.toContain("CustomsEditor");
    expect(app()).not.toContain("APP_AGENTS_TABS");
    expect(app()).not.toContain("customCommand");
  });

  it("workspace screen: General + per-agent tabs, CustomsEditor on local customs, the + tab", () => {
    expect(workspace()).toContain("Add local custom");
    expect(workspace()).toContain("setWorkspaceCustomProfiles");
    expect(workspace()).toContain("dropWorkspaceProfileRefs");
    expect(workspace()).toContain('import CustomsEditor from "$lib/agents/CustomsEditor.svelte"');
    expect(workspace()).toContain("<CustomsEditor");
    expect(workspace()).toContain("local");
    expect(workspace()).toContain("agentsHubTabs(profiles, ADD_TAB_HINT.workspace)");
    expect(workspace()).toContain("{:else if agentsTab === ADD_TAB}");
    expect(workspace()).not.toContain("WORKSPACE_AGENTS_TABS");
  });

  it("draws every per-agent block through one phone panel, General and each tab alike", () => {
    const panel = codeOf(companionSource("companion/surfaces/PhoneAgentPrimary.svelte"));
    // Fallback, complexity, pause, prompt lines and CLI arguments live in
    // the panel, read and written through the same module the desk's uses.
    expect(panel).toContain("withFallbackChainForPrimary");
    expect(panel).toContain("workspaceOwnsFallbackChain");
    expect(panel).toContain("<ComplexityTable");
    expect(panel).toContain("<PromptParamsEditor");
    expect(panel).toContain("$lib/agents/agentPrimary");
    // Both screens point it at an agent; neither keeps its own copy.
    for (const text of [app(), workspace()]) {
      expect(text).toContain("<PhoneAgentPrimary");
      expect(text).not.toContain("<FallbackChainEditor");
      expect(text).not.toContain("<ComplexityTable");
    }
    expect((app().match(/<PhoneAgentPrimary/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((workspace().match(/<PhoneAgentPrimary/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe("the page", () => {
  it("can name a Git op however the shell serves it", () => {
    // gitState.ts calls crypto.randomUUID for every commit, push,
    // checkout and merge, and a page outside a secure context has none.
    expect(codeOf(companionSource("routes/+layout.svelte"))).toContain("ensureRandomUUID();");
  });

  it("switches surfaces through the Companion's own view", () => {
    const page = codeOf(companionSource("routes/+page.svelte"));
    expect(page).toContain("<SurfaceTabs");
    expect(page).toContain("onPick={showSurface}");
    expect(page).toContain("onPlace={placeFiles}");
  });

  const page = () => codeOf(companionSource("routes/+page.svelte"));

  it("connects through the bundle's own way in", () => {
    expect(page()).toContain("connectWorkstation(");
    expect(page()).toContain("openChannel(");
  });

  it("draws under a boundary, so a surface that throws says so", () => {
    // A throw while a branch is created leaves the OLD branch on screen
    // and logs nothing (the desktop's viewBoundary guard has the whole
    // story). On a phone there is no console to look in either.
    expect(page()).toContain("<svelte:boundary");
    expect(page()).toContain("{#snippet failed(");
  });
});
