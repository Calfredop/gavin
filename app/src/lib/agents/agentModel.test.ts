import { describe, it, expect } from "vitest";
import {
  commandSpecifiesModel,
  composeLaunchCommand,
  mergeDiscoveredModels,
  modelOptions,
  CUSTOM_MODEL,
} from "$lib/agents/agentModel";

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

  it("quotes a model a shell would read as something else", () => {
    // `[1m]` is a glob character class. Unquoted, and in a checkout that
    // happens to hold a file called `sonnetm`, /bin/sh hands the agent
    // `--model sonnetm` -- a model nobody chose, on one machine, with no
    // error anywhere.
    expect(composeLaunchCommand("claude", "--model", "sonnet[1m]")).toBe(
      "claude --model 'sonnet[1m]'"
    );
    expect(composeLaunchCommand("claude", "--model", "opus[1m]")).toBe(
      "claude --model 'opus[1m]'"
    );
  });

  it("leaves an ordinary name bare", () => {
    // The composed line is shown to the human in Settings, so quoting
    // what needs no quoting is noise. Every stable alias and every
    // `provider/model` opencode prints is inert as written.
    expect(composeLaunchCommand("claude", "--model", "opusplan")).toBe("claude --model opusplan");
    expect(composeLaunchCommand("gemini", "--model", "flash-lite")).toBe(
      "gemini --model flash-lite"
    );
    expect(composeLaunchCommand("opencode", "--model", "google/gemini-2.5-pro")).toBe(
      "opencode --model google/gemini-2.5-pro"
    );
  });

  it("survives a quote inside the name", () => {
    // Nothing legitimate spells a model this way; a hand-typed Custom
    // model is a text box, and a text box eventually gets a quote in it.
    expect(composeLaunchCommand("claude", "--model", "a'b")).toBe("claude --model 'a'\\''b'");
  });
});

describe("mergeDiscoveredModels", () => {
  const profiles = [
    { id: "claude-code", models: ["opus", "sonnet"] },
    { id: "opencode", models: [] as string[] },
  ];

  it("appends what the host discovered behind the verified aliases", () => {
    // Aliases lead because they cannot go stale; the discovered names
    // follow in the order the agent itself listed them.
    expect(mergeDiscoveredModels(profiles, { opencode: ["a/one", "b/two"] })).toEqual([
      { id: "claude-code", models: ["opus", "sonnet"] },
      { id: "opencode", models: ["a/one", "b/two"] },
    ]);
  });

  it("never lists a name twice", () => {
    expect(
      mergeDiscoveredModels(profiles, { "claude-code": ["sonnet", "claude-opus-5"] })[0].models
    ).toEqual(["opus", "sonnet", "claude-opus-5"]);
  });

  it("returns the very same rows when there is nothing to add", () => {
    // The bootstrap applies this unconditionally, and every consumer is
    // a Svelte store: a merge that rebuilt untouched rows would republish
    // the whole table for a catalogue that answered nothing.
    const catalogs: Record<string, string[]>[] = [
      {},
      { opencode: [] },
      { opencode: ["  "] },
      { nobody: ["x/y"] },
    ];
    for (const catalog of catalogs) {
      const merged = mergeDiscoveredModels(profiles, catalog);
      expect(merged[0]).toBe(profiles[0]);
      expect(merged[1]).toBe(profiles[1]);
    }
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
