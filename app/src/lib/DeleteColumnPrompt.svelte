<script lang="ts">
  import Modal from "./Modal.svelte";

  interface Props {
    columnName: string;
    cardCount: number;
    otherColumns: { id: string; name: string }[];
    onDeleteCards: () => void;
    onMoveCards: (targetColumnId: string) => void;
    onCancel: () => void;
  }
  let { columnName, cardCount, otherColumns, onDeleteCards, onMoveCards, onCancel }: Props = $props();

  let selectedTarget = $state(otherColumns[0]?.id ?? "");
</script>

<Modal onClose={onCancel}>
  <p>
    "{columnName}" has {cardCount} {cardCount === 1 ? "card" : "cards"}. Delete them along with the column, or move
    them somewhere else first?
  </p>
  {#if otherColumns.length > 0}
    <label class="field">
      Move to
      <select bind:value={selectedTarget}>
        {#each otherColumns as col (col.id)}
          <option value={col.id}>{col.name}</option>
        {/each}
      </select>
    </label>
  {/if}
  <div class="actions">
    <button type="button" onclick={onCancel}>Cancel</button>
    {#if otherColumns.length > 0}
      <button type="button" onclick={() => onMoveCards(selectedTarget)}>Move cards</button>
    {/if}
    <button type="button" class="danger" onclick={onDeleteCards}>Delete cards</button>
  </div>
</Modal>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 12px 0;
    font-size: 0.85em;
  }
  select {
    background: #1e1e1e;
    border: 1px solid #444;
    color: #eee;
    font-family: monospace;
    padding: 4px 6px;
    border-radius: 4px;
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
  .actions button.danger {
    background: #6b2b2b;
  }
</style>
