import { describe, it, expect } from "vitest";
import { COMPLEXITY_LEVELS } from "./complexity";
import { svelteSources, tsSources } from "./sources";

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

const SOURCES = svelteSources();

const TS_SOURCES = tsSources();

function source(name: string): string {
  const text = SOURCES[name] ?? TS_SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

// The one surface that is not code. Most levels are decided by an agent
// developing a card rather than by the human filing it -- someone typing
// one line into ⌘N usually cannot say yet how hard the work is, which is
// the whole reason develop exists -- so the skill file IS the rating
// path, and nothing else in this repo would catch it losing the
// instruction.
const SKILL_PATH = "../../../.claude/skills/gavin-develop/SKILL.md";
const DEVELOP_SKILL = (
  import.meta.glob("../../../.claude/skills/gavin-develop/SKILL.md", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>
)[SKILL_PATH];

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

  it.each([
    ["the composer", COMPOSER],
    ["the detail modal", DETAIL],
    ["the Plans tab strip", PLANS_PANEL],
  ])("%s draws the gated picker as gated, not as broken", (_name, file) => {
    // The gate turns the select `disabled`, and all three surfaces set
    // its colour AND background explicitly -- which beats the UA's own
    // disabled greying. Without a rule of their own the dead picker
    // renders pixel-identical to the live ones beside it: it opens
    // nothing, says nothing, and reads as a bug rather than as a field
    // this daemon does not carry. That is what "the complexity picker is
    // not working" turned out to be.
    expect(source(file)).toMatch(/select:disabled\s*{/);
  });

  it("says why the composer's picker is off, not just that it is", () => {
    // The other two surfaces already explain themselves -- the detail
    // modal with a warning line, the Plans strip with the reason on a
    // label short enough to hover. The composer had only a `title` on a
    // control the human had already written off as broken.
    expect(source(COMPOSER)).toContain("{#if complexityBlocked}");
    expect(source(COMPOSER)).toContain('class="field-note">{complexityBlocked}');
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
    //
    // Through `cardAgentSummary` rather than `complexitySummary` since
    // v32: the card's own `agent:`/`model:` can beat the level, and two
    // independent lines would leave the modal asserting both answers at
    // once. See cardAgentSurfaces.test.ts.
    expect(source(DETAIL)).toContain("cardAgentSummary(");
    expect(source(DETAIL)).toContain("cardAgentLine");
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

describe("the develop skill", () => {
  it("is on disk where the develop prompt points an agent", () => {
    // A glob that matched nothing would make every assertion below pass
    // vacuously, which is the one way this suite could go quiet about a
    // renamed or deleted skill.
    expect(typeof DEVELOP_SKILL).toBe("string");
    expect(DEVELOP_SKILL.length).toBeGreaterThan(0);
  });

  it("teaches every level, in the spelling the daemon parses", () => {
    // The written names ARE the frontmatter value: a skill that told an
    // agent to write "med" would produce a card the daemon reads as
    // unrated, silently.
    for (const level of COMPLEXITY_LEVELS) {
      expect(DEVELOP_SKILL).toContain(`\`${level}\``);
    }
  });

  it("writes the level through the field setter, not a hand-edited line", () => {
    expect(DEVELOP_SKILL).toContain('gavin_set_plan_field(path, "complexity", "<level>")');
  });

  it("rates the children too, in the call that creates them", () => {
    // A nested task is what an agent actually executes, so an unrated
    // child is the case the field exists for -- and one filed unrated
    // and rated afterwards can be run in between.
    expect(DEVELOP_SKILL).toContain("the child's own `complexity`");
  });

  it("keeps unrated reachable rather than making the agent guess", () => {
    // "Nobody can tell yet" is a real state -- it runs the workspace's
    // own agent -- and a guessed level sends work to the wrong model
    // with nothing on screen to say so.
    expect(DEVELOP_SKILL).toContain("unrated");
    expect(DEVELOP_SKILL).toContain("never a\n  guessed `moderate`");
  });

  it("proposes the level before writing it, like the kind", () => {
    // Nothing in this skill is written before the human says yes, and a
    // level spends their model budget.
    expect(DEVELOP_SKILL).toContain("the `complexity:` you\nare giving the card and each child");
  });
});
