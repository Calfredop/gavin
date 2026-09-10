import { describe, it, expect } from "vitest";
import {
  cardAgentEntry,
  cardAgentOverride,
  cardAgentSummary,
  cardModelUnreachable,
  cardOverrideNote,
} from "$lib/cards/cardAgent";
import type { ComplexityTable } from "$lib/cards/complexity";

const app: ComplexityTable = {
  trivial: { profile: "", model: "haiku" },
  intricate: { profile: "codex", model: "gpt-5.1" },
};
const label = (id: string) => (id === "codex" ? "Codex" : id === "claude-code" ? "Claude Code" : id);

describe("cardAgentOverride", () => {
  it("reads either half on its own, since either is a whole answer", () => {
    expect(cardAgentOverride({ agent: "codex" })).toEqual({ profile: "codex", model: "" });
    expect(cardAgentOverride({ model: "opus" })).toEqual({ profile: "", model: "opus" });
    expect(cardAgentOverride({ agent: "codex", model: "gpt-5.1" })).toEqual({
      profile: "codex",
      model: "gpt-5.1",
    });
  });

  it("treats an absent, empty or whitespace line as no override at all", () => {
    expect(cardAgentOverride({})).toBeNull();
    expect(cardAgentOverride(null)).toBeNull();
    expect(cardAgentOverride({ agent: "", model: "" })).toBeNull();
    expect(cardAgentOverride({ agent: "   ", model: "  " })).toBeNull();
  });

  it("keeps a profile the table does not know rather than dropping it", () => {
    // The `attachments` posture: a value gavin cannot resolve has to read
    // back as itself so the typo is visible on the card, rather than
    // vanishing into the workspace default.
    expect(cardAgentOverride({ agent: "not-a-profile" })).toEqual({
      profile: "not-a-profile",
      model: "",
    });
  });
});

describe("cardAgentEntry", () => {
  it("falls through to the complexity level when the card names neither", () => {
    expect(cardAgentEntry({ complexity: "intricate" }, app, {})).toEqual({
      profile: "codex",
      model: "gpt-5.1",
    });
    expect(cardAgentEntry({ complexity: "moderate" }, app, {})).toBeNull();
    expect(cardAgentEntry({}, app, {})).toBeNull();
  });

  it("replaces the level's pair WHOLE rather than merging half by half", () => {
    // The failure this rule prevents: merging would keep the level's
    // `codex` and pair it with the card's `opus`, i.e. `codex --model
    // opus` -- a model name from one CLI in another's argv.
    expect(cardAgentEntry({ complexity: "intricate", model: "opus" }, app, {})).toEqual({
      profile: "",
      model: "opus",
    });
    expect(cardAgentEntry({ complexity: "intricate", agent: "gemini" }, app, {})).toEqual({
      profile: "gemini",
      model: "",
    });
  });

  it("lets the workspace table win under a card that says nothing", () => {
    const workspace: ComplexityTable = { intricate: { profile: "gemini", model: "" } };
    expect(cardAgentEntry({ complexity: "intricate" }, app, workspace)).toEqual({
      profile: "gemini",
      model: "",
    });
  });
});

describe("cardAgentSummary", () => {
  it("says nothing about a card that rates and overrides nothing", () => {
    expect(cardAgentSummary({}, app, {}, label)).toBeNull();
    expect(cardAgentSummary(null, app, {}, label)).toBeNull();
  });

  it("reads a level exactly as the complexity line did before", () => {
    expect(cardAgentSummary({ complexity: "intricate" }, app, {}, label)).toBe(
      "Intricate — runs Codex on gpt-5.1."
    );
    expect(cardAgentSummary({ complexity: "trivial" }, app, {}, label)).toBe(
      "Trivial — runs this workspace's agent on haiku."
    );
    expect(cardAgentSummary({ complexity: "moderate" }, app, {}, label)).toBe(
      "Moderate — runs this workspace's agent."
    );
  });

  it("names the override, in each of its three shapes", () => {
    expect(cardAgentSummary({ agent: "codex", model: "gpt-5.1" }, app, {}, label)).toBe(
      "This card runs Codex on gpt-5.1."
    );
    expect(cardAgentSummary({ agent: "codex" }, app, {}, label)).toBe("This card runs Codex.");
    expect(cardAgentSummary({ model: "opus" }, app, {}, label)).toBe(
      "This card runs this workspace's agent on opus."
    );
  });

  it("says what the override BEAT when the level would have picked something", () => {
    // Both controls sit next to each other showing different answers, so
    // the line has to name the winner -- otherwise "intricate" beside
    // "Claude Code" is two claims with no way to tell which one runs.
    expect(
      cardAgentSummary({ complexity: "intricate", agent: "claude-code" }, app, {}, label)
    ).toBe(
      "This card runs Claude Code — overriding what its intricate level would run (Codex on gpt-5.1)."
    );
  });

  it("claims no fight with a level that attributes nothing", () => {
    expect(cardAgentSummary({ complexity: "moderate", agent: "codex" }, app, {}, label)).toBe(
      "This card runs Codex."
    );
  });
});

describe("cardOverrideNote", () => {
  it("says nothing about a card that names neither half", () => {
    expect(cardOverrideNote({})).toBeNull();
    // Never about a LEVEL: the level has a chip of its own beside this
    // one, and a glyph on every rated card would say nothing about
    // which of them is unusual.
    expect(cardOverrideNote({ complexity: "intricate" })).toBeNull();
  });

  it("reads in raw ids, in the same three shapes the summary uses", () => {
    expect(cardOverrideNote({ agent: "codex", model: "gpt-5.1" })).toBe(
      "This card runs on codex at gpt-5.1, not the workspace's agent."
    );
    expect(cardOverrideNote({ agent: "codex" })).toBe(
      "This card runs on codex, not the workspace's agent."
    );
    // Naming only a model does NOT change the agent, so the sentence
    // must not claim it did.
    expect(cardOverrideNote({ model: "opus" })).toBe(
      "This card runs the workspace's agent at opus."
    );
  });
});

describe("cardModelUnreachable", () => {
  it("warns only about a model that has no flag to ride on", () => {
    expect(cardModelUnreachable({ model: "opus" }, "")).toBe(true);
    expect(cardModelUnreachable({ model: "opus" }, "--model")).toBe(false);
    // Nothing could go missing on a card that names no model, and
    // warning about every card in the workspace would be noise.
    expect(cardModelUnreachable({}, "")).toBe(false);
    expect(cardModelUnreachable({ model: "  " }, "")).toBe(false);
  });
});
