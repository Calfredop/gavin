import { describe, it, expect } from "vitest";

// Complexity is one field expressed on six surfaces -- the ⌘N composer,
// the card detail modal, the Plans tab's metadata strip, the shared
// settings table, the workspace panel and the app-wide one -- and nothing
// links those files. Every rule they
// share is invisible to every other suite: a select wired to no setter
// renders perfectly, and a compat gate with no consumer type-checks fine.
// Both are dead controls, which is the failure this pins.
//
// Reads the component sources rather than the rendered DOM, following
// autoCommitSurfaces.test.ts: mounting six components to assert "this
// handler is called" tests the harness, and a component `<style>` is
// compiled away anyway.

const SOURCES = import.meta.glob("./*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const TS_SOURCES = import.meta.glob("./*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function source(name: string): string {
  const text = SOURCES[`./${name}`] ?? TS_SOURCES[`./${name}`];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

const COMPOSER = "CardComposeModal.svelte";
const DETAIL = "CardDetailModal.svelte";
const PLANS_PANEL = "PlanMetadataPanel.svelte";
const TABLE = "ComplexityTable.svelte";
const WORKSPACE_PANEL = "SettingsHubView.svelte";
const APP_PANEL = "GlobalSettingsModal.svelte";

describe("the card surfaces", () => {
  // The half `min_version_for` is structurally blind to. A v30 daemon
  // refuses the set_plan_field key loudly but drops CreatePlan's field
  // silently, so BOTH surfaces owe the gate -- see FEATURE_MIN_VERSION's
  // `complexity` entry, which exists for exactly this pair.
  it.each([
    ["the composer", COMPOSER],
    ["the detail modal", DETAIL],
    ["the Plans tab strip", PLANS_PANEL],
  ])("%s gates on the daemon version rather than failing on change", (_name, file) => {
    expect(source(file)).toContain('featureBlockedReason($daemonCompat, "complexity")');
    expect(source(file)).toContain("complexityBlocked");
  });

  it.each([
    ["the composer", COMPOSER],
    ["the detail modal", DETAIL],
    ["the Plans tab strip", PLANS_PANEL],
  ])("%s offers unrated as the absence of a level, not a sixth one", (_name, file) => {
    // NO_COMPLEXITY, never a literal "": "nobody said" and "this is
    // trivial" pick different agents, and the sentinel is what keeps
    // them from collapsing into each other at a call site.
    expect(source(file)).toContain("<option value={NO_COMPLEXITY}>unrated</option>");
    // The levels come from the shared list, so a level added there can
    // never be missing from a picker.
    expect(source(file)).toContain("{#each COMPLEXITY_LEVELS as level (level)}");
  });

  it("files the level in the SAME CreatePlan as the card", () => {
    // A card written first and rated second has a window in which it
    // exists unrated -- and could be run in it, at the wrong agent.
    expect(source(COMPOSER)).toContain("attachments, autoCommit, complexity }");
    expect(source(COMPOSER)).toContain("args.complexity");
  });

  it("tells the human what the level will actually launch", () => {
    // The whole reason the field exists. Without this the modal offers a
    // choice whose consequence lives in two other panels.
    expect(source(DETAIL)).toContain("complexitySummary(");
    expect(source(DETAIL)).toContain("complexityLine");
  });
});

describe("the settings panels", () => {
  it.each([
    ["the workspace panel", WORKSPACE_PANEL],
    ["the app panel", APP_PANEL],
  ])("%s renders the shared table rather than its own", (_name, file) => {
    expect(source(file)).toContain("<ComplexityTable");
    expect(source(file)).toContain('import ComplexityTable from "./ComplexityTable.svelte"');
  });

  it("gives the workspace panel the app table to fall through to", () => {
    // Without `inherited` every row would read "This workspace's agent",
    // which is a lie about any level the app has attributed.
    expect(source(WORKSPACE_PANEL)).toContain("inherited={$agentDefaultsStore.complexity}");
  });

  it("writes a workspace row to the workspace and an app row to the app", () => {
    expect(source(WORKSPACE_PANEL)).toContain("setWorkspaceComplexityTable(workspaceId");
    expect(source(APP_PANEL)).toContain("setAgentDefaults({ ...$agentDefaultsStore, complexity })");
  });

  it("clears a row rather than storing an empty one", () => {
    // An empty entry would shadow the app-wide answer with nothing,
    // which is the opposite of what clearing a row means.
    expect(source(TABLE)).toContain("isAttributed(next) ? next : null");
  });
});

describe("the custom agent", () => {
  it("offers both halves app-wide, since neither is any use alone", () => {
    // A command with no flag is an agent gavin cannot vary the model of,
    // and a flag with no command names nothing.
    expect(source(APP_PANEL)).toContain("customCommand:");
    expect(source(APP_PANEL)).toContain("customModelFlag:");
  });

  it("gates the workspace's own flag on the daemon that has to store it", () => {
    // A v30 daemon refuses the SetRootConfigField key AND never parses
    // it back, so a flag written there would compose a model onto a
    // command that then went nowhere.
    expect(source(WORKSPACE_PANEL)).toContain('featureBlockedReason($daemonCompat, "agentModelFlag")');
    expect(source(WORKSPACE_PANEL)).toContain("modelFlagBlocked");
  });

  it("shows the model control from the RESOLVED flag, not the profile table's", () => {
    // The whole point of the feature: a custom agent has no flag in the
    // table, so gating the picker on `profileInfo.modelFlag` would keep
    // it dark however the flag was configured.
    expect(source(WORKSPACE_PANEL)).toContain("{#if agent.modelFlag}");
    expect(source(WORKSPACE_PANEL)).toContain("modelFlag: agent.modelFlag");
  });
});
