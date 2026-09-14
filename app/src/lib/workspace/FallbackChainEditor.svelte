<script lang="ts">
  /// Ordered fallback-agent picker. App settings pass a stored chain;
  /// workspace settings pass an override or inherit.
  import type { AgentProfileInfo } from "$lib/core/settings";
  import {
    fallbackThresholdFor,
    type FallbackThresholds,
  } from "$lib/agents/agentFallback";

  interface Props {
    profiles: AgentProfileInfo[];
    value: string[];
    /// When set, the first row is "inherit this".
    inherited?: string[] | null;
    inheriting?: boolean;
    thresholds?: FallbackThresholds | null;
    /// Profile ids whose CLI resolved on PATH (init wizard). Options for
    /// those ids get a "found" suffix; other built-ins get "not found".
    foundIds?: ReadonlySet<string> | null;
    /// Every built-in id the sweep considered (found or not). Needed so
    /// `custom` and unswept ids are not labelled "not found".
    sweptIds?: ReadonlySet<string> | null;
    onChange: (chain: string[] | null) => void;
    onThresholdChange?: (profileId: string, percent: number) => void;
  }
  let {
    profiles,
    value,
    inherited = null,
    inheriting = false,
    thresholds = null,
    foundIds = null,
    sweptIds = null,
    onChange,
    onThresholdChange,
  }: Props = $props();

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

  function probed(id: string): boolean {
    return Boolean(usable.find((p) => p.id === id)?.usageProbe);
  }

  function optionLabel(profile: AgentProfileInfo): string {
    if (!foundIds || !sweptIds || !sweptIds.has(profile.id)) return profile.label;
    return foundIds.has(profile.id)
      ? `${profile.label} (found)`
      : `${profile.label} (not found)`;
  }

  function chainHint(ids: string[]): string {
    return ids
      .map((id) => {
        const label = usable.find((p) => p.id === id)?.label ?? id;
        return probed(id) ? `${label} ${fallbackThresholdFor(id, thresholds)}%` : label;
      })
      .join(" → ");
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
      Following the app-wide chain: {chainHint(inherited)}.
    {/if}
  </p>
{:else}
  {#each rows as id, i (i)}
    <div class="row">
      <select value={id} onchange={(e) => setAt(i, e.currentTarget.value)}>
        {#each usable as profile (profile.id)}
          <option value={profile.id}>{optionLabel(profile)}</option>
        {/each}
      </select>
      {#if probed(id)}
        <input
          class="pct"
          type="number"
          min="1"
          max="100"
          value={fallbackThresholdFor(id, thresholds)}
          disabled={!onThresholdChange}
          onchange={(e) => onThresholdChange?.(id, Number(e.currentTarget.value))}
        />
        <span class="unit">%</span>
      {/if}
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
  .pct {
    width: 4.5em;
    background: #2a2a2a;
    color: #eee;
    border: 1px solid #444;
    padding: 4px 6px;
    font-family: monospace;
  }
  .unit {
    color: #888;
    font-family: monospace;
    font-size: 0.85em;
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
