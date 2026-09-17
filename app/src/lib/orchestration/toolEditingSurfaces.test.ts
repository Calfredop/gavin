import { describe, it, expect } from "vitest";
import { svelteSources } from "$lib/sources";

const SOURCES = svelteSources();

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

const TAB = "WorkspaceToolsHubView.svelte";
const EXPLORER = "ToolsExplorerView.svelte";
const DIALOG = "ToolLibraryDialog.svelte";
const APP_SETTINGS = "GlobalSettingsView.svelte";

describe("unified Tools explorer", () => {
  it("is the Tools tab body, with Run on the selected tool", () => {
    const tab = source(TAB);
    expect(tab).toContain("import ToolsExplorerView");
    expect(tab).toContain('scope="workspace"');
    expect(tab).not.toContain('mode = $state<"run" | "prompts">');
    const explorer = source(EXPLORER);
    expect(explorer).toContain("requestToolRun");
    expect(explorer).toContain("<Play");
    expect(explorer).toContain("toolsForExplorer");
    expect(explorer).toContain("toolIcon");
  });

  it("still opens the library dialog for New / Manage / Duplicate", () => {
    const tab = source(TAB);
    expect(tab).toContain("import ToolLibraryDialog");
    expect(tab).toContain("initialEdit={managing.draft}");
    expect(tab).toContain("emptyTool(crypto.randomUUID())");
    expect(tab).toContain("onManage=");
    expect(source(DIALOG)).toMatch(/initialEdit\?: Tool \| null;/);
  });

  it("app settings hosts the same explorer for app-wide prompts", () => {
    const settings = source(APP_SETTINGS);
    expect(settings).toContain("import ToolsExplorerView");
    expect(settings).toContain('scope="app"');
    expect(settings).toContain('id: "tools"');
  });

  it("writes prompt overrides through actionPromptsState", () => {
    const explorer = source(EXPLORER);
    expect(explorer).toContain("setAppPromptOverride");
    expect(explorer).toContain("setWorkspacePromptOverride");
    expect(explorer).toContain("saveToolAction");
  });
});

describe("switching a tool's kind", () => {
  it("goes through bodyForKind in the dialog", () => {
    const dialog = source(DIALOG);
    expect(dialog).toContain("onclick={() => pickKind(kind)}");
    expect(dialog).toContain("editing.body = bodyForKind(kind, editing.body, stashedBody)");
  });

  it("also goes through bodyForKind in the explorer", () => {
    expect(source(EXPLORER)).toContain("bodyForKind(kind, draftTool.body, stashedBody)");
  });
});

describe("picking a tool's icon", () => {
  it("stays on the library dialog form", () => {
    const dialog = source(DIALOG);
    expect(dialog).toContain('from "$lib/ui/iconLibrary"');
    expect(dialog).toContain("searchIcons(iconQuery)");
    expect(dialog).toContain('featureBlockedReason($daemonCompat, "toolIcon")');
  });
});
