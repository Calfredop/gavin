/// A card's own answer to "which agent, at which model does this run".
///
/// `complexity:` answers the same question by proxy -- the human rates
/// the work once and a table turns each level into an agent -- and that
/// is the right shape for most cards. This is the escape hatch for the
/// one that is not like its level: a card whose work happens to need
/// the big model, or the CLI that is good at this particular thing,
/// said on the card itself rather than by re-rating it as harder than
/// it is.
///
/// Two frontmatter lines, `agent:` and `model:`, and either alone is
/// meaningful. An `agent:` with no `model:` runs that binary at its own
/// default; a `model:` with no `agent:` runs the workspace's binary at
/// that model, which is the commoner of the two. That is the same shape
/// a complexity table row already has, which is why both resolve
/// through the same overlay (`agentConfigWithAttribution`).
///
/// Pure and unit-tested, so the card detail modal and the Plans tab
/// strip stay templates over it.

import {
  complexityEntry,
  isAttributed,
  parseComplexity,
  COMPLEXITY_LABELS,
  type ComplexityAgent,
  type ComplexityTable,
} from "$lib/complexity";

/// What a card carries, as the frontmatter records it. Structural rather
/// than `CardView` or `PlanFileInfo` so this module owes neither: both
/// shapes satisfy it, and so does a two-field literal in a test.
export interface CardAgentFields {
  agent?: string | null;
  model?: string | null;
  complexity?: string | null;
}

/// The sentinel the card's agent picker uses for "no override". Never a
/// profile id and never written to a card: choosing it CLEARS the
/// `agent:` line, which is a different answer from naming the profile
/// the workspace happens to be on today -- the workspace's choice can
/// change afterwards, and an inheriting card is supposed to follow it.
export const NO_CARD_AGENT = "";

/// The card's own attribution, or null when it names neither half.
///
/// Trimmed, because the daemon stores what it was handed and a
/// hand-edited card may carry padding. Never validated against the
/// profile table: a name gavin cannot resolve has to read back as
/// itself so the typo is visible, and `resolveAgentConfig` already has
/// a documented answer for an unknown profile.
export function cardAgentOverride(
  card: CardAgentFields | null | undefined
): ComplexityAgent | null {
  const entry = {
    profile: (card?.agent ?? "").trim(),
    model: (card?.model ?? "").trim(),
  };
  return isAttributed(entry) ? entry : null;
}

/// The attribution that governs this card: its own override where it
/// says anything, else its complexity level's entry, else null.
///
/// The override is read WHOLE rather than merged half-by-half with the
/// level's, and that is the load-bearing decision here. Merging would
/// let a card that names only `model: opus` keep the level's `codex`
/// profile and launch `codex --model opus` -- a model name from one CLI
/// in another's argv, which is not a preference but a broken command
/// line. So a card that says anything at all replaces the level's pair,
/// and the halves it leaves empty mean what they mean everywhere else:
/// no profile is "the workspace's own agent", no model is "that agent's
/// own default".
export function cardAgentEntry(
  card: CardAgentFields | null | undefined,
  app: ComplexityTable,
  workspace: ComplexityTable
): ComplexityAgent | null {
  return (
    cardAgentOverride(card) ??
    complexityEntry(parseComplexity(card?.complexity), app, workspace)
  );
}

/// How an attribution reads in one phrase: "Codex on gpt-5.1", "Codex",
/// "this workspace's agent on opus". Null for an attribution that names
/// nothing, so a caller can concatenate unconditionally.
function attributionPhrase(
  entry: ComplexityAgent | null,
  profileLabel: (id: string) => string
): string | null {
  if (!entry) return null;
  const agent = entry.profile.trim() ? profileLabel(entry.profile.trim()) : null;
  const model = entry.model.trim();
  if (agent && model) return `${agent} on ${model}`;
  if (agent) return agent;
  if (model) return `this workspace's agent on ${model}`;
  return null;
}

/// The line under the card's agent controls: what this card will
/// actually launch, and which of the three answers decided it.
///
/// The third clause is the whole reason this is not two independent
/// sentences. A card can carry BOTH a level and an override, and the
/// two controls sit next to each other saying different things -- so
/// the line has to name the winner and say what it beat, or the human
/// reads "intricate" beside "claude-code · haiku" and has no way to
/// tell which one the run will use. Said only when the level actually
/// attributes an agent: a level nothing maps to was never going to pick
/// anything, and "overriding" it would be a claim about a fight that
/// did not happen.
///
/// Null when the card says nothing at all and its level names nothing
/// either -- the ordinary case, where the card simply runs the
/// workspace's agent and there is nothing to explain.
export function cardAgentSummary(
  card: CardAgentFields | null | undefined,
  app: ComplexityTable,
  workspace: ComplexityTable,
  profileLabel: (id: string) => string
): string | null {
  const level = parseComplexity(card?.complexity);
  const fromLevel = complexityEntry(level, app, workspace);
  const override = cardAgentOverride(card);
  if (!override) {
    if (!level) return null;
    const phrase = attributionPhrase(fromLevel, profileLabel);
    const name = COMPLEXITY_LABELS[level].label;
    return phrase
      ? `${name} — runs ${phrase}.`
      : `${name} — runs this workspace's agent.`;
  }
  const phrase = attributionPhrase(override, profileLabel) ?? "this workspace's agent";
  if (!level || !fromLevel) return `This card runs ${phrase}.`;
  return `This card runs ${phrase} — overriding what its ${COMPLEXITY_LABELS[
    level
  ].label.toLowerCase()} level would run (${attributionPhrase(fromLevel, profileLabel)}).`;
}

/// The board chip's sentence for a card that names its own agent, or
/// null for one that names neither.
///
/// Raw ids rather than resolved profile labels, deliberately: this is
/// rendered on every card in every column, and turning an id into a
/// label would mean handing the profile table and both settings tables
/// to a chip whose whole job is to say "this one is different". The
/// three shapes match `cardAgentSummary`'s, and live beside it so the
/// two cannot drift into meaning different things.
export function cardOverrideNote(card: CardAgentFields | null | undefined): string | null {
  const entry = cardAgentOverride(card);
  if (!entry) return null;
  const { profile, model } = entry;
  if (profile && model) {
    return `This card runs on ${profile} at ${model}, not the workspace's agent.`;
  }
  if (profile) return `This card runs on ${profile}, not the workspace's agent.`;
  return `This card runs the workspace's agent at ${model}.`;
}

/// Whether gavin has a verified way to put a model on the agent this
/// card would run, given the flag that agent resolved to. Only ever
/// asked about a card that NAMES a model: without one there is nothing
/// that could go missing, and warning about a flag nobody needs is
/// noise on every card in the workspace.
///
/// The failure it names is silent otherwise. `composeLaunchCommand`
/// drops a model it has no flag for rather than guessing one, so the
/// card would read as pinned to a model and launch at the agent's
/// default with nothing on screen to say so.
export function cardModelUnreachable(
  card: CardAgentFields | null | undefined,
  resolvedModelFlag: string
): boolean {
  return Boolean((card?.model ?? "").trim()) && !resolvedModelFlag.trim();
}
