<script lang="ts">
  /// The five-row table that says which agent, model and effort each complexity
  /// level runs. One component for both panels -- the app-wide Settings
  /// modal and a workspace's Settings tab -- because they are the same
  /// table with the same vocabulary, and two copies is how the app-wide
  /// and per-workspace answers start describing different things.
  ///
  /// Purely presentational: it renders the table it is handed and reports
  /// each edit. Where the value is STORED, and what inheriting means, is
  /// the caller's business.
  import { X } from "@lucide/svelte";
  import {
    COMPLEXITY_LABELS,
    COMPLEXITY_LEVELS,
    isAttributed,
    type Complexity,
    type ComplexityAgent,
    type ComplexityTable,
  } from "$lib/cards/complexity";
  import type { AgentProfileInfo } from "$lib/core/settings";
  import { effortPresets } from "$lib/agents/agentModel";
  import { profileOptionLabel } from "$lib/agents/agentsHub";

  interface Props {
    profiles: AgentProfileInfo[];
    /// The table being edited.
    table: ComplexityTable;
    /// What an unset row falls through to, or null in the app-wide panel
    /// where there is nothing underneath. Only ever read for the label on
    /// the inherit option, so a row can say what leaving it alone does.
    inherited?: ComplexityTable | null;
    /// `null` clears the row back to inheriting.
    onChange: (level: Complexity, entry: ComplexityAgent | null) => void;
  }
  let { profiles, table, inherited = null, onChange }: Props = $props();

  /// The sentinel for the profile select's first option. Distinct from
  /// the empty PROFILE (which means "this workspace's agent, whatever it
  /// is") only in the workspace panel -- see `pickProfile`.
  const SAME_AGENT = "";

  const profileLabel = (id: string) => {
    const profile = profiles.find((p) => p.id === id);
    return profile ? profileOptionLabel(profile) : id;
  };

  function entryFor(level: Complexity): ComplexityAgent {
    return table[level] ?? { profile: "", model: "", effort: "" };
  }

  /// What this row does if left alone, said in the option's own label so
  /// the human never has to look at another panel to find out.
  function inheritLabel(level: Complexity): string {
    const shared = inherited?.[level];
    if (!isAttributed(shared)) return "This workspace's agent";
    const agent = shared!.profile.trim();
    const what = [shared!.model.trim(), (shared!.effort ?? "").trim()].filter(Boolean).join(" · ");
    const who = agent ? profileLabel(agent) : "this workspace's agent";
    return what ? `Default (${who} · ${what})` : `Default (${who})`;
  }

  /// A row is stored only when it says something. Writing an empty entry
  /// would shadow the app-wide answer with nothing, which is exactly what
  /// the human did NOT ask for by clearing it.
  function commit(level: Complexity, next: ComplexityAgent): void {
    onChange(level, isAttributed(next) ? next : null);
  }

  function pickProfile(level: Complexity, value: string): void {
    commit(level, { ...entryFor(level), profile: value });
  }

  function typeModel(level: Complexity, value: string): void {
    commit(level, { ...entryFor(level), model: value });
  }

  /// Free text, so a level a newer CLI added is never out of reach; the
  /// box suggests the levels the row's agent documents (`effortPresets`).
  function typeEffort(level: Complexity, value: string): void {
    commit(level, { ...entryFor(level), effort: value.trim() });
  }

  /// Whether the effort this row names can reach the profile it names --
  /// `modelUnreachable`'s twin, and asked only about a NAMED profile for
  /// the same reason.
  function effortUnreachable(level: Complexity): boolean {
    const entry = entryFor(level);
    const id = entry.profile.trim();
    if (!id || !(entry.effort ?? "").trim()) return false;
    const profile = profiles.find((p) => p.id === id);
    return Boolean(profile) && !profile!.effortFlag;
  }

  /// Whether gavin has any way to put a model on the profile this row
  /// names. Empty means the row runs whatever agent the workspace runs,
  /// which only that workspace can answer for -- so the warning is only
  /// ever raised about a profile the row NAMES.
  function modelUnreachable(level: Complexity): boolean {
    const entry = entryFor(level);
    const id = entry.profile.trim();
    if (!id || !entry.model.trim()) return false;
    const profile = profiles.find((p) => p.id === id);
    return Boolean(profile) && !profile!.modelFlag;
  }
</script>

