import { describe, it, expect } from "vitest";
import { svelteSources } from "$lib/sources";

// Tool editing is one library dialog reached from the Tools hub and the
// Orchestration drawer, plus a Plans-like explorer on the Tools tab for
// action prompts. Nothing in the type system links them — these checks
// keep the wiring from drifting into a second form.

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

describe("editing prompts and tools from the Tools tab", () => {
  it("hosts the Plans-like explorer for action prompts", () => {
    const tab = source(TAB);
    expect(tab).toContain("import ToolsExplorerView");
    expect(tab).toContain('scope="workspace"');
  });

  it("still opens the library dialog for full authoring", () => {
    const tab = source(TAB);
    expect(tab).toContain("import ToolLibraryDialog");
    expect(tab).toContain("initialEdit={managing.draft}");
    // The tab itself does not save tools — the explorer and the dialog do.
    expect(tab).not.toContain("saveToolAction");
    expect(tab).not.toContain("validateTool");
  });

  it("seeds New tool into the dialog, not a second form", () => {
    expect(source(TAB)).toContain("emptyTool(crypto.randomUUID())");
    expect(source(DIALOG)).toMatch(/initialEdit\?: Tool \| null;/);
  });

  it("reaches the draft state, so the form opens on it", () => {
    const dialog = source(DIALOG);
    expect(dialog).toMatch(/let editing = \$state<Tool \| null>\(\s*initialEdit \?/);
  });
});

describe("app settings hosts the same explorer for app-wide prompts", () => {
  it("wires a Tools section to ToolsExplorerView in app scope", () => {
    const settings = source(APP_SETTINGS);
    expect(settings).toContain("import ToolsExplorerView");
    expect(settings).toContain('scope="app"');
    expect(settings).toContain('id: "tools"');
  });
});

describe("the explorer persists prompt overrides, not a parallel store", () => {
  it("writes through actionPromptsState", () => {
    const explorer = source(EXPLORER);
    expect(explorer).toContain("setAppPromptOverride");
    expect(explorer).toContain("setWorkspacePromptOverride");
    expect(explorer).toContain("saveToolAction");
  });
});

describe("switching a tool's kind", () => {
  it("goes through bodyForKind, never straight onto the draft", () => {
    const dialog = source(DIALOG);
    expect(dialog).toContain("onclick={() => pickKind(kind)}");
    expect(dialog).toContain("editing.body = bodyForKind(kind, editing.body, stashedBody)");
  });

  it("hides the working directory on the kinds that never read it", () => {
    expect(source(DIALOG)).toContain("{#if isRunnableStandalone(editing)}");
  });
});

describe("picking a tool's icon", () => {
  it("offers the app's icon library rather than a list of its own", () => {
    const dialog = source(DIALOG);
    expect(dialog).toContain('from "$lib/ui/iconLibrary"');
    expect(dialog).toContain("searchIcons(iconQuery)");
    expect(dialog).toContain("{#each group.icons as entry (entry.name)}");
  });

  it("puts the field on the form both New tool and Edit tool draw", () => {
    const dialog = source(DIALOG);
    const header = dialog.indexOf('"Edit tool" : "New tool"');
    const field = dialog.indexOf('class="icon-field"');
    expect(header, "the shared form header moved").toBeGreaterThan(-1);
    expect(field, "the icon field is not in the form").toBeGreaterThan(header);
  });

  it("is gated on the daemon that would store it", () => {
    const dialog = source(DIALOG);
    expect(dialog).toContain('featureBlockedReason($daemonCompat, "toolIcon")');
    expect(dialog).toContain("use:tooltip={iconBlocked}");
    expect(dialog).toContain("disabled={Boolean(iconBlocked)}");
  });

  it("offers a way back to the kind's own icon", () => {
    expect(source(DIALOG)).toContain("function clearIcon()");
    expect(source(DIALOG)).toContain("editing.icon = null");
  });
});
