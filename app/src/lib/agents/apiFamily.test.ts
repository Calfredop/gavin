import { describe, it, expect } from "vitest";
import { API_FAMILIES, apiFamilyOf, withApiFamily } from "./apiFamily";
import { EMPTY_AGENT_DEFAULTS } from "$lib/cards/complexity";

describe("the custom agent's API family", () => {
  it("defaults to None", () => {
    expect(apiFamilyOf(EMPTY_AGENT_DEFAULTS)).toBe("");
    expect(API_FAMILIES[0]).toEqual({ value: "", label: "None" });
  });

  it("offers the two families the daemon has a recipe for, and None", () => {
    expect(API_FAMILIES.map((row) => row.value)).toEqual(["", "anthropic", "openai"]);
    expect(API_FAMILIES.map((row) => row.label)).toEqual(["None", "Anthropic", "OpenAI-compatible"]);
  });

  it("reads what was stored", () => {
    expect(apiFamilyOf({ customApiFamily: "anthropic" })).toBe("anthropic");
    expect(apiFamilyOf({ customApiFamily: "openai" })).toBe("openai");
    expect(apiFamilyOf({ customApiFamily: " openai " })).toBe("openai");
  });

  // A newer build sharing config.json may have written a family this one
  // does not know. The daemon reads it as none, so the picker must too.
  it("reads a word it does not know as None", () => {
    expect(apiFamilyOf({ customApiFamily: "gemini" })).toBe("");
    expect(apiFamilyOf({ customApiFamily: "" })).toBe("");
  });

  it("persists a choice through the defaults it is saved with", () => {
    const defaults = { ...EMPTY_AGENT_DEFAULTS, customCommand: "my-agent", customModelFlag: "--llm" };

    const chosen = withApiFamily(defaults, "openai");

    expect(chosen).toEqual({ ...defaults, customApiFamily: "openai" });
    expect(apiFamilyOf(chosen)).toBe("openai");
    // Nothing else of the custom agent moves.
    expect(chosen.customCommand).toBe("my-agent");
    expect(chosen.customModelFlag).toBe("--llm");
  });

  // None is no key, the way the host stores it and hands it back: the
  // defaults round-trip through `setAgentDefaults` unchanged.
  it("writes None as no key at all", () => {
    const chosen = withApiFamily({ ...EMPTY_AGENT_DEFAULTS, customApiFamily: "anthropic" }, "");

    expect("customApiFamily" in chosen).toBe(false);
    expect(chosen).toEqual(EMPTY_AGENT_DEFAULTS);
  });
});
