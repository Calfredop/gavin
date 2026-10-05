<script lang="ts">
  /// The controls that let ONE card name the agent, model and effort it
  /// runs on, overriding whatever its `complexity:` level and the workspace
  /// would otherwise launch.
  ///
  /// One component for both surfaces that edit a card's frontmatter --
  /// the card detail modal and the Plans tab's metadata strip -- for the
  /// same reason `ComplexityTable.svelte` serves both settings panels:
  /// these are the same two fields with the same vocabulary, and two
  /// copies is how the two surfaces start describing different things.
  ///
  /// Purely presentational. It renders the card it is handed and reports
  /// each edit; where the value is WRITTEN, and what a failed write does
  /// to the surface, is the caller's business. Its font SIZE is
  /// inherited, so the pair reads as part of a 0.8em strip and as part
  /// of a 0.85em meta row without either host restyling it.
  import { CUSTOM_MODEL, effortChoices, modelChoices } from "$lib/agents/agentModel";
  import { cardAgents } from "$lib/core/layoutState";
  import {
    NO_CARD_AGENT,
    cardEffortUnreachable,
    cardModelUnreachable,
    type CardAgentFields,
  } from "$lib/cards/cardAgent";
  import type { AgentProfileInfo } from "$lib/core/settings";

  interface Props {
    workspaceId: string;
    profiles: AgentProfileInfo[];
    /// The card as its frontmatter records it. Only the three fields are
    /// read, so a `CardView` and a `PlanFileInfo` both satisfy it.
    card: CardAgentFields;
    /// Why both controls are disabled, or null. A v31 daemon fails this
    /// feature in both directions -- it refuses the two writes and never
    /// parses the two lines -- so the caller passes the reason down
    /// rather than letting a change fail.
    blocked?: string | null;
    /// Why the effort control alone is disabled, or null. Its own gate
    /// (`agentEffort`, v56) on top of `blocked`: a v55 daemon keeps the
    /// agent and model lines and refuses -- and never parses -- this one.
    effortBlocked?: string | null;
    /// An empty value CLEARS the line, which is how a card goes back to
    /// inheriting. Callers must not treat it as a no-op.
    onChange: (key: "agent" | "model" | "effort", value: string) => void;
  }
  let { workspaceId, profiles, card, blocked = null, effortBlocked = null, onChange }: Props = $props();

  /// The card's OWN lines, trimmed. Distinct from the resolved answer
  /// below at every point that matters: an empty one means "inherit",
  /// and the resolver has already replaced it with something by the time
  /// it hands an agent back.
  const ownProfile = $derived((card.agent ?? "").trim());
  const ownModel = $derived((card.model ?? "").trim());
  const ownEffort = $derived((card.effort ?? "").trim());
  const effortGate = $derived(blocked ?? effortBlocked);

  /// The agent this card would actually launch, resolved by exactly the
  /// rules a run uses (`cardAgents` wraps `agentForCard`'s resolution).
  /// Read from the store rather than computed here so the model presets,
  /// the flag warning and the launch itself can never disagree about
  /// which profile the card lands on.
  const resolved = $derived($cardAgents(workspaceId, card));
  const resolvedProfile = $derived(profiles.find((p) => p.id === resolved.profileId));

  /// What the model box inherits when the card names none: its level's
  /// model, else the workspace's own, else the app-wide default for the
  /// profile it lands on. Resolved by asking for the SAME card with its
  /// `model:` removed, so the inherit label and the run agree by
  /// construction instead of by a second copy of the fallback chain.
  const inheritedModel = $derived($cardAgents(workspaceId, { ...card, model: "" }).model);
  /// The same question for the effort, by the same construction.
  const inheritedEffort = $derived($cardAgents(workspaceId, { ...card, effort: "" }).effort);

  /// A card naming a profile that is not in the table still reads back as
  /// what it says. `resolveAgentConfig` runs such a card on claude-code,
  /// which is the documented fallback -- but a select that silently
  /// showed claude-code would hide the typo that caused it, and there
  /// would be no way to tell the two apart on screen.
  const unknownProfile = $derived(
    ownProfile !== "" && !profiles.some((p) => p.id === ownProfile) ? ownProfile : null
  );

  let modelCustomOpen = $state(false);
  let modelDraft = $state("");
  let modelFocused = $state(false);
  $effect(() => {
    const own = ownModel;
    if (!modelFocused) modelDraft = own;
  });

  /// Whether the typed box is showing. Open once the human picks
  /// Custom…, and open from the start for a model that is not one of the
  /// resolved profile's presets -- which includes every model on a
  /// profile that has no preset list at all.
  const modelIsCustom = $derived(
    modelCustomOpen || (ownModel !== "" && !(resolvedProfile?.models ?? []).includes(ownModel))
  );

  /// The model named here will not reach the command: gavin has no
  /// verified flag for the agent this card lands on, and
  /// `composeLaunchCommand` drops a model rather than guessing a flag.
  /// Worth saying out loud, because the card would otherwise read as
  /// pinned to a model and launch at the agent's default.
  const modelUnreachable = $derived(cardModelUnreachable(card, resolved.modelFlag));
  const effortUnreachable = $derived(cardEffortUnreachable(card, resolved.effortFlag));

  let effortCustomOpen = $state(false);
  let effortDraft = $state("");
  let effortFocused = $state(false);
  $effect(() => {
    const own = ownEffort;
    if (!effortFocused) effortDraft = own;
  });

  /// `modelIsCustom` for the effort: open from the picker, or holding a
  /// level the resolved agent does not document.
  const effortIsCustom = $derived(
    effortCustomOpen || (ownEffort !== "" && !(resolvedProfile?.efforts ?? []).includes(ownEffort))
  );

  function pickEffort(value: string): void {
    if (value === CUSTOM_MODEL) {
      effortCustomOpen = true;
      effortDraft = ownEffort;
      return;
    }
    effortCustomOpen = false;
    onChange("effort", value);
  }

  function commitEffort(): void {
    const trimmed = effortDraft.trim();
    if (trimmed === ownEffort) return;
    onChange("effort", trimmed);
  }

  function pickProfile(value: string): void {
    onChange("agent", value);
  }

  function pickModel(value: string): void {
    if (value === CUSTOM_MODEL) {
      modelCustomOpen = true;
      modelDraft = ownModel;
      return;
    }
    modelCustomOpen = false;
    onChange("model", value);
  }

  function commitModel(): void {
    const trimmed = modelDraft.trim();
    if (trimmed === ownModel) return;
    onChange("model", trimmed);
  }
