import { describe, it, expect } from "vitest";
import { API_FAMILIES, apiFamilyOf, withApiFamily } from "./apiFamily";
import { EMPTY_AGENT_DEFAULTS } from "$lib/cards/complexity";

describe("apiFamilyOf", () => {
  it("reads none from empty defaults", () => {
    expect(apiFamilyOf(EMPTY_AGENT_DEFAULTS)).toBe("");
  });

  it("reads the family from a named custom profile", () => {
    const defaults = {
      ...EMPTY_AGENT_DEFAULTS,
      customProfiles: [
        {
          id: "custom-agent",
          label: "Custom",
          command: "my-agent",
          modelFlag: "--llm",
          apiFamily: "anthropic",
        },
      ],
    };
    expect(apiFamilyOf(defaults, "custom-agent")).toBe("anthropic");
    expect(apiFamilyOf(defaults)).toBe("anthropic");
  });

  it("falls back to the legacy customApiFamily field", () => {
    expect(apiFamilyOf({ customApiFamily: "openai" })).toBe("openai");
    expect(apiFamilyOf({ customApiFamily: " openai " })).toBe("openai");
  });

  it("treats an unknown word as none", () => {
    expect(apiFamilyOf({ customApiFamily: "gemini" })).toBe("");
    expect(apiFamilyOf({ customApiFamily: "" })).toBe("");
  });
});

describe("withApiFamily", () => {
  it("writes the family onto the named custom profile", () => {
    const defaults = {
      ...EMPTY_AGENT_DEFAULTS,
      customProfiles: [
        { id: "custom-agent", label: "Custom", command: "my-agent", modelFlag: "--llm", apiFamily: "" },
      ],
    };
    const chosen = withApiFamily(defaults, "openai", "custom-agent");
    expect(chosen.customProfiles?.[0].apiFamily).toBe("openai");
    expect(apiFamilyOf(chosen, "custom-agent")).toBe("openai");
    expect("customApiFamily" in chosen).toBe(false);
  });

  it("clears the family from the profile when set to none", () => {
    const defaults = {
      ...EMPTY_AGENT_DEFAULTS,
      customProfiles: [
        {
          id: "custom-agent",
          label: "Custom",
          command: "my-agent",
          modelFlag: "",
          apiFamily: "anthropic",
        },
      ],
    };
    const chosen = withApiFamily(defaults, "", "custom-agent");
    expect(chosen.customProfiles?.[0].apiFamily).toBeUndefined();
  });

  it("still writes the legacy field when there are no custom profiles", () => {
    const defaults = { ...EMPTY_AGENT_DEFAULTS, customCommand: "my-agent", customModelFlag: "--llm" };
    const chosen = withApiFamily(defaults, "openai");
    expect(chosen).toEqual({ ...defaults, customApiFamily: "openai" });
    expect(apiFamilyOf(chosen)).toBe("openai");
  });
});

describe("API_FAMILIES", () => {
  it("lists none first", () => {
    expect(API_FAMILIES[0].value).toBe("");
  });
});
