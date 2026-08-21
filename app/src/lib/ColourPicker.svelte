<script lang="ts">
  import { PALETTE, normalizeColor } from "./settings";

  interface Props {
    value: string;
    onChange: (colour: string) => void;
  }
  let { value, onChange }: Props = $props();

  const current = $derived(normalizeColor(value));
</script>

<div class="picker">
  <div class="swatches">
    {#each PALETTE as colour (colour)}
      <button
        type="button"
        class="swatch"
        class:selected={colour === current}
        style:background={colour}
        aria-label="Use {colour}"
        onclick={() => onChange(colour)}
      ></button>
    {/each}
  </div>
  <label class="custom">
    Custom
    <input type="color" value={current} oninput={(e) => onChange(e.currentTarget.value)} />
  </label>
  <!-- A live preview instead of a contrast floor: a near-black accent is
       the user's call, but they should see it before committing. -->
  <span class="preview" style:background={current}></span>
</div>

<style>
  .picker {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .swatches {
    display: flex;
    gap: 5px;
  }
  .swatch {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 2px solid transparent;
    cursor: pointer;
    padding: 0;
  }
  .swatch.selected {
    border-color: var(--text);
  }
  .custom {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.8em;
  }
  .custom input {
    width: 26px;
    height: 20px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .preview {
    width: 60px;
    height: 3px;
    border-radius: 2px;
  }
</style>
