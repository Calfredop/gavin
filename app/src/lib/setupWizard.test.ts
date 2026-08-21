import { describe, it, expect } from "vitest";
import {
  setupProgress,
  applyPrdSections,
  agentFlowAvailable,
  PRD_PLACEHOLDERS,
} from "./setupWizard";

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
};

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

  it("counts launch from the session id, and completes at four", () => {
    const p = setupProgress({
      hasRoot: true,
      configCommand: "claude",
      agentFileBody: "<!-- gavin:start -->",
      prdBody: TEMPLATE.replace(PRD_PLACEHOLDERS.vision, "Real."),
      mainSessionId: "agent-1",
    });
    expect(p.done).toEqual(["agent", "integration", "prd", "launch"]);
    expect(p.next).toBeNull();
    expect(p.complete).toBe(true);
  });

  it("next skips steps already done out of order", () => {
    const p = setupProgress({ ...NOTHING_DONE, mainSessionId: "agent-1" });
    expect(p.done).toEqual(["launch"]);
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
    expect(agentFlowAvailable({ promptArg: true })).toBe(true);
    expect(agentFlowAvailable({ promptArg: false })).toBe(false);
    expect(agentFlowAvailable(undefined)).toBe(false);
  });
});
