<script lang="ts">
  import { pushModal, popModal, isTopModal } from "./modalStack";

  interface Props {
    onClose: () => void;
    // Identity of what the panel is showing. A modal that can be
    // repointed at something else without unmounting (the card detail
    // navigating to a nested task) keeps the old scroll offset
    // otherwise, which on shorter content lands the reader at the
    // bottom of a card they have not seen the top of.
    scrollKey?: string;
    // Lifts the panel's width cap for content that is a TABLE rather
    // than a column of label/control rows. Opt-in rather than a width
    // the child sets on its own contents: the cap lives on .panel, which
    // is scoped here, so a child wider than 480px otherwise just
    // overflows the panel it is inside.
    wide?: boolean;
    children?: import("svelte").Snippet;
  }
  let { onClose, scrollKey, wide = false, children }: Props = $props();

  let panel = $state<HTMLDivElement | null>(null);
  $effect(() => {
    if (scrollKey === undefined) return;
    if (panel) panel.scrollTop = 0;
  });

  // Registered for as long as this modal is on screen, so an Escape
  // reaches only the topmost one -- see modalStack.ts for why the
  // window-level listener needs it.
  let token = $state<symbol | null>(null);
  $effect(() => {
    const mine = pushModal();
    token = mine;
    return () => popModal(mine);
  });

  function handleBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) onClose();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    if (token && !isTopModal(token)) return;
    onClose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="backdrop" onclick={handleBackdropClick} role="presentation">
  <div class="panel" class:wide role="dialog" aria-modal="true" bind:this={panel}>
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
  .panel.wide {
    max-width: min(880px, 92vw);
  }
</style>
