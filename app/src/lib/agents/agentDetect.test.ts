import { describe, expect, it } from "vitest";
import {
  foundAgentsSummary,
  foundProfileIds,
  isAgentFound,
  missingFromAppFallback,
  suggestFallbackChain,
  suggestMainProfile,
  type DetectedAgent,
} from "$lib/agents/agentDetect";

function row(
  over: Partial<DetectedAgent> & Pick<DetectedAgent, "id" | "found">
): DetectedAgent {
  return {
    label: over.id,
    command: over.id,
    path: over.found ? `/bin/${over.id}` : null,
    ...over,
  };
}

const SWEEP: DetectedAgent[] = [
  row({ id: "claude-code", label: "Claude Code", found: true }),
  row({ id: "codex", label: "Codex", found: false }),
  row({ id: "gemini", label: "Gemini", found: true }),
  row({ id: "cursor", label: "Cursor Agent", found: false }),
  row({ id: "opencode", label: "OpenCode", found: true }),
];

describe("foundProfileIds / isAgentFound", () => {
  it("lists only PATH hits", () => {
    expect(foundProfileIds(SWEEP)).toEqual(["claude-code", "gemini", "opencode"]);
    expect(isAgentFound(SWEEP, "gemini")).toBe(true);
    expect(isAgentFound(SWEEP, "codex")).toBe(false);
    expect(isAgentFound(SWEEP, "custom")).toBe(false);
  });
});

describe("suggestMainProfile", () => {
  it("does not override once a command is already written", () => {
    expect(
      suggestMainProfile({
        detected: SWEEP,
        currentProfileId: "codex",
        appChains: { "claude-code": ["gemini"] },
        commandAlreadySet: true,
      })
    ).toBe("codex");
  });

  it("keeps the current profile when it is found", () => {
    expect(
      suggestMainProfile({
        detected: SWEEP,
        currentProfileId: "opencode",
        appChains: { "claude-code": ["gemini"] },
        commandAlreadySet: false,
      })
    ).toBe("opencode");
  });

  it("prefers a found id from any primary's chain over the first found", () => {
    expect(
      suggestMainProfile({
        detected: SWEEP,
        currentProfileId: "codex",
        appChains: { "claude-code": ["cursor"], gemini: ["gemini", "opencode"] },
        commandAlreadySet: false,
      })
    ).toBe("gemini");
  });

  it("falls back to the first found CLI when settings name nothing usable", () => {
    expect(
      suggestMainProfile({
        detected: SWEEP,
        currentProfileId: "codex",
        appChains: { "claude-code": ["cursor"] },
        commandAlreadySet: false,
      })
    ).toBe("claude-code");
  });
});

describe("suggestFallbackChain", () => {
  it("leaves an existing chain for the main profile alone", () => {
    expect(
      suggestFallbackChain({
        detected: SWEEP,
        mainProfileId: "claude-code",
        appChains: { "claude-code": ["codex", "gemini"] },
      })
    ).toBeNull();
  });

  it("seeds other found agents when the main profile has no chain yet", () => {
    expect(
      suggestFallbackChain({
        detected: SWEEP,
        mainProfileId: "claude-code",
        appChains: {},
      })
    ).toEqual(["gemini", "opencode"]);
  });

  it("still seeds for a primary another primary's chain does not cover", () => {
    expect(
      suggestFallbackChain({
        detected: SWEEP,
        mainProfileId: "gemini",
        appChains: { "claude-code": ["codex"] },
      })
    ).toEqual(["claude-code", "opencode"]);
  });
});

describe("missingFromAppFallback", () => {
  it("names ids in the main profile's chain the sweep marked missing", () => {
    expect(
      missingFromAppFallback(SWEEP, { "claude-code": ["codex", "gemini", "cursor"] }, "claude-code")
    ).toEqual(["codex", "cursor"]);
  });

  it("says nothing for a primary with no chain", () => {
    expect(missingFromAppFallback(SWEEP, { "claude-code": ["codex"] }, "gemini")).toEqual([]);
  });
});

describe("foundAgentsSummary", () => {
  it("lists found labels", () => {
    expect(foundAgentsSummary(SWEEP)).toBe("Found: Claude Code, Gemini, OpenCode.");
  });

  it("explains an empty sweep", () => {
    expect(foundAgentsSummary(SWEEP.map((d) => ({ ...d, found: false, path: null })))).toBe(
      "None of gavin's built-in agent CLIs were found on PATH."
    );
  });
});
