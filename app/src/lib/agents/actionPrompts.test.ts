import { describe, expect, it } from "vitest";
import {
  ACTION_PROMPTS,
  applyToolBodyOverrides,
  bodySource,
  effectiveBody,
  fillTemplate,
  pruneOverrides,
  resolveActionPrompt,
  withOverride,
} from "./actionPrompts";
import { BUILTIN_TOOLS } from "$lib/orchestration/orchestrationTools";

describe("fillTemplate", () => {
  it("substitutes declared values and leaves unknowns", () => {
    expect(fillTemplate("Hi {{name}} — {{missing}}", { name: "Ada" })).toBe("Hi Ada — {{missing}}");
  });

  it("accepts empty string values", () => {
    expect(fillTemplate("a{{x}}b", { x: "" })).toBe("ab");
  });
});

describe("effectiveBody / bodySource", () => {
  it("workspace wins over app over default", () => {
    expect(effectiveBody("a", "default", { a: "app" }, { a: "ws" })).toBe("ws");
    expect(effectiveBody("a", "default", { a: "app" }, {})).toBe("app");
    expect(effectiveBody("a", "default", {}, {})).toBe("default");
    expect(bodySource("a", { a: "app" }, { a: "ws" })).toBe("workspace");
    expect(bodySource("a", { a: "app" }, {})).toBe("app");
    expect(bodySource("a", {}, {})).toBe("default");
  });

  it("treats blank overrides as absent", () => {
    expect(effectiveBody("a", "default", { a: "  " }, { a: "\n" })).toBe("default");
  });
});

describe("ACTION_PROMPTS", () => {
  it("has unique ids", () => {
    const ids = ACTION_PROMPTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers every built-in agent tool", () => {
    const agentIds = BUILTIN_TOOLS.filter((t) => t.kind === "agent").map((t) => t.id);
    for (const id of agentIds) {
      expect(
        ACTION_PROMPTS.some((p) => p.id === id),
        `missing catalog entry for ${id}`
      ).toBe(true);
    }
  });
});

describe("resolveActionPrompt / applyToolBodyOverrides", () => {
  it("resolves a catalog id", () => {
    expect(resolveActionPrompt("action:develop", null, null)).toContain("gavin-develop");
    expect(resolveActionPrompt("nope", null, null)).toBeNull();
  });

  it("patches agent tool bodies from overrides", () => {
    const library = applyToolBodyOverrides(BUILTIN_TOOLS, { "builtin:commit": "Custom commit." }, null);
    const commit = library.find((t) => t.id === "builtin:commit")!;
    expect(commit.body).toBe("Custom commit.");
    const push = library.find((t) => t.id === "builtin:push")!;
    expect(push.body).toBe(BUILTIN_TOOLS.find((t) => t.id === "builtin:push")!.body);
  });
});

describe("withOverride / pruneOverrides", () => {
  it("writes, clears, and drops blanks", () => {
    expect(withOverride({}, "a", "hi")).toEqual({ a: "hi" });
    expect(withOverride({ a: "hi" }, "a", null)).toEqual({});
    expect(pruneOverrides({ a: "x", b: "  " })).toEqual({ a: "x" });
  });
});