</script>

<!-- The blocked reason rides each LABEL rather than the control:
     tooltip.ts binds mouseenter, which a disabled element never fires. -->
<label class="card-agent-field" title={blocked ?? undefined}>
  <span>Agent</span>
  <select
    value={ownProfile}
    disabled={blocked !== null}
    onchange={(e) => pickProfile(e.currentTarget.value)}
  >
    <!-- Not "the profile the workspace is on today": clearing the line
         means the card FOLLOWS the workspace, and naming that profile
         would pin the card to it the moment the workspace moved. -->
    <option value={NO_CARD_AGENT}>inherit</option>
    {#each profiles as profile (profile.id)}
      <option value={profile.id}>{profile.label}</option>
    {/each}
    {#if unknownProfile}
      <option value={unknownProfile}>{unknownProfile} (unknown)</option>
    {/if}
  </select>
</label>
<label class="card-agent-field" title={blocked ?? undefined}>
  <span>Model</span>
  <select
    class="card-agent-model"
    value={modelIsCustom ? CUSTOM_MODEL : ownModel}
    disabled={blocked !== null}
    onchange={(e) => pickModel(e.currentTarget.value)}
  >
    {#each modelChoices({ models: resolvedProfile?.models ?? [] }, inheritedModel) as opt (opt.value)}
      <option value={opt.value}>{opt.label}</option>
    {/each}
  </select>
  {#if modelIsCustom}
    <input
      class="card-agent-model"
      bind:value={modelDraft}
      spellcheck="false"
      placeholder="model name"
      disabled={blocked !== null}
      onfocus={() => (modelFocused = true)}
      onblur={() => {
        modelFocused = false;
        commitModel();
      }}
      onkeydown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  {/if}
</label>
<label class="card-agent-field" title={effortGate ?? undefined}>
  <span>Effort</span>
  <select
    class="card-agent-effort"
    value={effortIsCustom ? CUSTOM_MODEL : ownEffort}
    disabled={effortGate !== null}
    onchange={(e) => pickEffort(e.currentTarget.value)}
  >
    {#each effortChoices({ efforts: resolvedProfile?.efforts ?? [] }, inheritedEffort) as opt (opt.value)}
      <option value={opt.value}>{opt.label}</option>
    {/each}
  </select>
  {#if effortIsCustom}
    <input
      class="card-agent-effort"
      bind:value={effortDraft}
      spellcheck="false"
      placeholder="effort"
      disabled={effortGate !== null}
      onfocus={() => (effortFocused = true)}
      onblur={() => {
        effortFocused = false;
        commitEffort();
      }}
      onkeydown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  {/if}
</label>
{#if modelUnreachable && blocked === null}
  <span class="card-agent-warn"
    >gavin knows no model flag for {resolvedProfile?.label ?? resolved.profileId} — put the model in
    its command instead.</span
  >
{/if}
{#if effortUnreachable && effortGate === null}
  <span class="card-agent-warn"
    >gavin knows no effort flag for {resolvedProfile?.label ?? resolved.profileId}, so this effort
    is not passed on.</span
  >
{/if}

<style>
  .card-agent-field {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .card-agent-field > span {
    color: var(--text-muted);
    flex: 0 0 auto;
  }
  select,
  input {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    /* Monospace like every other frontmatter control on both hosts, but
       the SIZE is inherited: these two sit in a 0.8em strip and in a
       0.85em meta row, and each host's scale is the one that should
       win. */
    font-family: monospace;
    font-size: inherit;
    padding: 2px 5px;
  }
  input.card-agent-model {
    min-width: 0;
    width: 11ch;
  }
  /* Both selects are as wide as their widest option, and the model one's
     is no longer an alias: opencode's catalogue is 450
     provider-qualified names, the longest 67 characters. These sit in a
     wrapping strip beside a title, so an uncapped one does not overflow
     -- it pushes everything after it onto its own line. Wider than the
     11ch box next to it, narrow enough to stay a control. */
  select.card-agent-model {
    max-width: 18ch;
  }
  /* One short word at most -- `xhigh` -- plus the inherit row's label. */
  select.card-agent-effort {
    max-width: 16ch;
  }
  input.card-agent-effort {
    min-width: 0;
    width: 8ch;
  }
  /* Its own line in both hosts, which are both wrapping flex rows: the
     sentence is longer than the controls it is about, and squeezing it
     between them would push the rest of the row off the end. */
  .card-agent-warn {
    color: var(--warning-text);
    flex: 1 1 100%;
  }
</style>
