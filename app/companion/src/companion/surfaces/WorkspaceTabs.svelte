<script lang="ts">
  // The open workspace's surfaces, one tap apart: its board, its rails
  // and its sessions.
  import type { Surface } from "$companion/state/viewState";

  interface Props {
    surface: Surface;
    onShow: (surface: Surface) => void;
    /// Agents in the workspace waiting on the human, counted on the
    /// Sessions tab: the reason to go there.
    waiting: number;
  }
  let { surface, onShow, waiting }: Props = $props();

  const TABS: { surface: Surface; label: string }[] = [
    { surface: "board", label: "Board" },
    { surface: "rails", label: "Rails" },
    { surface: "sessions", label: "Sessions" },
  ];
</script>

<div class="tabs" role="tablist" aria-label="Workspace">
  {#each TABS as tab (tab.surface)}
    <button
      type="button"
      role="tab"
      class="tab"
      class:shown={tab.surface === surface}
      aria-selected={tab.surface === surface}
      onclick={() => onShow(tab.surface)}
    >
      <span>{tab.label}</span>
      {#if tab.surface === "sessions" && waiting > 0}
        <span class="count" aria-label="{waiting} waiting for you">{waiting}</span>
      {/if}
    </button>
  {/each}
</div>

<style>
  .tabs {
    display: flex;
    flex: 0 0 auto;
    padding: 0 max(8px, env(safe-area-inset-right)) 0 max(8px, env(safe-area-inset-left));
    border-bottom: 1px solid var(--border);
    background: var(--surface-sunken);
  }
  .tab {
    display: inline-flex;
    flex: 1 1 0;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 44px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--text-muted);
    font-size: 0.875rem;
  }
  .tab.shown {
    border-bottom-color: var(--accent);
    color: var(--text);
  }
  .tab:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }
  /* The amber of everything that wants a human (indicators.ts). */
  .count {
    min-width: 18px;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--surface-warning);
    color: var(--warning-text);
    font-size: 0.75rem;
    font-weight: 600;
    line-height: 18px;
  }
</style>
