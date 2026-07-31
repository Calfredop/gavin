<script lang="ts">
  import type { Snippet } from "svelte";

  let { text, children }: { text: string; children: Snippet } = $props();

  let visible = $state(false);
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const HOVER_DELAY_MS = 400;

  function handleMouseEnter(): void {
    timeoutId = setTimeout(() => {
      visible = true;
    }, HOVER_DELAY_MS);
  }

  function handleMouseLeave(): void {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    visible = false;
  }
</script>

<span class="tooltip-wrapper" onmouseenter={handleMouseEnter} onmouseleave={handleMouseLeave}>
  {@render children()}
  {#if visible}
    <span class="tooltip-bubble">{text}</span>
  {/if}
</span>

<style>
  .tooltip-wrapper {
    position: relative;
    display: inline-flex;
    min-width: 0;
  }
  .tooltip-bubble {
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-bottom: 4px;
    padding: 4px 8px;
    background: #000;
    color: #fff;
    font-size: 0.75em;
    font-family: monospace;
    white-space: nowrap;
    border-radius: 4px;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
    pointer-events: none;
    z-index: 100;
  }
</style>
