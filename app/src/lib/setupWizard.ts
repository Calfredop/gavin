export type SetupStep = "agent" | "integration" | "prd" | "launch";

export interface SetupProgress {
  done: SetupStep[];
  /// The first step not yet done, or null when everything is.
  next: SetupStep | null;
  complete: boolean;
}

/// Verbatim from PRD_TEMPLATE in crates/daemon/src/gavin.rs. Matching
/// these strings IS the contract -- if the template changes, these change
/// with it or the PRD step silently stops being detectable.
export const PRD_PLACEHOLDERS = {
  vision: "_What are we building, for whom, and why?_",
  focus: "_The active goals, roughly ordered._",
  outOfScope: "_Explicit non-goals._",
} as const;

const MARKER_START = "<!-- gavin:start -->";

export interface SetupInput {
  hasRoot: boolean;
  /// config.toml's [agent].command. The scaffold writes only `profile`,
  /// so a command can only have come from a person.
  configCommand: string | null;
  /// The resolved agent file's content; null when it does not exist.
  agentFileBody: string | null;
  prdBody: string | null;
  mainSessionId: string | null;
}

const ORDER: SetupStep[] = ["agent", "integration", "prd", "launch"];

/// Derived, never stored (W1): a step configured by hand -- or by an
/// agent -- counts the moment its evidence lands on disk, so no progress
/// record can disagree with reality.
export function setupProgress(input: SetupInput): SetupProgress {
  if (!input.hasRoot) {
    // Every later step writes under the root, so without one nothing can
    // be done yet -- whatever else happens to be true.
    return { done: [], next: "agent", complete: false };
  }
  const done: SetupStep[] = [];
  if (input.configCommand?.trim()) done.push("agent");
  if (input.agentFileBody?.includes(MARKER_START)) done.push("integration");
  // At least one placeholder replaced, not all three: filling only Vision
  // is a real PRD, and requiring all three would never complete.
  if (
    input.prdBody !== null &&
    Object.values(PRD_PLACEHOLDERS).some((p) => !input.prdBody!.includes(p))
  ) {
    done.push("prd");
  }
  if (input.mainSessionId) done.push("launch");

  const ordered = ORDER.filter((s) => done.includes(s));
  const next = ORDER.find((s) => !done.includes(s)) ?? null;
  return { done: ordered, next, complete: next === null };
}

export interface PrdSections {
  vision: string;
  focus: string;
  outOfScope: string;
}

/// Replaces each placeholder line with the given prose. Blank values are
/// left alone, so skipping a section keeps its placeholder -- and a
/// section already filled has no placeholder left to replace, which makes
/// this idempotent rather than duplicating.
export function applyPrdSections(body: string, sections: PrdSections): string {
  let out = body;
  const pairs: Array<[string, string]> = [
    [PRD_PLACEHOLDERS.vision, sections.vision],
    [PRD_PLACEHOLDERS.focus, sections.focus],
    [PRD_PLACEHOLDERS.outOfScope, sections.outOfScope],
  ];
  for (const [placeholder, value] of pairs) {
    if (value.trim()) out = out.replace(placeholder, value.trim());
  }
  return out;
}

/// The agent-driven option is offered only where the positional-prompt
/// convention is verified (spec §7.2); elsewhere the step says so rather
/// than risking a launch with garbage in the agent's argv.
export function agentFlowAvailable(profile: { promptArg: boolean } | undefined): boolean {
  return Boolean(profile?.promptArg);
}
