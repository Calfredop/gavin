/// Init-wizard PATH sweep: which built-in agent CLIs resolve, and how that
/// should seed the main profile and app-wide fallback chain.
///
/// Rust owns the probe (`detect_agent_binaries`); this module owns the
/// pure decisions the Agent step makes from that list plus app settings.

export interface DetectedAgent {
  id: string;
  label: string;
  command: string;
  found: boolean;
  path: string | null;
}

/// Profile ids whose default command resolved on PATH.
export function foundProfileIds(detected: readonly DetectedAgent[]): string[] {
  return detected.filter((d) => d.found).map((d) => d.id);
}

/// Whether a profile id was found. Unknown ids (e.g. `custom`) are not.
export function isAgentFound(
  detected: readonly DetectedAgent[],
  profileId: string
): boolean {
  return detected.some((d) => d.id === profileId && d.found);
}

/// Main agent to offer when the wizard has not yet written `[agent].command`.
///
/// Prefer keeping a current profile that is found; else the first found id
/// that already appears in ANY app fallback chain (settings the human
/// already trusts — a non-empty chain for any primary counts); else the
/// first found CLI; else leave current alone.
/// Never overrides once a command is already on disk — that means the
/// human finished this step (or wrote it by hand).
export function suggestMainProfile(input: {
  detected: readonly DetectedAgent[];
  currentProfileId: string | null | undefined;
  appChains: Record<string, readonly string[]> | null | undefined;
  commandAlreadySet: boolean;
}): string | null {
  const current = input.currentProfileId?.trim() || null;
  if (input.commandAlreadySet) return current;

  const found = new Set(foundProfileIds(input.detected));
  if (current && found.has(current)) return current;

  for (const chain of Object.values(input.appChains ?? {})) {
    for (const id of chain) {
      const trimmed = id.trim();
      if (trimmed && found.has(trimmed)) return trimmed;
    }
  }

  const firstFound = input.detected.find((d) => d.found)?.id ?? null;
  return firstFound ?? current;
}

/// Fallback chain to seed FOR `mainProfileId` when the app has no chain
/// for that primary yet. An existing chain for it is left alone — the
/// wizard shows found/missing against it rather than rewriting Settings
/// behind the human's back. When seeding from found agents, excludes the
/// main profile so the chain is "who else", not a duplicate of main.
export function suggestFallbackChain(input: {
  detected: readonly DetectedAgent[];
  mainProfileId: string | null | undefined;
  appChains: Record<string, readonly string[]> | null | undefined;
}): string[] | null {
  const main = input.mainProfileId?.trim() || null;
  const existing = (main ? (input.appChains?.[main] ?? []) : []).map((id) => id.trim()).filter(Boolean);
  if (existing.length > 0) return null;

  return foundProfileIds(input.detected).filter((id) => id !== main);
}

/// Ids from the main profile's app chain that the sweep did not find —
/// for wizard copy.
export function missingFromAppFallback(
  detected: readonly DetectedAgent[],
  appChains: Record<string, readonly string[]> | null | undefined,
  mainProfileId: string | null | undefined
): string[] {
  const main = mainProfileId?.trim() || null;
  const chain = main ? (appChains?.[main] ?? []) : [];
  const known = new Map(detected.map((d) => [d.id, d.found]));
  const out: string[] = [];
  for (const raw of chain) {
    const id = raw.trim();
    if (!id) continue;
    if (known.get(id) === false) out.push(id);
  }
  return out;
}

/// One line for the wizard: "Found: Claude Code, Cursor Agent" or a
/// sentence when nothing resolves.
export function foundAgentsSummary(detected: readonly DetectedAgent[]): string {
  const labels = detected.filter((d) => d.found).map((d) => d.label);
  if (labels.length === 0) {
    return "None of gavin's built-in agent CLIs were found on PATH.";
  }
  return `Found: ${labels.join(", ")}.`;
}
