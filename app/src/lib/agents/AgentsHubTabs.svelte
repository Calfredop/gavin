<script lang="ts">
  import { ADD_TAB, type AgentsHubTab, type AgentsHubTabDef } from "$lib/agents/agentsHub";
  import { tooltip } from "$lib/core/tooltip";
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import type { Indicator } from "$lib/ui/indicators";

  interface Props {
    tabs: readonly AgentsHubTabDef[];
    tab: AgentsHubTab;
    label?: string;
    /// Optional per-tab semaphore (keyed by tab id). Settings leaves this
    /// empty; the usage modal puts each agent's projection band here so
    /// the tab strip answers the same question the sidebar footer does.
    indicators?: Readonly<Record<string, Indicator | null | undefined>>;
    /// Settings keeps wrap so a long agents list still fits a narrow
    /// pane. The usage modal turns it off and widens instead, so every
    /// agent stays on one row.
    wrap?: boolean;
    onTab: (tab: AgentsHubTab) => void;
  }
  let { tabs, tab, label = "Agents", indicators, wrap = true, onTab }: Props = $props();
</script>

<div class="tabs" class:nowrap={!wrap} role="tablist" aria-label={label}>
  {#each tabs as t (t.id)}
    {@const indicator = indicators?.[t.id] ?? null}
    <button
      type="button"
      role="tab"
      id="agents-tab-{t.id}"
      aria-selected={tab === t.id}
      tabindex={tab === t.id ? 0 : -1}
      class:on={tab === t.id}
      class:add={t.id === ADD_TAB}
      aria-label={t.hint ? `${t.label} — ${t.hint}` : undefined}
      use:tooltip={t.hint ?? ""}
      onclick={() => onTab(t.id)}
    >
      <span class="label">{t.label}</span>
      {#if indicator}
        <StatusBadge {indicator} size={11} />
      {/if}
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
  .tabs.nowrap {
    flex-wrap: nowrap;
    width: max-content;
    max-width: 100%;
  }
  .tabs button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
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
  /* The "+" tab is a control, not an agent: narrower, and its glyph larger
     so it reads as an add affordance rather than a one-character name. */
  .tabs button.add {
    padding-inline: 14px;
  }
  .tabs button.add .label {
    font-size: 1.15em;
    line-height: 1;
  }
  .tabs button.on {
    color: var(--text);
    border-bottom-color: var(--border-focus, var(--accent, #4a9eff));
  }
</style>
