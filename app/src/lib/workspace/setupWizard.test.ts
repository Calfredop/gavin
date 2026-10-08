import { describe, it, expect } from "vitest";
import {
  setupProgress,
  applyPrdSections,
  agentFlowAvailable,
  prdHasPlaceholders,
  playwrightStepDone,
  playwrightStepSettled,
  PRD_PLACEHOLDERS,
  SETUP_STEPS,
} from "$lib/workspace/setupWizard";
import type { AgentSkillsStatus } from "$lib/agents/agentSkills";
import type { HeadroomStatus } from "$lib/agents/compression";
import { SSH_UNAVAILABLE, workspaceHeadroomReading, type HeadroomReading } from "$lib/agents/headroomSetup";
import {
  SSH_MEMORY_UNAVAILABLE,
  workspaceMemoryReading,
  type MemoryIndexStatus,
  type MemoryReading,
} from "$lib/cards/memoryIndex";
import {
  SSH_PLAYWRIGHT_ELSEWHERE,
  workspacePlaywrightReading,
  type PlaywrightReading,
  type PlaywrightStatus,
} from "$lib/agents/playwrightSetup";
import { svelteSources } from "$lib/sources";

/// A settled check that found nothing: enough to keep the derivation off
/// `pending` without completing the agent skills step.
const SP_ABSENT: AgentSkillsStatus = {
  state: "absent",
  detail: "",
  command: "",
  installable: true,
  output: "",
};
const SP_FOUND: AgentSkillsStatus = { ...SP_ABSENT, state: "verified" };

function headroomStatus(over: Partial<HeadroomStatus> = {}): HeadroomStatus {
  return {
    state: "absent",
    reason: null,
    newerThanTested: false,
    version: null,
    floor: "0.38.0",
    pin: "0.39.1",
    path: null,
    source: null,
    uvFound: true,
    wanted: false,
    running: false,
    ready: false,
    port: null,
    restarts: 0,
    lastError: null,
    lifetimeTokensSaved: null,
    install: null,
    ...over,
  };
}
/// Settled readings: enough to keep the derivation off `pending`.
const HR_ABSENT: HeadroomReading = { kind: "status", status: headroomStatus() };
const HR_VERIFIED: HeadroomReading = {
  kind: "status",
  status: headroomStatus({ state: "verified", version: "0.39.1" }),
};
const HR_UNAVAILABLE: HeadroomReading = {
  kind: "status",
  status: headroomStatus({ state: "unavailable", reason: "Headroom is not available on Intel Macs yet." }),
};

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

function memStatus(over: Partial<MemoryIndexStatus>): MemoryReading {
  return {
    kind: "status",
    status: { model: "absent", modelError: null, learned: 0, indexed: 0, inSync: true, ...over },
  };
}
const MEM_ABSENT = memStatus({});
const MEM_READY = memStatus({ model: "ready", learned: 2, indexed: 2 });

function pwStatus(over: Partial<PlaywrightStatus> = {}): PlaywrightReading {
  return {
    kind: "status",
    status: {
      state: "absent",
      detail: "",
      checks: [],
      command: "npx -y @playwright/mcp@0.0.83 install-browser chromium-headless-shell",
      installable: true,
      conflict: null,
      output: "",
      ...over,
    },
  };
}
const PW_ABSENT = pwStatus();
const PW_READY = pwStatus({ state: "verified", installable: false });

const NOTHING_DONE = {
  hasRoot: true,
  configCommand: null,
  agentFileBody: null,
  prdBody: TEMPLATE,
  mainSessionId: null,
  agentSkills: SP_ABSENT,
  agentSkillsMark: undefined,
  gitTrackingAsked: false,
  requireReviewAsked: false,
  headroomReading: HR_ABSENT,
  headroomAsked: false,
  memoryReading: MEM_ABSENT,
  memorySkipped: false,
  playwright: PW_ABSENT,
  playwrightMark: undefined,
};

