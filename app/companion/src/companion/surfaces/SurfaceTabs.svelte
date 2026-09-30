<script lang="ts">
  // The strip under the header that switches an open workspace between
  // its surfaces. The list and the words are viewState.ts's.
  import { SURFACES, SURFACE_LABELS, type Surface } from "$companion/state/viewState";

  interface Props {
    current: Surface;
    onPick: (surface: Surface) => void;
  }
  let { current, onPick }: Props = $props();
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
      {SURFACE_LABELS[surface]}
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
    flex: 1 1 0;
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
</style>
