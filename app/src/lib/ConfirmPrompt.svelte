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
    {#each lines as line (line)}
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
    color: #eee;
    margin-bottom: 10px;
  }
  .lines {
    font-family: monospace;
    font-size: 0.85em;
    color: #bbb;
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
    background: #3a3a3a;
    border: none;
    color: #eee;
    padding: 6px 14px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
  .actions button.danger {
    background: #5a2f2a;
    color: #f0c0b8;
  }
  .actions button.danger:hover {
    background: #6e3730;
  }
</style>