const ALL_DONE = {
  hasRoot: true,
  configCommand: "claude",
  agentFileBody: "<!-- gavin:start -->",
  prdBody: TEMPLATE.replace(PRD_PLACEHOLDERS.vision, "Real."),
  mainSessionId: "agent-1",
  agentSkills: SP_FOUND,
  agentSkillsMark: undefined,
  gitTrackingAsked: true,
  requireReviewAsked: true,
  headroomReading: HR_VERIFIED,
  headroomAsked: true,
  memoryReading: MEM_READY,
  memorySkipped: false,
  playwright: PW_READY,
  playwrightMark: undefined,
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
  it("puts agent skills third, Headroom fourth, Memory fifth, Playwright sixth, Git seventh and Review eighth", () => {
    // agent skills beside Integration because it is agent tooling (S2);
    // Headroom right after it, agent tooling too (the Headroom spec, "The
    // switch"); Memory after Headroom; Playwright after Memory, the last of
    // the tooling (the Playwright spec, "Init and catchup"); Git after those because it asks about the files gavin has
    // by then created; Review right after Git, the same shape of question,
    // before PRD because that step writes into a file the earlier ones
    // create.
    expect(SETUP_STEPS).toEqual([
      "agent",
      "integration",
      "agentSkills",
      "headroom",
      "memory",
      "playwright",
      "git",
      "review",
      "prd",
      "launch",
    ]);
  });

  it("counts agent skills when a check found the plugin", () => {
    const p = setupProgress({ ...NOTHING_DONE, agentSkills: SP_FOUND });
    expect(p.done).toEqual(["agentSkills"]);
  });

  it("counts agent skills on the human's word where gavin could not check", () => {
    const p = setupProgress({
      ...NOTHING_DONE,
      agentSkills: { ...SP_ABSENT, state: "asserted", installable: false },
      agentSkillsMark: "installed",
    });
    expect(p.done).toEqual(["agentSkills"]);
  });

  // S6's second route, and the reason it exists: without it, declining
  // once leaves the Home banner nagging for ever.
  it("counts agent skills as answered once it has been declined", () => {
    const p = setupProgress({ ...NOTHING_DONE, agentSkillsMark: "skipped" });
    expect(p.done).toEqual(["agentSkills"]);
  });

  // gavin failing to check is not the human deciding.
  it("does not count agent skills just because gavin cannot check it", () => {
    const p = setupProgress({
      ...NOTHING_DONE,
      agentSkills: { ...SP_ABSENT, state: "unavailable", installable: false },
    });
    expect(p.done).toEqual([]);
    expect(p.next).toBe("agent");
  });

  it("is pending while the agent skills check has not come back", () => {
    expect(setupProgress({ ...NOTHING_DONE, agentSkills: undefined }).pending).toBe(true);
  });

  // A settled marker answers on its own, so an in-flight detector that
  // cannot change the outcome must not hold the whole wizard shut.
  it("is settled by a marker even with the check still running", () => {
    const p = setupProgress({
      ...NOTHING_DONE,
      agentSkills: undefined,
      agentSkillsMark: "skipped",
    });
    expect(p.pending).toBe(false);
    expect(p.done).toEqual(["agentSkills"]);
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
    expect(SETUP_STEPS).toHaveLength(10);
  });

  // Both counters. The Home banner reads its total off SETUP_STEPS and
  // its "done" off setupProgress; the wizard draws its own labelled list,
  // which has to be the same list in the same order or the stepper and
  // `next` disagree about where Headroom is.
  it("draws the wizard's stepper from the same steps, Headroom included", () => {
    const wizard = SOURCES["SetupWizard.svelte"];
    const ids = [...wizard.matchAll(/\{ id: "([a-zA-Z]+)", label: "[^"]+" \}/g)].map((m) => m[1]);
    expect(ids).toEqual(SETUP_STEPS);
    expect(wizard).toContain('current === "headroom"');
    expect(wizard).toContain("headroomAsked: Boolean(ws?.headroomAsked)");
    const home = SOURCES["HomeHubView.svelte"];
    expect(home).toContain("{SETUP_STEPS.length}");
    expect(home).toContain("headroomAsked: Boolean(ws?.headroomAsked)");
    expect(home).toContain("headroomReading: headroom,");
    // And the Memory step, named on both surfaces.
    expect(wizard).toContain('{ id: "memory", label: "Memory" }');
    expect(wizard).toContain('current === "memory"');
    expect(wizard).toContain("<MemoryStep");
    expect(wizard).toContain("memoryReading: memory,");
    expect(wizard).toContain("memorySkipped,");
    expect(home).toContain("memoryReading: memory,");
    expect(home).toContain("memorySkipped,");
    // And Playwright's, on both.
    expect(wizard).toContain('{ id: "playwright", label: "Playwright" }');
    expect(wizard).toContain('current === "playwright"');
    expect(wizard).toContain("<PlaywrightStep");
    for (const src of [wizard, home]) {
      expect(src).toContain("playwright,");
      expect(src).toContain("playwrightMark,");
    }
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

describe("setupProgress: the Memory step", () => {
  const upToMemory = {
    ...NOTHING_DONE,
    configCommand: "claude",
    agentFileBody: "<!-- gavin:start -->",
    agentSkills: SP_FOUND,
    headroomAsked: true,
  };

  it("comes right after Headroom", () => {
    expect(setupProgress(upToMemory).next).toBe("memory");
  });

  it("counts once the model is here and the index matches Learned, empty included", () => {
    expect(setupProgress({ ...NOTHING_DONE, memoryReading: MEM_READY }).done).toEqual(["memory"]);
    const empty = memStatus({ model: "ready" });
    expect(setupProgress({ ...NOTHING_DONE, memoryReading: empty }).done).toEqual(["memory"]);
  });

  // A model with a stale index is not done: the step is where it is
  // brought up, and a fact adopted since is one search would miss.
  it("does not count with no model, a download running, or a stale index", () => {
    for (const memory of [
      MEM_ABSENT,
      memStatus({ model: "downloading" }),
      memStatus({ model: "failed", modelError: "offline" }),
      memStatus({ model: "ready", learned: 3, indexed: 2, inSync: false }),
    ]) {
      expect(setupProgress({ ...upToMemory, memoryReading: memory }).done).not.toContain("memory");
    }
  });

  // "Not now" is a recorded answer, not a fake "installed": the reading
  // still says absent, and only the mark finishes the step.
  it("counts on the human's not now, whatever the reading", () => {
    const p = setupProgress({ ...upToMemory, memoryReading: MEM_ABSENT, memorySkipped: true });
    expect(p.done).toContain("memory");
    expect(p.next).toBe("playwright");
  });

  it("counts on its own where the index cannot serve the workspace", () => {
    const ssh = workspaceMemoryReading(MEM_ABSENT, { ssh: { host: "box" } });
    expect(ssh).toEqual({ kind: "unavailable", reason: SSH_MEMORY_UNAVAILABLE });
    expect(setupProgress({ ...upToMemory, memoryReading: ssh }).done).toContain("memory");
    expect(workspaceMemoryReading(MEM_ABSENT, null)).toBe(MEM_ABSENT);
  });

  it("is pending while the reading has not landed, unless the human already declined", () => {
    expect(setupProgress({ ...upToMemory, memoryReading: undefined }).pending).toBe(true);
    const declined = setupProgress({ ...upToMemory, memoryReading: undefined, memorySkipped: true });
    expect(declined.pending).toBe(false);
    expect(declined.done).toContain("memory");
  });

  it("settles on a failed ask and on a daemon too old to ask, without counting either", () => {
    for (const memory of [
      { kind: "error", message: "gone" } as MemoryReading,
      { kind: "blocked", reason: "Needs daemon v60" } as MemoryReading,
    ]) {
      const p = setupProgress({ ...upToMemory, memoryReading: memory });
      expect(p.pending).toBe(false);
      expect(p.done).not.toContain("memory");
    }
  });

  // Outside the nag, like Headroom: no index is a workspace whose agents
  // read `### Learned` as they always did.
  it("never makes the Home banner nag", () => {
    const p = setupProgress({ ...ALL_DONE, memoryReading: MEM_ABSENT });
    expect(p.configured).toBe(true);
    expect(p.complete).toBe(false);
  });
});

describe("setupProgress: the Playwright step", () => {
  const upToPlaywright = {
    ...NOTHING_DONE,
    configCommand: "claude",
    agentFileBody: "<!-- gavin:start -->",
    agentSkills: SP_FOUND,
    headroomAsked: true,
    memoryReading: MEM_READY,
  };

  it("comes right after Memory", () => {
    expect(setupProgress(upToPlaywright).next).toBe("playwright");
  });

  it("counts once the three checks found it set up", () => {
    expect(setupProgress({ ...NOTHING_DONE, playwright: PW_READY }).done).toEqual(["playwright"]);
  });

  // gavin unable to look -- a custom agent, an unreadable MCP config -- is
  // not the human deciding, and a failed ask is not a check that passed.
  it("does not count on a missing piece, on gavin unable to look, or on a failed ask", () => {
    for (const playwright of [
      PW_ABSENT,
      pwStatus({ state: "unavailable", installable: false }),
      { kind: "error", message: "gone" } as PlaywrightReading,
    ]) {
      expect(setupProgress({ ...upToPlaywright, playwright }).done).not.toContain("playwright");
    }
  });

  // "Not now" is a recorded answer, not a fake "installed": the reading
  // still says absent, and only the mark finishes the step.
  it("counts on the human's not now, whatever the reading", () => {
    const p = setupProgress({ ...upToPlaywright, playwright: PW_ABSENT, playwrightMark: "skipped" });
    expect(p.done).toContain("playwright");
    expect(p.next).toBe("git");
  });

  it("counts on the human's word where gavin could not check", () => {
    const unchecked = pwStatus({ state: "unavailable", installable: false });
    expect(setupProgress({ ...upToPlaywright, playwright: unchecked, playwrightMark: "installed" }).done).toContain(
      "playwright"
    );
  });

  it("counts on its own where the step cannot serve the workspace from here", () => {
    const ssh = workspacePlaywrightReading(PW_ABSENT, { ssh: { host: "box" } });
    expect(ssh).toEqual({ kind: "elsewhere", reason: SSH_PLAYWRIGHT_ELSEWHERE });
    expect(setupProgress({ ...upToPlaywright, playwright: ssh }).done).toContain("playwright");
    expect(workspacePlaywrightReading(PW_ABSENT, null)).toBe(PW_ABSENT);
  });

  it("is pending while the checks have not answered, unless the human already did", () => {
    expect(setupProgress({ ...upToPlaywright, playwright: undefined }).pending).toBe(true);
    const declined = setupProgress({ ...upToPlaywright, playwright: undefined, playwrightMark: "skipped" });
    expect(declined.pending).toBe(false);
    expect(declined.done).toContain("playwright");
  });

  it("settles on a failed ask without counting it", () => {
    const p = setupProgress({ ...upToPlaywright, playwright: { kind: "error", message: "gone" } });
    expect(p.pending).toBe(false);
    expect(p.done).not.toContain("playwright");
  });

  // Inside the nag, unlike Headroom and Memory: a workspace that existed
  // before the step -- every other step done -- is asked once by the Home
  // banner, and "not now" ends it.
  it("makes the Home banner ask a workspace set up before it existed, until answered", () => {
    const before = { ...ALL_DONE, playwright: PW_ABSENT };
    expect(setupProgress(before).configured).toBe(false);
    expect(setupProgress(before).next).toBe("playwright");
    expect(setupProgress({ ...before, playwrightMark: "skipped" }).configured).toBe(true);
    expect(setupProgress({ ...before, playwright: PW_READY }).configured).toBe(true);
  });

  it("is done and settled by the same rules on their own", () => {
    expect(playwrightStepDone(undefined, undefined)).toBe(false);
    expect(playwrightStepDone(undefined, "skipped")).toBe(true);
    expect(playwrightStepDone(PW_READY, undefined)).toBe(true);
    expect(playwrightStepSettled(undefined, undefined)).toBe(false);
    expect(playwrightStepSettled(PW_ABSENT, undefined)).toBe(true);
    expect(playwrightStepSettled(undefined, "installed")).toBe(true);
  });
});

describe("setupProgress: the Headroom step", () => {
  const upToHeadroom = { ...NOTHING_DONE, configCommand: "claude", agentFileBody: "<!-- gavin:start -->", agentSkills: SP_FOUND };

  it("comes right after agent skills", () => {
    expect(setupProgress(upToHeadroom).next).toBe("headroom");
  });

  it("counts once the question has been put, whichever way it was answered", () => {
    for (const headroom of [HR_ABSENT, HR_VERIFIED]) {
      expect(setupProgress({ ...NOTHING_DONE, headroomReading: headroom, headroomAsked: true }).done).toEqual(["headroom"]);
    }
  });

  // Verified is not an answer: it is a Headroom the human could turn on,
  // and the step is where they are asked whether to.
  it("does not count while nobody has been asked, installed or not", () => {
    for (const headroom of [HR_ABSENT, HR_VERIFIED]) {
      expect(setupProgress({ ...upToHeadroom, headroomReading: headroom }).done).not.toContain("headroom");
    }
  });

  it("counts on its own where Headroom cannot serve the workspace: nothing to ask", () => {
    expect(setupProgress({ ...upToHeadroom, headroomReading: HR_UNAVAILABLE }).done).toContain("headroom");
    const ssh = workspaceHeadroomReading(HR_VERIFIED, { ssh: { host: "box" } });
    expect(ssh).toEqual({ kind: "unavailable", reason: SSH_UNAVAILABLE });
    expect(setupProgress({ ...upToHeadroom, headroomReading: ssh }).done).toContain("headroom");
    expect(workspaceHeadroomReading(HR_VERIFIED, { ssh: undefined })).toBe(HR_VERIFIED);
  });

  // The setupProgress trap: a reading still in flight is not a Headroom
  // that is missing. Read as absent, it opens the wizard on this step
  // with an Install button for a Headroom that may well be there.
  it("is pending, not absent, while the reading has not landed", () => {
    const p = setupProgress({ ...upToHeadroom, headroomReading: undefined });
    expect(p.pending).toBe(true);
    expect(p.done).not.toContain("headroom");
  });

  it("is settled by a recorded answer even with the reading still out", () => {
    const p = setupProgress({ ...upToHeadroom, headroomReading: undefined, headroomAsked: true });
    expect(p.pending).toBe(false);
    expect(p.done).toContain("headroom");
  });

  // Both of these settle: a wizard that waited on them would never open.
  // Neither is an answer, so neither finishes the step.
  it("settles on a failed ask and on a daemon too old to ask, without counting either", () => {
    const failed: HeadroomReading = { kind: "error", message: "the daemon went away" };
    const old: HeadroomReading = { kind: "blocked", reason: "Needs daemon v46" };
    for (const headroom of [failed, old]) {
      const p = setupProgress({ ...upToHeadroom, headroomReading: headroom });
      expect(p.pending).toBe(false);
      expect(p.done).not.toContain("headroom");
      expect(p.next).toBe("headroom");
    }
  });

  // Off is the default and a workspace set up as it always was, so an
  // unanswered Headroom question is no reason for the Home banner to nag.
  it("leaves a workspace configured with the question unanswered", () => {
    const p = setupProgress({ ...ALL_DONE, headroomReading: HR_ABSENT, headroomAsked: false });
    expect(p.configured).toBe(true);
    expect(p.complete).toBe(false);
    expect(p.next).toBe("headroom");
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
