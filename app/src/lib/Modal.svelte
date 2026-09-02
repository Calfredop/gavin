<script lang="ts">
  interface Props {
    onClose: () => void;
    // Identity of what the panel is showing. A modal that can be
    // repointed at something else without unmounting (the card detail
    // navigating to a nested task) keeps the old scroll offset
    // otherwise, which on shorter content lands the reader at the
    // bottom of a card they have not seen the top of.
    scrollKey?: string;
    children?: import("svelte").Snippet;
  }
  let { onClose, scrollKey, children }: Props = $props();

  let panel = $state<HTMLDivElement | null>(null);
  $effect(() => {
    if (scrollKey === undefined) return;
    if (panel) panel.scrollTop = 0;
  });

  function handleBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) onClose();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") onClose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="backdrop" onclick={handleBackdropClick} role="presentation">
  <div class="panel" role="dialog" aria-modal="true" bind:this={panel}>
    {@render children?.()}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .panel {
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 20px;
    min-width: 320px;
    max-width: 480px;
    max-height: 80vh;
    overflow-y: auto;
    color: var(--text);
    font-family: monospace;
  }
</style>
