import { describe, it, expect } from "vitest";
import { RAIL_BIND_TABS } from "$lib/railBind";
import { svelteSources } from "$lib/sources";

// The rail's bind dialog was three stacked sections behind one button
// that showed a full worktree path and a page name. Nothing on the way in
// said the dialog could set a BRANCH or a PAGE, the conflict box's repair
// button said "Bind worktree…" even when the repair was a branch, and
// every entry landed at the top of a ~900px scroll.
//
// The dialog is a tab strip now and every surface addresses a tab by id.
// That is markup and prop wiring, which the pure suite cannot reach and
// no rendering test in this repo covers, so this pins it in the source
// the way orchestrationRailHeader.test.ts pins the header's two rows.

const SOURCES = svelteSources();

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

/// Source with its comments stripped, so prose describing a control
/// cannot satisfy an assertion about the control itself.
function markup(name: string): string {
  return source(name).replace(/<!--[\s\S]*?-->/g, "");
}

const BIND = "RailBindDialog.svelte";
const RAIL = "OrchestrationRail.svelte";
const HUB = "OrchestrationHubView.svelte";
const CONFLICTS = "OrchestrationConflicts.svelte";

describe("the bind dialog's strip", () => {
  it("is a tablist built from the shared tab list", () => {
    const s = markup(BIND);
    expect(s).toContain('role="tablist"');
    expect(s).toContain('role="tab"');
    expect(s).toContain('role="tabpanel"');
    // Built from the module, never a second hand-written list: a strip
    // that drifts from the ids every other surface sends is a tab you
    // cannot deep-link to.
    expect(s).toContain("RAIL_BIND_TABS.map((t) => railBindChip(t.id, rail, pageName))");
  });

  it("says what each binding is set to, not only what it is called", () => {
    const s = markup(BIND);
    expect(s).toContain("{chip.label}");
    expect(s).toContain("{chip.value}");
  });

  it("builds one panel at a time, and labels it by the tab that owns it", () => {
    const s = markup(BIND);
    expect(s).toContain('id="rail-bind-tab-{chip.tab}"');
    expect(s).toContain('aria-labelledby="rail-bind-tab-{tab}"');
    expect(s).toContain('{#if tab === "trigger"}');
    expect(s).toContain('{:else if tab === "worktree"}');
    expect(s).toContain('{:else if tab === "branch"}');
    // A branch of the panel per tab, and no more: an id the strip can
    // send that no branch answers renders an empty dialog.
    expect(RAIL_BIND_TABS).toHaveLength(4);
  });

  it("moves with the arrow keys through the shared rule", () => {
    const s = markup(BIND);
    expect(s).toContain("onkeydown={onTabKey}");
    expect(s).toContain("railBindTabAfterKey(tab, event.key)");
    // Only the keys the rule claims are swallowed, or Escape stops
    // closing the modal.
    expect(s).toContain("if (!next) return;");
  });

  it("opens where the caller sent it, and then belongs to the human", () => {
    const s = source(BIND);
    expect(s).toContain('initialTab?: RailBindTab;');
    expect(s).toContain('let tab = $state<RailBindTab>(initialTab);');
    // Not an $effect re-syncing from the prop: which tab you land on is
    // asked once, when the dialog opens.
    expect(s).not.toMatch(/\$effect\([^)]*tab = initialTab/);
  });

  it("still keeps every list it had", () => {
    const s = markup(BIND);
    expect(s).toContain("New worktree…");
    expect(s).toContain("New branch…");
    expect(s).toContain("New page “{rail.name}”");
  });
});

describe("the rail header's way in", () => {
  it("is one chip per binding, each opening its own tab", () => {
    const s = markup(RAIL);
    expect(s).toContain('{@render bindChip(bindWorktree)}');
    expect(s).toContain('{@render bindChip(bindBranch)}');
    expect(s).toContain('{@render bindChip(bindPage)}');
    expect(s).toContain("onclick={() => onBind(chip.tab)}");
  });

  it("reads its words from the shared chip, never from the rail directly", () => {
    const s = source(RAIL);
    expect(s).toContain('railBindChip("worktree", rail, pageName)');
    expect(s).toContain('railBindChip("branch", rail, pageName)');
    expect(s).toContain('railBindChip("page", rail, pageName)');
    // The old row printed these itself, in wording only it used.
    const m = markup(RAIL);
    expect(m).not.toContain('{rail.worktreePath ?? "no worktree"}');
    expect(m).not.toContain('{pageName ?? "page at launch"}');
  });

  it("explains the default rather than leaving an empty-looking chip", () => {
    expect(markup(RAIL)).toContain("use:tooltip={chip.tip}");
  });
});

describe("the surfaces that open it", () => {
  it("hand the hub a rail AND a tab", () => {
    const s = markup(HUB);
    expect(s).toContain("onBind={(tab) => openBind(rail.id, tab)}");
    expect(s).toContain("onBindRail={openBind}");
    expect(s).toContain("initialTab={bindingTab}");
    // `binding` stays a plain id: it is what the dialog's rail prop
    // resolves through (railSelection.svelte.ts).
    expect(source(HUB)).toContain("let binding = $state<string | null>(null);");
  });

  it("let the conflict box name the binding it is actually repairing", () => {
    const s = markup(CONFLICTS);
    expect(s).toContain("{@const fix = railBindFix(conflict.kind)}");
    expect(s).toContain("onclick={() => onBindRail(railId, fix.tab)}");
    expect(s).not.toContain('"Bind branch…"');
    expect(s).not.toContain('"Bind worktree…"');
  });
});