<div class="complexity-table">
  {#if profiles.length === 0}
    <p class="hint">Waiting for the agent profile table…</p>
  {:else}
    {#each COMPLEXITY_LEVELS as level (level)}
      {@const entry = entryFor(level)}
      <div class="row">
        <span class="level" title={COMPLEXITY_LABELS[level].hint}>
          {COMPLEXITY_LABELS[level].label}
        </span>
        <select value={entry.profile} onchange={(e) => pickProfile(level, e.currentTarget.value)}>
          <option value={SAME_AGENT}>{inheritLabel(level)}</option>
          {#each profiles as profile (profile.id)}
            <option value={profile.id}>{profileOptionLabel(profile)}</option>
          {/each}
        </select>
        <input
          class="model"
          spellcheck="false"
          placeholder="model"
          value={entry.model}
          onchange={(e) => typeModel(level, e.currentTarget.value)}
          onkeydown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        <input
          class="effort"
          spellcheck="false"
          placeholder="effort"
          list="complexity-effort-{level}"
          value={entry.effort ?? ""}
          onchange={(e) => typeEffort(level, e.currentTarget.value)}
          onkeydown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        <datalist id="complexity-effort-{level}">
          {#each effortPresets(profiles, entry.profile) as effort (effort)}
            <option value={effort}></option>
          {/each}
        </datalist>
        <button
          type="button"
          class="clear"
          title="Clear this level"
          disabled={!isAttributed(table[level])}
          onclick={() => onChange(level, null)}
        >
          <X size={12} />
        </button>
      </div>
      <p class="hint row-hint">
        {COMPLEXITY_LABELS[level].hint}
        {#if modelUnreachable(level)}
          <span class="warn">
            gavin knows no model flag for {profileLabel(entry.profile.trim())} — set the model in
            its command instead.
          </span>
        {/if}
        {#if effortUnreachable(level)}
          <span class="warn">
            gavin knows no effort flag for {profileLabel(entry.profile.trim())}, so this effort is
            not passed on.
          </span>
        {/if}
      </p>
    {/each}
  {/if}
</div>

<style>
  .complexity-table {
    display: flex;
    flex-direction: column;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 2px;
  }
  .level {
    width: 110px;
    flex: 0 0 auto;
    color: var(--text-muted);
  }
  select,
  input {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: monospace;
    font-size: 1em;
    padding: 3px 8px;
  }
  /* Both controls are capped rather than sized by their content, the
     same answer the settings panels' own model row reached: a native
     select is as wide as its WIDEST option, and those options are agent
     labels here but model names one box over.
     The input is capped to the select's width rather than to the 240px
     the panels use for a lone control, because these two sit side by
     side under a 110px label -- matching them keeps the five rows
     reading as a table. It was `flex: 1 1 auto`, which took every pixel
     the row had left: harmless in the app modal, which is 380px wide,
     and the full width of the pane in a workspace's Settings tab. */
  select,
  input.model {
    flex: 0 1 220px;
    min-width: 0;
  }
  select {
    min-width: 140px;
  }
  /* An effort is one short word -- `high`, `xhigh` -- so its box is
     narrow on purpose: the four controls still have to read as one row
     under a 110px label in the 380px app modal. */
  input.effort {
    flex: 0 1 90px;
    min-width: 0;
  }
  /* Kept in the flow even when there is nothing to clear, so the four
     rows above and below it stay on one grid. */
  .clear {
    display: flex;
    align-items: center;
    background: none;
    border: none;
    border-radius: 4px;
    color: var(--text-subtle);
    cursor: pointer;
    padding: 3px;
  }
  .clear:disabled {
    opacity: 0.25;
    cursor: default;
  }
  .clear:not(:disabled):hover {
    background: var(--surface-overlay);
    color: var(--text);
  }
  .hint {
    color: var(--text-subtle);
    margin: 0;
  }
  .row-hint {
    margin: 0 0 10px 120px;
  }
  .warn {
    color: var(--warning-text);
  }
  /* A phone's width, on the Companion (companion-30): four controls do
     not fit one row beside a label, so the level heads its row and the
     agent's select takes the full width under it, with model and effort
     side by side below that. */
  @media (max-width: 600px) {
    .row {
      flex-wrap: wrap;
    }
    .level {
      width: 100%;
    }
    select {
      flex: 1 1 100%;
    }
    input.model {
      flex: 1 1 0;
    }
    input.effort {
      flex: 0 1 110px;
    }
    .row-hint {
      margin-left: 0;
    }
  }
  /* A fingertip: thumb-sized controls, and 16px text so iOS does not zoom
     into a field. A window with a mouse never matches. */
  @media (pointer: coarse) {
    select,
    input {
      min-height: 44px;
      font-size: 16px;
    }
    .clear {
      min-width: 44px;
      min-height: 44px;
      justify-content: center;
    }
  }
</style>
