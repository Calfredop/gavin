<script lang="ts">
  /// The five-row table that says which agent and model each complexity
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
  } from "./complexity";
  import type { AgentProfileInfo } from "./settings";

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

  const profileLabel = (id: string) => profiles.find((p) => p.id === id)?.label ?? id;

  function entryFor(level: Complexity): ComplexityAgent {
    return table[level] ?? { profile: "", model: "" };
  }

  /// What this row does if left alone, said in the option's own label so
  /// the human never has to look at another panel to find out.
  function inheritLabel(level: Complexity): string {
    const shared = inherited?.[level];
    if (!isAttributed(shared)) return "This workspace's agent";
    const agent = shared!.profile.trim();
    const model = shared!.model.trim();
    const who = agent ? profileLabel(agent) : "this workspace's agent";
    return model ? `Default (${who} · ${model})` : `Default (${who})`;
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
            <option value={profile.id}>{profile.label}</option>
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
  select {
    min-width: 140px;
    max-width: 220px;
  }
  /* Capped at the select's own ceiling so the pair reads as one control
     group. Without it the input is the row's only greedy box, and on the
     workspace Settings tab -- a full-width hub tab, not a modal -- it
     stretched a field that never holds more than a model id across the
     whole pane. */
  input.model {
    flex: 1 1 auto;
    min-width: 0;
    max-width: 220px;
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
</style>
