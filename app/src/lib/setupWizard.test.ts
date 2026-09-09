import { describe, it, expect } from "vitest";
import {
  setupProgress,
  applyPrdSections,
  agentFlowAvailable,
  prdHasPlaceholders,
  PRD_PLACEHOLDERS,
  SETUP_STEPS,
} from "./setupWizard";
import type { SuperpowersStatus } from "./superpowers";
import { svelteSources } from "./sources";

/// A settled check that found nothing: enough to keep the derivation off
/// `pending` without completing the Superpowers step.
const SP_ABSENT: SuperpowersStatus = {
  state: "absent",
  detail: "",
  command: "",
  installable: true,
  output: "",
};
const SP_FOUND: SuperpowersStatus = { ...SP_ABSENT, state: "verified" };

const TEMPLATE = [
  "# ws — Product Requirements",
  "",
  "## Vision",
  "",
  "_What are we building, for whom, and why?_",
  "",
  "## Current focus",
  "",
  "_The active goals, roughly ordered._",
  "",
  "## Out of scope",
  "",
  "_Explicit non-goals._",
  "",
].join("\n");

const NOTHING_DONE = {
  hasRoot: true,
  configCommand: null,
  agentFileBody: null,
  prdBody: TEMPLATE,
  mainSessionId: null,
  superpowers: SP_ABSENT,
  superpowersMark: undefined,
  gitTrackingAsked: false,
  requireReviewAsked: false,
};

const ALL_DONE = {
  hasRoot: true,
  configCommand: "claude",
  agentFileBody: "<!-- gavin:start -->",
  prdBody: TEMPLATE.replace(PRD_PLACEHOLDERS.vision, "Real."),
  mainSessionId: "agent-1",
  superpowers: SP_FOUND,
  superpowersMark: undefined,
  gitTrackingAsked: true,
  requireReviewAsked: true,
};

// The home tab's banner lives entirely in compiled markup, which no other
// suite can see -- vite hands SSR nothing for a component's template.
const SOURCES = svelteSources();

