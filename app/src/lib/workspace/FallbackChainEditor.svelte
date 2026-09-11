<script lang="ts">
  /// Ordered fallback-agent picker. App settings pass a stored chain;
  /// workspace settings pass an override or inherit.
  import type { AgentProfileInfo } from "$lib/core/settings";

  interface Props {
    profiles: AgentProfileInfo[];
    value: string[];
    /// When set, the first row is "inherit this".
    inherited?: string[] | null;
    inheriting?: boolean;
    onChange: (chain: string[] | null) => void;
  }
  let { profiles, value, inherited = null, inheriting = false, onChange }: Props = $props();

  const usable = $derived(profiles.filter((p) => p.id !== "custom" || p.command));
  const rows = $derived(inheriting ? (inherited ?? []) : value);

  function setAt(index: number, id: string): void {
    const next = [...rows];
    next[index] = id;
    onChange(next);
  }
  function removeAt(index: number): void {
    onChange(rows.filter((_, i) => i !== index));
  }
  function addRow(): void {
    const used = new Set(rows);
    const next = usable.find((p) => !used.has(p.id));
    if (!next) return;
    onChange([...rows, next.id]);
  }
</script>

{#if inherited != null}
  <label class="check">
    <input
      type="checkbox"
      checked={!inheriting}
      onchange={(e) => onChange(e.currentTarget.checked ? [...(inherited ?? [])] : null)}
    />
    Give this workspace its own fallback chain
  </label>
{/if}

{#if inheriting && inherited != null}
  <p class="hint">
    {#if inherited.length === 0}
      Following the app-wide chain, which is empty — launches pause when this agent hits its limit.
    {:else}
      Following the app-wide chain: {inherited.join(" → ")}.
    {/if}
  </p>
{:else}
  {#each rows as id, i (i)}
    <div class="row">
      <select value={id} onchange={(e) => setAt(i, e.currentTarget.value)}>
        {#each usable as profile (profile.id)}
          <option value={profile.id}>{profile.label}</option>
        {/each}
      </select>
      <button type="button" class="ghost" onclick={() => removeAt(i)}>Remove</button>
    </div>
  {/each}
  <button type="button" class="ghost" onclick={addRow} disabled={usable.length === 0}>
    Add fallback
  </button>
{/if}

<style>
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #ccc;
    font-family: monospace;
    font-size: 0.85em;
    margin-bottom: 8px;
  }
  .hint {
    margin: 0 0 8px;
    color: #888;
    font-family: monospace;
    font-size: 0.8em;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 6px;
  }
  select {
    flex: 1;
    background: #2a2a2a;
    color: #eee;
    border: 1px solid #444;
    padding: 4px 8px;
    font-family: monospace;
  }
  button.ghost {
    background: transparent;
    color: #888;
    border: none;
    cursor: pointer;
    font-family: monospace;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
