<script lang="ts">
  import Modal from "./Modal.svelte";
  import type { Card, Label, Priority } from "./kanban";

  interface Props {
    card: Card;
    labels: Label[];
    onSave: (patch: { title: string; description: string; priority: Priority; labelIds: string[] }) => void;
    onClose: () => void;
  }
  let { card, labels, onSave, onClose }: Props = $props();

  let title = $state(card.title);
  let description = $state(card.description);
  let priority = $state<Priority>(card.priority);
  let labelIds = $state<string[]>([...card.labelIds]);

  const PRIORITIES: Priority[] = ["none", "low", "medium", "high", "urgent"];

  function toggleLabel(labelId: string): void {
    labelIds = labelIds.includes(labelId) ? labelIds.filter((id) => id !== labelId) : [...labelIds, labelId];
  }

  function handleSave(): void {
    onSave({ title, description, priority, labelIds });
    onClose();
  }
</script>

<Modal {onClose}>
  <label class="field">
    Title
    <input type="text" bind:value={title} />
  </label>
  <label class="field">
    Description
    <textarea bind:value={description} rows="4"></textarea>
  </label>
  <label class="field">
    Priority
    <select bind:value={priority}>
      {#each PRIORITIES as p (p)}
        <option value={p}>{p}</option>
      {/each}
    </select>
  </label>
  {#if labels.length > 0}
    <div class="field">
      Labels
      <div class="labels">
        {#each labels as label (label.id)}
          <button
            type="button"
            class="label-chip"
            class:active={labelIds.includes(label.id)}
            style:border-color={label.color}
            onclick={() => toggleLabel(label.id)}
          >
            {label.name}
          </button>
        {/each}
      </div>
    </div>
  {/if}
  <div class="actions">
    <button type="button" onclick={onClose}>Cancel</button>
    <button type="button" onclick={handleSave}>Save</button>
  </div>
</Modal>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 12px;
    font-size: 0.85em;
  }
  input,
  textarea,
  select {
    background: #1e1e1e;
    border: 1px solid #444;
    color: #eee;
    font-family: monospace;
    padding: 4px 6px;
    border-radius: 4px;
  }
  .labels {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .label-chip {
    background: transparent;
    border: 1px solid #666;
    color: #eee;
    border-radius: 12px;
    padding: 2px 10px;
    font-size: 0.8em;
    cursor: pointer;
  }
  .label-chip.active {
    background: #3a3a3a;
    border-width: 2px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
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
</style>
