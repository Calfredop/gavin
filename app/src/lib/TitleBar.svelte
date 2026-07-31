<script lang="ts">
  import { onMount } from "svelte";
  import { layoutState, splitPane, closePane, applyPreset } from "./layoutState";
  import { presetSingle, presetSideBySide, presetGrid2x2 } from "./layout";
  import { confirmPaneClose } from "./confirmClose";
  import { Columns2, Rows2, X, Square, Grid2x2 } from "@lucide/svelte";
  import WindowControls from "./WindowControls.svelte";
  import { isMacOS } from "./platform";

  let macOS = $state(false);
  onMount(async () => {
    macOS = await isMacOS();
  });

  async function split(direction: "row" | "column"): Promise<void> {
    const id = $layoutState.focusedSessionId;
    if (id) await splitPane(id, direction);
  }

  async function handleClosePane(): Promise<void> {
    const id = $layoutState.focusedSessionId;
    if (!id) return;
    if (await confirmPaneClose(id)) {
      await closePane(id);
    }
  }

  async function applySingle(): Promise<void> {
    await applyPreset(([id]) => presetSingle(id), 1);
  }
  async function applySideBySide(): Promise<void> {
    await applyPreset(([a, b]) => presetSideBySide(a, b), 2);
  }
  async function applyGrid(): Promise<void> {
    await applyPreset(([a, b, c, d]) => presetGrid2x2(a, b, c, d), 4);
  }
</script>

{#snippet actions()}
  <button aria-label="Split Right" title="Split Right" onclick={() => split("row")}>
    <Columns2 size={16} />
  </button>
  <button aria-label="Split Down" title="Split Down" onclick={() => split("column")}>
    <Rows2 size={16} />
  </button>
  <button aria-label="Close Pane" title="Close Pane" onclick={handleClosePane}>
    <X size={16} />
  </button>
  <div class="presets">
    <span>Presets:</span>
    <button onclick={applySingle}><Square size={14} /> Single</button>
    <button onclick={applySideBySide}><Columns2 size={14} /> Side by Side</button>
    <button onclick={applyGrid}><Grid2x2 size={14} /> 2×2 Grid</button>
  </div>
{/snippet}

<div class="titlebar">
  {#if macOS}
    <WindowControls {macOS} />
    <div class="drag-spacer" data-tauri-drag-region></div>
    <div class="actions">{@render actions()}</div>
  {:else}
    <div class="actions">{@render actions()}</div>
    <div class="drag-spacer" data-tauri-drag-region></div>
    <WindowControls {macOS} />
  {/if}
</div>

<style>
  .titlebar {
    display: flex;
    align-items: center;
    background: #2a2a2a;
    color: #ccc;
    font-family: sans-serif;
    font-size: 0.8em;
    flex: 0 0 auto;
    height: 40px;
  }
  .drag-spacer {
    flex: 1 1 auto;
    height: 100%;
  }
  .actions {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 4px 8px;
  }
  .actions button {
    display: flex;
    align-items: center;
    gap: 4px;
    background: #3a3a3a;
    border: none;
    color: #ccc;
    padding: 4px 8px;
    border-radius: 3px;
    cursor: pointer;
  }
  .actions button:hover {
    background: #4a4a4a;
  }
  .presets {
    display: flex;
    gap: 4px;
    align-items: center;
    margin-left: 8px;
  }
</style>
