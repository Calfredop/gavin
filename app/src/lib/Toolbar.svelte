<script lang="ts">
  import { layoutState, splitPane, closePane, applyPreset } from "./layoutState";
  import { presetSingle, presetSideBySide, presetGrid2x2 } from "./layout";

  async function split(direction: "row" | "column"): Promise<void> {
    const id = $layoutState.focusedSessionId;
    if (id) await splitPane(id, direction);
  }

  async function handleClosePane(): Promise<void> {
    const id = $layoutState.focusedSessionId;
    if (id) await closePane(id);
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

<div class="toolbar">
  <button onclick={() => split("row")}>Split Right</button>
  <button onclick={() => split("column")}>Split Down</button>
  <button onclick={handleClosePane}>Close Pane</button>
  <div class="presets">
    <span>Presets:</span>
    <button onclick={applySingle}>Single</button>
    <button onclick={applySideBySide}>Side by Side</button>
    <button onclick={applyGrid}>2×2 Grid</button>
  </div>
</div>

<style>
  .toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 4px 8px;
    background: #2a2a2a;
    color: #ccc;
    font-family: sans-serif;
    font-size: 0.8em;
    flex: 0 0 auto;
  }
  .toolbar button {
    background: #3a3a3a;
    border: none;
    color: #ccc;
    padding: 4px 8px;
    border-radius: 3px;
    cursor: pointer;
  }
  .toolbar button:hover {
    background: #4a4a4a;
  }
  .presets {
    display: flex;
    gap: 4px;
    align-items: center;
    margin-left: auto;
  }
</style>
