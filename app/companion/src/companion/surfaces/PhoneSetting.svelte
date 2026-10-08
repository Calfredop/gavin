<script lang="ts">
  // One setting: its name over its control, and what it does under it. The
  // desk puts the name beside the control; a phone has the width for one
  // of the two, so the control gets it.
  //
  // The control is the caller's -- a select, a field, the desk's own
  // component -- and is sized here for a thumb: 44px tall, 16px text so iOS
  // does not zoom into it, the full width of the column.
  import type { Snippet } from "svelte";

  interface Props {
    label: string;
    /// The control's id, so a tap on the label focuses it.
    control?: string | null;
    hint?: string | null;
    /// Why the control is dark, or something that stands in its way.
    warn?: string | null;
    children: Snippet;
  }
  let { label, control = null, hint = null, warn = null, children }: Props = $props();
</script>

<div class="setting">
  {#if control}
    <label class="label" for={control}>{label}</label>
  {:else}
    <span class="label">{label}</span>
  {/if}
  <div class="control">
    {@render children()}
  </div>
  {#if warn}<p class="warn">{warn}</p>{/if}
  {#if hint}<p class="hint">{hint}</p>{/if}
</div>

<style>
  .setting {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .label {
    color: var(--text);
    font-size: 0.875rem;
    font-weight: 500;
  }
  .control {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  /* Scoped to this component's own wrapper: the caller's controls, not the
     page's. */
  .control :global(select),
  .control :global(input:not([type="checkbox"]):not([type="color"])) {
    min-width: 0;
    min-height: 44px;
    box-sizing: border-box;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-base);
    color: var(--text);
    font-family: monospace;
    font-size: max(16px, 1rem);
  }
  /* A name or a choice takes the row; a count is a few digits wide. */
  .control :global(select),
  .control :global(input:not([type="checkbox"]):not([type="color"]):not([type="number"])) {
    flex: 1 1 12em;
  }
  .control :global(input[type="number"]) {
    flex: 0 0 5.5em;
  }
  .control :global(select:disabled),
  .control :global(input:disabled) {
    opacity: 0.5;
  }
  .control :global(select:focus),
  .control :global(input:focus) {
    border-color: var(--border-accent);
    outline: none;
  }
  .control :global(.unit) {
    color: var(--text-muted);
    font-size: 0.8125rem;
  }
  .hint,
  .warn {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.45;
  }
  .hint {
    color: var(--text-subtle);
  }
  .warn {
    color: var(--warning-text);
  }
</style>
