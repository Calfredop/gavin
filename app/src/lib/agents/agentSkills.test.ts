import { describe, it, expect } from "vitest";
import {
  agentSkillsDone,
  agentSkillsLed,
  showsInstallButton,
  showsCopyCommand,
  showsAssertButton,
  agentSkillsLabel,
  FAREWELL_NOTE,
  UNKNOWN_STATUS,
  type AgentSkillsStatus,
  type AgentSkillsState,
} from "$lib/agents/agentSkills";

function status(over: Partial<AgentSkillsStatus> = {}): AgentSkillsStatus {
  return {
    state: "absent",
    detail: "",
    command: "claude plugin install mattpocock-skills --scope project -y",
    installable: true,
    output: "",
    ...over,
  };
}

/// A custom agent: gavin can neither check nor install, and offers the
/// interactive command instead.
function custom(over: Partial<AgentSkillsStatus> = {}): AgentSkillsStatus {
  return status({
    state: "unavailable",
    installable: false,
    command: "npx skills@latest add mattpocock/skills",
    ...over,
  });
}

const ALL_STATES: AgentSkillsState[] = ["verified", "asserted", "absent", "unavailable"];

describe("agentSkillsDone", () => {
  it("counts a check that found the skills", () => {
    expect(agentSkillsDone(status({ state: "verified" }), undefined)).toBe(true);
  });

  it("counts the human's word where gavin could not check", () => {
    expect(agentSkillsDone(custom({ state: "asserted" }), "installed")).toBe(true);
  });

  // Without this route, declining once leaves the Home banner nagging for
  // ever.
  it("counts a declined step, which is not the same as an installed one", () => {
    expect(agentSkillsDone(status({ state: "absent" }), "skipped")).toBe(true);
  });

  it("does not count absent skills nobody has answered for", () => {
    expect(agentSkillsDone(status({ state: "absent" }), undefined)).toBe(false);
  });

  // gavin failing to check is not the human deciding. Treating it as one
  // would silently finish the step for every custom-agent workspace
  // before its owner had seen the explainer.
  it("does not count gavin's inability to check as an answer", () => {
    expect(agentSkillsDone(custom(), undefined)).toBe(false);
  });

  it("does not count a status that has not arrived yet", () => {
    expect(agentSkillsDone(undefined, undefined)).toBe(false);
  });
});

describe("agentSkillsLed", () => {
  it("separates a check from a claim", () => {
    expect(agentSkillsLed("verified")).toBe("on");
    expect(agentSkillsLed("asserted")).toBe("claimed");
  });

  it("separates a negative check from no check at all", () => {
    expect(agentSkillsLed("absent")).toBe("off");
    expect(agentSkillsLed("unavailable")).toBe("unknown");
  });

  // The regression this guards: rendering both believed-present states
  // the same way, which turns the human's word into a result.
  it("gives every state its own value", () => {
    const seen = ALL_STATES.map(agentSkillsLed);
    expect(new Set(seen).size).toBe(ALL_STATES.length);
  });
});

describe("showsInstallButton", () => {
  it("shows only when the skills are absent", () => {
    expect(showsInstallButton(status({ state: "absent" }))).toBe(true);
    for (const state of ["verified", "asserted", "unavailable"] as const) {
      expect(showsInstallButton(status({ state }))).toBe(false);
    }
  });

  // Every skills-CLI agent is installable, not only Claude Code.
  it("offers it for a skills CLI agent too", () => {
    expect(
      showsInstallButton(
        status({ command: "npx -y skills@latest add mattpocock/skills --skill '*' -a codex -y" })
      )
    ).toBe(true);
  });

  it("never offers to run a command gavin cannot run", () => {
    expect(showsInstallButton(custom({ state: "absent" }))).toBe(false);
  });
});

describe("showsCopyCommand", () => {
  // `unavailable` means gavin cannot CHECK. That is no reason to withhold
  // the instructions — those two are different failures.
  it("offers the command to run yourself for a custom agent", () => {
    expect(showsCopyCommand(custom())).toBe(true);
  });

  it("stays out of the way once the skills are believed present", () => {
    for (const state of ["verified", "asserted"] as const) {
      expect(showsCopyCommand(custom({ state }))).toBe(false);
    }
  });

  it("shows nothing when there is no command at all", () => {
    expect(showsCopyCommand(custom({ command: "" }))).toBe(false);
  });

  it("does not duplicate the install button", () => {
    expect(showsCopyCommand(status({ state: "absent", installable: true }))).toBe(false);
  });
});

describe("showsAssertButton", () => {
  it("offers the manual route for a custom agent gavin cannot check", () => {
    expect(showsAssertButton(custom(), undefined)).toBe(true);
  });

  // For a known agent the evidence is machine-true; a word could only
  // paper over a check that says otherwise.
  it("never offers it where gavin has a detector", () => {
    for (const state of ALL_STATES) {
      expect(showsAssertButton(status({ state }), undefined)).toBe(false);
    }
  });

  it("adds nothing once a check has found it", () => {
    expect(showsAssertButton(custom({ state: "verified" }), undefined)).toBe(false);
  });

  it("adds nothing once the human has already said so", () => {
    expect(showsAssertButton(custom({ state: "asserted" }), "installed")).toBe(false);
  });

  // "Not now" is not "installed": someone who deferred must still be able
  // to come back and say they did it.
  it("stays available to someone who only deferred", () => {
    expect(showsAssertButton(custom(), "skipped")).toBe(true);
  });
});

describe("agentSkillsLabel", () => {
  it("names the product and never labels an unchecked state as a found one", () => {
    expect(agentSkillsLabel("verified")).toBe("Matt Pocock's skills");
    expect(agentSkillsLabel("asserted")).toContain("your word");
    expect(agentSkillsLabel("absent")).toContain("not installed");
    expect(agentSkillsLabel("unavailable")).toContain("not checked");
  });
});

describe("FAREWELL_NOTE", () => {
  // The install is the human's own: the note says gavin moved on, and
  // leaves the plugin to them.
  it("names both products and leaves the old one to its owner", () => {
    expect(FAREWELL_NOTE).toContain("Matt Pocock's skills");
    expect(FAREWELL_NOTE).toContain("Superpowers");
    expect(FAREWELL_NOTE).toMatch(/keep or remove/);
  });
});

describe("UNKNOWN_STATUS", () => {
  // A workspace with no root has nothing to install into, so the
  // placeholder must not be a fabricated `absent` with a live button.
  it("offers no install button before a root is bound", () => {
    expect(showsInstallButton(UNKNOWN_STATUS)).toBe(false);
    expect(showsCopyCommand(UNKNOWN_STATUS)).toBe(false);
    expect(agentSkillsDone(UNKNOWN_STATUS, undefined)).toBe(false);
  });
});
