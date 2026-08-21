<script lang="ts">
  import Modal from "./Modal.svelte";

  interface Choice {
    label: string;
    danger?: boolean;
    // True when this choice consumes the picker's value: disabled while
    // the picker has nothing to offer.
    needsPick?: boolean;
    onPick: (picked: string | null) => void;
  }

  interface PickerOption {
    value: string;
    label: string;
  }

  interface Props {
    title: string;
    // Consequence lines, rendered as a list -- spell out exactly what
    // will happen (files deleted, tasks un-parented, sessions kept).
    lines: string[];
    // Optional destination picker (e.g. where a deleted column's cards
    // should go); its value is handed to the chosen action.
    picker?: { label: string; options: PickerOption[] } | null;
    choices: Choice[];
    onCancel: () => void;
  }
  let { title, lines, picker = null, choices, onCancel }: Props = $props();

  let picked = $state<string | null>(null);
  // Defaulted in an effect rather than at declaration: reading `picker`
  // once would freeze the first render's value.
  $effect(() => {
    if (picked === null && picker && picker.options.length > 0) picked = picker.options[0].value;
  });
</script>

<Modal onClose={onCancel}>
  <div class="title">{title}</div>
  <ul class="lines">
    {#each lines as line, i (i)}
      <li>{line}</li>
    {/each}
  </ul>
  {#if picker && picker.options.length > 0}
    <label class="picker">
      <span>{picker.label}</span>
      <select bind:value={picked}>
        {#each picker.options as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </label>
  {/if}
  <div class="actions">
    <button type="button" onclick={onCancel}>Cancel</button>
    {#each choices as choice (choice.label)}
      <button
        type="button"
        class:danger={choice.danger}
        disabled={choice.needsPick && picked === null}
        onclick={() => choice.onPick(picked)}
      >
        {choice.label}
      </button>
    {/each}
  </div>
</Modal>

<style>
  .title {
    font-family: monospace;
    font-weight: bold;
    color: var(--text);
    margin-bottom: 10px;
  }
  .lines {
    font-family: monospace;
    font-size: 0.85em;
    color: var(--text-muted);
    margin: 0 0 14px;
    padding-left: 18px;
  }
  .lines li {
    margin-bottom: 4px;
  }
  .picker {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: monospace;
    font-size: 0.85em;
    color: var(--text-muted);
    margin-bottom: 14px;
  }
  .picker select {
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: monospace;
    padding: 3px 6px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .actions button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .actions button {
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 6px 14px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
  .actions button.danger {
    background: var(--surface-danger);
    color: var(--danger-text);
  }
  .actions button.danger:hover {
    background: var(--surface-danger);
  }
</style>
