<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { X, Minus, Square } from "@lucide/svelte";

  let { macOS }: { macOS: boolean } = $props();

  function minimize(): void {
    getCurrentWindow().minimize();
  }

  function toggleMaximize(): void {
    getCurrentWindow().toggleMaximize();
  }

  function close(): void {
    // close(), not destroy() -- close() fires CloseRequested, which
    // +page.svelte's existing onCloseRequested handler already intercepts
    // with the "your sessions will keep running" confirm dialog. Reusing
    // that flow here (rather than duplicating a second confirm prompt) is
    // the whole reason this calls close() instead of destroy().
    getCurrentWindow().close();
  }
</script>

{#if macOS}
  <div class="mac-controls">
    <button class="mac-btn close" aria-label="Close" title="Close" onclick={close}>
      <X size={8} />
    </button>
    <button class="mac-btn minimize" aria-label="Minimize" title="Minimize" onclick={minimize}>
      <Minus size={8} />
    </button>
    <button class="mac-btn maximize" aria-label="Maximize" title="Maximize" onclick={toggleMaximize}>
      <Square size={6} />
    </button>
  </div>
{:else}
  <div class="default-controls">
    <button aria-label="Minimize" title="Minimize" onclick={minimize}>
      <Minus size={14} />
    </button>
    <button aria-label="Maximize" title="Maximize" onclick={toggleMaximize}>
      <Square size={14} />
    </button>
    <button aria-label="Close" title="Close" class="close" onclick={close}>
      <X size={14} />
    </button>
  </div>
{/if}

<style>
  .mac-controls {
    display: flex;
    gap: 8px;
    padding: 0 12px;
    align-items: center;
  }
  .mac-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: none;
    padding: 0;
    cursor: pointer;
    color: transparent;
  }
  .mac-controls:hover .mac-btn {
    color: rgba(0, 0, 0, 0.5);
  }
  /* The traffic lights and the Windows close red below are fixed
     platform colours, not theme roles -- macOS draws the same three
     hexes in light and dark, so they stay literal on purpose. */
  .mac-btn.close {
    background: #ff5f57;
  }
  .mac-btn.minimize {
    background: #febc2e;
  }
  .mac-btn.maximize {
    background: #28c840;
  }

  .default-controls {
    display: flex;
    align-items: center;
    height: 100%;
  }
  .default-controls button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 100%;
    background: transparent;
    border: none;
    color: var(--text);
    cursor: pointer;
  }
  .default-controls button:hover {
    background: var(--surface-hover);
  }
  .default-controls button.close:hover {
    background: #e81123;
    color: #fff;
  }
</style>
