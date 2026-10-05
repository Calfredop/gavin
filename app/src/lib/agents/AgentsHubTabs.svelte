<script lang="ts">
  import type { AgentsHubTab, AgentsHubTabDef } from "$lib/agents/agentsHub";

  interface Props {
    tabs: readonly AgentsHubTabDef[];
    tab: AgentsHubTab;
    label?: string;
    onTab: (tab: AgentsHubTab) => void;
  }
  let { tabs, tab, label = "Agents", onTab }: Props = $props();
</script>

<div class="tabs" role="tablist" aria-label={label}>
  {#each tabs as t (t.id)}
    <button
      type="button"
      role="tab"
      id="agents-tab-{t.id}"
      aria-selected={tab === t.id}
      tabindex={tab === t.id ? 0 : -1}
      class:on={tab === t.id}
      onclick={() => onTab(t.id)}
    >
      {t.label}
    </button>
  {/each}
</div>

<style>
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 0 0 14px;
    border-bottom: 1px solid var(--border);
  }
  .tabs button {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    min-height: 44px;
    padding: 8px 12px;
    color: var(--text-muted);
    font-family: inherit;
    font-size: 0.92em;
    cursor: pointer;
  }
  .tabs button:hover {
    color: var(--text);
    background: var(--surface-overlay);
  }
  .tabs button.on {
    color: var(--text);
    border-bottom-color: var(--border-focus, var(--accent, #4a9eff));
  }
</style>
