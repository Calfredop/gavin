<script lang="ts">
  import Modal from "./Modal.svelte";

  interface Choice {
    label: string;
    danger?: boolean;
    onPick: () => void;
  }

  interface Props {
    title: string;
    // Consequence lines, rendered as a list -- spell out exactly what
    // will happen (files deleted, tasks un-parented, sessions kept).
    lines: string[];
    choices: Choice[];
    onCancel: () => void;
  }
  let { title, lines, choices, onCancel }: Props = $props();
</script>

<Modal onClose={onCancel}>
  <div class="title">{title}</div>
  <ul class="lines">
    {#each lines as line, i (i)}
      <li>{line}</li>
    {/each}
  </ul>
  <div class="actions">
    <button type="button" onclick={onCancel}>Cancel</button>
    {#each choices as choice (choice.label)}
      <button type="button" class:danger={choice.danger} onclick={choice.onPick}>{choice.label}</button>
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
