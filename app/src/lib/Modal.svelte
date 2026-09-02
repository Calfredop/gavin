<script lang="ts">
  import { pushModal, popModal, isTopModal } from "./modalStack";

  interface Props {
    onClose: () => void;
    children?: import("svelte").Snippet;
  }
  let { onClose, children }: Props = $props();

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
  <div class="panel" role="dialog" aria-modal="true">
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