describe("setupProgress", () => {
  it("reports nothing done for a freshly initialized root", () => {
    const p = setupProgress(NOTHING_DONE);
    expect(p.done).toEqual([]);
    expect(p.next).toBe("agent");
    expect(p.complete).toBe(false);
  });

  it("counts the agent step once config.toml has a command", () => {
    const p = setupProgress({ ...NOTHING_DONE, configCommand: "claude" });
    expect(p.done).toEqual(["agent"]);
    expect(p.next).toBe("integration");
  });

  it("counts integration only when the marker block is present", () => {
    expect(setupProgress({ ...NOTHING_DONE, agentFileBody: "# hand written\n" }).done).toEqual([]);
    expect(
      setupProgress({ ...NOTHING_DONE, agentFileBody: "x\n<!-- gavin:start -->\ny\n" }).done
    ).toEqual(["integration"]);
  });

  it("counts the PRD when at least one placeholder is gone", () => {
    expect(setupProgress(NOTHING_DONE).done).toEqual([]);
    const oneFilled = TEMPLATE.replace(PRD_PLACEHOLDERS.vision, "A terminal workspace.");
    expect(setupProgress({ ...NOTHING_DONE, prdBody: oneFilled }).done).toEqual(["prd"]);
  });

  it("treats an absent PRD as not done", () => {
    expect(setupProgress({ ...NOTHING_DONE, prdBody: null }).done).toEqual([]);
  });

  it("counts launch from the session id, and completes at five", () => {
    const p = setupProgress(ALL_DONE);
    expect(p.done).toEqual(SETUP_STEPS);
    expect(p.next).toBeNull();
    expect(p.complete).toBe(true);
  });

  // Launch is the one step whose evidence is a live process rather than a
  // file, so it is the one step that can un-happen -- and it is optional
  // besides (W2). `configured` is the three durable steps, and it is what
  // the nag is allowed to read; `complete` still means all four.
  it("counts a workspace as configured before the agent is ever launched", () => {
    const p = setupProgress({ ...ALL_DONE, mainSessionId: null });
    expect(p.configured).toBe(true);
    expect(p.complete).toBe(false);
    expect(p.next).toBe("launch");
  });

  it("stays configured when the main agent is stopped", () => {
    expect(setupProgress(ALL_DONE).configured).toBe(true);
    expect(setupProgress({ ...ALL_DONE, mainSessionId: null }).configured).toBe(true);
  });

  it("is not configured while a file-backed step is undone, launched or not", () => {
    expect(setupProgress({ ...NOTHING_DONE, mainSessionId: "agent-1" }).configured).toBe(false);
    expect(setupProgress({ ...ALL_DONE, configCommand: null }).configured).toBe(false);
    expect(setupProgress({ ...ALL_DONE, agentFileBody: "# hand written\n" }).configured).toBe(
      false
    );
    expect(setupProgress({ ...ALL_DONE, prdBody: TEMPLATE }).configured).toBe(false);
  });

  it("is not configured without a root", () => {
    expect(setupProgress({ ...ALL_DONE, hasRoot: false }).configured).toBe(false);
  });

  // Which field the banner reads IS the fix: `complete` puts a live
  // process in the condition, so Stop on the home agent panel -- or the
  // agent simply exiting -- re-raised a finished workspace's setup nag.
  it("keys the home tab's setup banner off `configured`, not `complete`", () => {
    const src = SOURCES["HomeHubView.svelte"];
    expect(src).toBeTruthy();
    const guard = /\{#if ([^{}]+)\}\s*<button[^>]*class="setup-card"/.exec(src);
    expect(guard, "no {#if} guarding .setup-card").toBeTruthy();
    expect(guard?.[1]).toContain("!setup.configured");
    expect(guard?.[1]).not.toContain("setup.complete");
  });

  // S2: agent tooling, so it sits beside Integration; PRD and Launch stay
  // last. Pinned because the order is what the stepper draws and what
  // `next` walks.
  it("puts Superpowers third, Git fourth and Review fifth", () => {
    // Superpowers beside Integration because it is agent tooling (S2);
    // Git after both because it asks about the files gavin has by then
    // created; Review right after Git, the same shape of question, before
    // PRD because that step writes into a file the earlier ones create.
    expect(SETUP_STEPS).toEqual([
      "agent",
      "integration",
      "superpowers",
      "git",
      "review",
      "prd",
      "launch",
    ]);
  });

  it("counts Superpowers when a check found the plugin", () => {
    const p = setupProgress({ ...NOTHING_DONE, superpowers: SP_FOUND });
    expect(p.done).toEqual(["superpowers"]);
  });

  it("counts Superpowers on the human's word where gavin could not check", () => {
    const p = setupProgress({
      ...NOTHING_DONE,
      superpowers: { ...SP_ABSENT, state: "asserted", installable: false },
      superpowersMark: "installed",
    });
    expect(p.done).toEqual(["superpowers"]);
  });

  // S6's second route, and the reason it exists: without it, declining
  // once leaves the Home banner nagging for ever.
  it("counts Superpowers as answered once it has been declined", () => {
    const p = setupProgress({ ...NOTHING_DONE, superpowersMark: "skipped" });
    expect(p.done).toEqual(["superpowers"]);
  });

  // gavin failing to check is not the human deciding.
  it("does not count Superpowers just because gavin cannot check it", () => {
    const p = setupProgress({
      ...NOTHING_DONE,
      superpowers: { ...SP_ABSENT, state: "unavailable", installable: false },
    });
    expect(p.done).toEqual([]);
    expect(p.next).toBe("agent");
  });

  it("is pending while the Superpowers check has not come back", () => {
    expect(setupProgress({ ...NOTHING_DONE, superpowers: undefined }).pending).toBe(true);
  });

  // A settled marker answers on its own, so an in-flight detector that
  // cannot change the outcome must not hold the whole wizard shut.
  it("is settled by a marker even with the check still running", () => {
    const p = setupProgress({
      ...NOTHING_DONE,
      superpowers: undefined,
      superpowersMark: "skipped",
    });
    expect(p.pending).toBe(false);
    expect(p.done).toEqual(["superpowers"]);
  });

  // The one step whose evidence is a recorded word rather than state on
  // disk. It has to be: both answers are legitimate, and a repository
  // cannot tell "tracked, deliberately" from "nobody has decided".
  it("counts Git once the question has been put, whichever way it was answered", () => {
    const p = setupProgress({ ...NOTHING_DONE, gitTrackingAsked: true });
    expect(p.done).toEqual(["git"]);
  });

  it("does not count Git while nobody has been asked", () => {
    expect(setupProgress({ ...NOTHING_DONE, gitTrackingAsked: false }).done).toEqual([]);
  });

  // The whole reason Git sits outside `configured`: every workspace that
  // existed before the step did has an unanswered git question and a
  // perfectly good setup. Nagging them all would be a banner about a
  // question, not about a problem.
  it("leaves a workspace configured with the git question unanswered", () => {
    const p = setupProgress({ ...ALL_DONE, gitTrackingAsked: false });
    expect(p.configured).toBe(true);
    // ...and the wizard still opens on it, which is where the question
    // belongs.
    expect(p.complete).toBe(false);
    expect(p.next).toBe("git");
  });

  // Read off the workspace record, so unlike every other input it can
  // never be mid-flight.
  it("never holds the derivation pending on the git answer", () => {
    expect(setupProgress({ ...NOTHING_DONE, gitTrackingAsked: false }).pending).toBe(false);
  });

  // Same shape as Git, one step later: both answers are legitimate, and
  // the gate's on-by-default state is indistinguishable on disk from
  // nobody having decided yet.
  it("counts Review once the question has been put, whichever way it was answered", () => {
    const p = setupProgress({ ...NOTHING_DONE, gitTrackingAsked: true, requireReviewAsked: true });
    expect(p.done).toEqual(["git", "review"]);
  });

  it("does not count Review while nobody has been asked", () => {
    expect(setupProgress({ ...NOTHING_DONE, requireReviewAsked: false }).done).toEqual([]);
  });

  it("leaves a workspace configured with the review question unanswered", () => {
    const p = setupProgress({ ...ALL_DONE, requireReviewAsked: false });
    expect(p.configured).toBe(true);
    expect(p.complete).toBe(false);
    expect(p.next).toBe("review");
  });

  it("never holds the derivation pending on the review answer", () => {
    expect(setupProgress({ ...NOTHING_DONE, requireReviewAsked: false }).pending).toBe(false);
  });

  it("next skips steps already done out of order", () => {
    const p = setupProgress({ ...NOTHING_DONE, mainSessionId: "agent-1" });
    expect(p.done).toEqual(["launch"]);
    expect(p.next).toBe("agent");
  });

  // The banner reads its total off this list rather than a literal, which
  // is how "n of 4" survived a fifth step being added anywhere else.
  it("exposes the step list every counter has to count", () => {
    expect(SETUP_STEPS).toHaveLength(7);
  });

  // The two file bodies arrive from async reads, so every consumer sees a
  // window where they are simply not back yet. Unknown must not read as
  // absent -- that window is what made the hub's setup banner flash on
  // every visit to the home tab.
  it("is pending while a file body has not been read yet", () => {
    expect(setupProgress({ ...NOTHING_DONE, agentFileBody: undefined }).pending).toBe(true);
    expect(setupProgress({ ...NOTHING_DONE, prdBody: undefined }).pending).toBe(true);
  });

  it("is settled once both bodies are read, absent included", () => {
    expect(setupProgress({ ...NOTHING_DONE, agentFileBody: null, prdBody: null }).pending).toBe(
      false
    );
  });

  it("is settled without a root, since no read can change the answer", () => {
    const p = setupProgress({
      ...NOTHING_DONE,
      hasRoot: false,
      agentFileBody: undefined,
      prdBody: undefined,
    });
    expect(p.pending).toBe(false);
    expect(p.next).toBe("agent");
  });

  it("is never complete without a root", () => {
    const p = setupProgress({ ...NOTHING_DONE, hasRoot: false, configCommand: "claude" });
    expect(p.complete).toBe(false);
    expect(p.done).toEqual([]);
  });
});

describe("applyPrdSections", () => {
  it("replaces only the sections given", () => {
    const out = applyPrdSections(TEMPLATE, { vision: "A terminal workspace.", focus: "", outOfScope: "" });
    expect(out).toContain("A terminal workspace.");
    expect(out).not.toContain(PRD_PLACEHOLDERS.vision);
    expect(out).toContain(PRD_PLACEHOLDERS.focus);
    expect(out).toContain(PRD_PLACEHOLDERS.outOfScope);
  });

  it("ignores whitespace-only values", () => {
    expect(applyPrdSections(TEMPLATE, { vision: "   ", focus: "", outOfScope: "" })).toBe(TEMPLATE);
  });

  it("leaves an already-filled section alone rather than duplicating", () => {
    const once = applyPrdSections(TEMPLATE, { vision: "First.", focus: "", outOfScope: "" });
    const twice = applyPrdSections(once, { vision: "Second.", focus: "", outOfScope: "" });
    expect(twice).toBe(once);
  });

  it("preserves everything outside the placeholder lines", () => {
    const out = applyPrdSections(TEMPLATE, { vision: "V", focus: "F", outOfScope: "O" });
    expect(out).toContain("# ws — Product Requirements");
    expect(out).toContain("## Current focus");
  });
});

describe("agentFlowAvailable", () => {
  it("is true only for a profile with a verified prompt argument", () => {
    expect(agentFlowAvailable({ promptArgs: "" })).toBe(true);
    expect(agentFlowAvailable({ promptArgs: "--prompt=" })).toBe(true);
    expect(agentFlowAvailable({ promptArgs: null })).toBe(false);
    expect(agentFlowAvailable(undefined)).toBe(false);
  });

  // The regression this guards: `promptArgs` is a PREFIX, and the bare
  // positional's prefix is the empty string. A truthiness check would
  // hide "Ask the agent" from claude-code, codex and gemini alike --
  // three profiles where the flow has always worked.
  it("treats the empty prefix as a prompt, not as an absent one", () => {
    expect(agentFlowAvailable({ promptArgs: "" })).toBe(true);
  });
});

describe("prdHasPlaceholders", () => {
  it("is true for the untouched scaffold", () => {
    expect(prdHasPlaceholders(TEMPLATE)).toBe(true);
  });

  it("stays true while any one placeholder is left", () => {
    const twoFilled = TEMPLATE.replace(PRD_PLACEHOLDERS.vision, "V").replace(
      PRD_PLACEHOLDERS.focus,
      "F"
    );
    expect(prdHasPlaceholders(twoFilled)).toBe(true);
  });

  it("is false for a document somebody already wrote", () => {
    // The case the whole predicate exists for: the human pointed the
    // workspace at their own PRD, which never had the template's lines.
    expect(prdHasPlaceholders("# Our PRD\n\nWe are building a thing.\n")).toBe(false);
    expect(prdHasPlaceholders(applyPrdSections(TEMPLATE, { vision: "V", focus: "F", outOfScope: "O" }))).toBe(false);
  });

  it("treats an unread or absent body as still needing the form", () => {
    expect(prdHasPlaceholders(null)).toBe(true);
    expect(prdHasPlaceholders(undefined)).toBe(true);
  });
});
