import { describe, it, expect } from "vitest";
import {
  commandSpecifiesModel,
  composeLaunchCommand,
  modelOptions,
  CUSTOM_MODEL,
} from "./agentModel";

describe("commandSpecifiesModel", () => {
  it("finds the flag as a whole token, in every spelling", () => {
    expect(commandSpecifiesModel("claude --model opus", "--model")).toBe(true);
    expect(commandSpecifiesModel("claude --model=opus", "--model")).toBe(true);
    expect(commandSpecifiesModel("gemini -m gemini-flash-latest", "--model")).toBe(true);
    expect(commandSpecifiesModel("opencode -m=x", "--model")).toBe(true);
  });

  it("is not fooled by a substring", () => {
    // The bug a naive includes() would ship: a command that merely
    // CONTAINS the letters would suppress the flag entirely, and the
    // user's chosen model would silently never reach the agent.
    expect(commandSpecifiesModel("claude --modelling", "--model")).toBe(false);
    expect(commandSpecifiesModel("run --dry-model", "--model")).toBe(false);
    expect(commandSpecifiesModel("claude", "--model")).toBe(false);
  });

  it("says no when the profile has no flag at all", () => {
    expect(commandSpecifiesModel("cursor --model x", "")).toBe(false);
  });
});

describe("composeLaunchCommand", () => {
  it("appends the flag and the model", () => {
    expect(composeLaunchCommand("claude", "--model", "opus")).toBe("claude --model opus");
  });

  it("leaves the command alone when there is nothing to add", () => {
    expect(composeLaunchCommand("claude", "--model", "")).toBe("claude");
    expect(composeLaunchCommand("claude", "--model", "   ")).toBe("claude");
    expect(composeLaunchCommand("cursor", "", "opus")).toBe("cursor");
  });

  it("defers to a model the command already names", () => {
    // What the user typed by hand is the more specific statement of
    // intent, and two --model flags is an argv error, not a preference.
    expect(composeLaunchCommand("claude --model sonnet", "--model", "opus")).toBe(
      "claude --model sonnet"
    );
    expect(composeLaunchCommand("gemini -m x", "--model", "opus")).toBe("gemini -m x");
  });

  it("trims the model", () => {
    expect(composeLaunchCommand("claude", "--model", "  opus  ")).toBe("claude --model opus");
  });
});

describe("modelOptions", () => {
  const claude = { modelFlag: "--model", models: ["fable", "opus", "sonnet"] };
  const gemini = { modelFlag: "--model", models: [] };
  const cursor = { modelFlag: "", models: [] };

  it("leads with an inherit row that names what it inherits", () => {
    expect(modelOptions(claude, "opus")[0]).toEqual({ value: "", label: "Default (opus)" });
    expect(modelOptions(claude, "")[0]).toEqual({ value: "", label: "(unset)" });
  });

  it("offers every preset, then Custom", () => {
    expect(modelOptions(claude, "").map((o) => o.value)).toEqual([
      "",
      "fable",
      "opus",
      "sonnet",
      CUSTOM_MODEL,
    ]);
  });

  it("offers Custom alone for a profile with no presets", () => {
    expect(modelOptions(gemini, "").map((o) => o.value)).toEqual(["", CUSTOM_MODEL]);
  });

  it("offers nothing at all for a profile with no flag", () => {
    // The panel renders a hint instead: gavin has no verified way to put
    // a model on this command, so it must not pretend otherwise.
    expect(modelOptions(cursor, "")).toEqual([]);
  });
});
