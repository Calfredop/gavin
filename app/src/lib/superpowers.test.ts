import { describe, it, expect } from "vitest";
import {
  superpowersDone,
  superpowersLed,
  showsInstallButton,
  showsCopyCommand,
  showsAssertButton,
  superpowersLabel,
  UNKNOWN_STATUS,
  type SuperpowersStatus,
  type SuperpowersState,
} from "./superpowers";

function status(over: Partial<SuperpowersStatus> = {}): SuperpowersStatus {
  return {
    state: "absent",
    detail: "",
    command: "claude plugin install superpowers@claude-plugins-official --scope project -y",
    installable: true,
    output: "",
    ...over,
  };
}

const ALL_STATES: SuperpowersState[] = ["verified", "asserted", "absent", "unavailable"];

describe("superpowersDone", () => {
  it("counts a check that found the plugin", () => {
    expect(superpowersDone(status({ state: "verified" }), undefined)).toBe(true);
  });

  it("counts the human's word where gavin could not check", () => {
    expect(superpowersDone(status({ state: "asserted", installable: false }), "installed")).toBe(
      true
    );
  });

  // S6's whole point: without this route, declining once leaves the Home
  // banner nagging for ever.
  it("counts a declined step, which is not the same as an installed one", () => {
    expect(superpowersDone(status({ state: "absent" }), "skipped")).toBe(true);
  });

  it("does not count an absent plugin nobody has answered for", () => {
    expect(superpowersDone(status({ state: "absent" }), undefined)).toBe(false);
  });

  // gavin failing to check is not the human deciding. Treating it as one
  // would silently finish the step for every Cursor and Codex workspace
  // before its owner had seen the explainer.
  it("does not count gavin's inability to check as an answer", () => {
    expect(superpowersDone(status({ state: "unavailable", installable: false }), undefined)).toBe(
      false
    );
  });

  it("does not count a status that has not arrived yet", () => {
    expect(superpowersDone(undefined, undefined)).toBe(false);
  });
});

describe("superpowersLed", () => {
  it("separates a check from a claim", () => {
    expect(superpowersLed("verified")).toBe("on");
    expect(superpowersLed("asserted")).toBe("claimed");
  });

  it("separates a negative check from no check at all", () => {
    expect(superpowersLed("absent")).toBe("off");
    expect(superpowersLed("unavailable")).toBe("unknown");
  });

  // The regression this guards: rendering both believed-present states
  // the same way, which turns the human's word into a result.
  it("gives every state its own value", () => {
    const seen = ALL_STATES.map(superpowersLed);
    expect(new Set(seen).size).toBe(ALL_STATES.length);
  });
});

describe("showsInstallButton", () => {
  it("shows only when the plugin is absent", () => {
    expect(showsInstallButton(status({ state: "absent" }))).toBe(true);
    for (const state of ["verified", "asserted", "unavailable"] as const) {
      expect(showsInstallButton(status({ state }))).toBe(false);
    }
  });

  // A button gavin cannot honour is a button that can only fail. Gemini
  // reaches this branch with a real, documented command it must not run.
  it("never offers to run a command gavin must not run", () => {
    expect(
      showsInstallButton(
        status({ state: "absent", installable: false, command: "gemini extensions install …" })
      )
    ).toBe(false);
  });
});

describe("showsCopyCommand", () => {
  it("offers the paste-able instruction where gavin cannot install", () => {
    expect(
      showsCopyCommand(status({ state: "absent", installable: false, command: "/plugins" }))
    ).toBe(true);
  });

  // `unavailable` means gavin cannot CHECK. That is no reason to withhold
  // the instructions — those two are different failures.
  it("still offers it when gavin cannot even check", () => {
    expect(
      showsCopyCommand(
        status({ state: "unavailable", installable: false, command: "/add-plugin superpowers" })
      )
    ).toBe(true);
  });

  it("stays out of the way once the plugin is believed present", () => {
    for (const state of ["verified", "asserted"] as const) {
      expect(showsCopyCommand(status({ state, installable: false, command: "/plugins" }))).toBe(
        false
      );
    }
  });

  it("shows nothing for a profile with no known instruction at all", () => {
    expect(showsCopyCommand(status({ state: "unavailable", installable: false, command: "" }))).toBe(
      false
    );
  });

  it("does not duplicate the install button", () => {
    expect(showsCopyCommand(status({ state: "absent", installable: true }))).toBe(false);
  });
});

describe("showsAssertButton", () => {
  it("offers the manual route wherever a check has not found the plugin", () => {
    for (const state of ["absent", "unavailable"] as const) {
      expect(showsAssertButton(status({ state }), undefined)).toBe(true);
    }
  });

  it("adds nothing once a check has found it", () => {
    expect(showsAssertButton(status({ state: "verified" }), undefined)).toBe(false);
  });

  it("adds nothing once the human has already said so", () => {
    expect(showsAssertButton(status({ state: "asserted" }), "installed")).toBe(false);
  });

  // "Not now" is not "installed": someone who deferred must still be able
  // to come back and say they did it.
  it("stays available to someone who only deferred", () => {
    expect(showsAssertButton(status({ state: "absent" }), "skipped")).toBe(true);
  });
});

describe("superpowersLabel", () => {
  it("never labels an unchecked state as a found one", () => {
    expect(superpowersLabel("verified")).toBe("Superpowers plugin");
    expect(superpowersLabel("asserted")).toContain("your word");
    expect(superpowersLabel("absent")).toContain("not installed");
    expect(superpowersLabel("unavailable")).toContain("not checked");
  });
});

describe("UNKNOWN_STATUS", () => {
  // A workspace with no root has nothing to install into, so the
  // placeholder must not be a fabricated `absent` with a live button.
  it("offers no install button before a root is bound", () => {
    expect(showsInstallButton(UNKNOWN_STATUS)).toBe(false);
    expect(showsCopyCommand(UNKNOWN_STATUS)).toBe(false);
    expect(superpowersDone(UNKNOWN_STATUS, undefined)).toBe(false);
  });
});
