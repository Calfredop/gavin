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
  // Workstation said: the stores, the status handler, the loaders.
  const STORES_AND_HANDLERS = [
    "layoutState",
    "attentionStatusById",
    "handleSessionStatusChanged",
    "loadAgentProfiles",
    "reloadAppSettings",
    "agentProfilesStore",
    "agentModelDefaultsStore",
    "agentDefaultsStore",
    "terminalFontSizeDefault",
    "autoCommitDefault",
    "requireReviewDefault",
    "gitTrackingDefault",
    "daemonCompat",
    "trustedAgentConfigs",
  ];
  // Most of that module's ACTIONS end in a save of the desk's pages and
  // tabs. These do not (ADR 0006): each writes Workstation data -- a
  // workspace's settings through `set_workspace_settings`, its agent
  // through its config.toml, or an app-wide setting through its own
  // command -- and the guard below reads each one's body to hold it there.
  const SETTINGS_WRITERS = [
    "renameWorkspace",
    "setWorkspaceColor",
    "setWorkspaceFontSize",
    "setWorkspaceAutoCommit",
    "setWorkspaceRequireReview",
    "setWorkspaceComplexityTable",
    "setWorkspacePause",
    "setWorkspaceFallback",
    "setWorkspaceFlag",
    "setAgentField",
    "setTerminalFontSizeDefault",
    "setAutoCommitDefault",
    "setRequireReviewDefault",
    "setGitTrackingDefault",
    "setAgentModelDefault",
    "setAgentDefaults",
  ];

  it("is its stores, its handlers and its settings writers, never a layout action", () => {
    const taken = Object.entries(companionSources()).flatMap(([name, text]) =>
      importedFrom(codeOf(text), "$lib/core/layoutState")
        .filter((imported) => !STORES_AND_HANDLERS.includes(imported) && !SETTINGS_WRITERS.includes(imported))
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
    expect(importedFrom(companionSource("companion/state/workstation.ts"), "$lib/core/layoutState").sort()).toEqual(
      ["handleSessionStatusChanged", "layoutState", "loadAgentProfiles", "reloadAppSettings"]
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
