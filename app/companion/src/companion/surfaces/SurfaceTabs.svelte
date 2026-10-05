<script lang="ts">
  // The strip under the header that switches an open workspace between
  // its surfaces. The list and the words are viewState.ts's.
  import { SURFACES, SURFACE_LABELS, type Surface } from "$companion/state/viewState";

  interface Props {
    current: Surface;
    onPick: (surface: Surface) => void;
    /// Agents in the workspace waiting on the human, counted on the
    /// Sessions tab: the reason to go there.
    waiting: number;
  }
  let { current, onPick, waiting }: Props = $props();
</script>

<div class="tabs" role="tablist" aria-label="Surfaces">
  {#each SURFACES as surface (surface)}
    <button
      type="button"
      role="tab"
      class="tab"
      class:shown={surface === current}
      aria-selected={surface === current}
      onclick={() => onPick(surface)}
    >
      <span>{SURFACE_LABELS[surface]}</span>
      {#if surface === "sessions" && waiting > 0}
        <span class="count" aria-label="{waiting} waiting for you">{waiting}</span>
      {/if}
    </button>
  {/each}
</div>

<style>
  /* Six surfaces outgrow a narrow phone: the strip scrolls sideways
     rather than squeezing a label onto two lines. */
  .tabs {
    display: flex;
    flex: 0 0 auto;
    overflow-x: auto;
    scrollbar-width: none;
    padding: 0 max(8px, env(safe-area-inset-right)) 0 max(8px, env(safe-area-inset-left));
    border-bottom: 1px solid var(--border);
    background: var(--surface-sunken);
  }
  .tab {
    display: inline-flex;
    flex: 1 0 auto;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 44px;
    padding: 0 10px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--text-muted);
    font-size: 0.875rem;
    white-space: nowrap;
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
