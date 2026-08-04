<script lang="ts">
  import Modal from "./Modal.svelte";

  interface Props {
    onConfirm: () => void;
    onCancel: () => void;
  }
  let { onConfirm, onCancel }: Props = $props();
</script>

<Modal onClose={onCancel}>
  <p>Delete this card? Its linked session is still running and will be killed too.</p>
  <div class="actions">
    <button type="button" onclick={onCancel}>Cancel</button>
    <button type="button" class="danger" onclick={onConfirm}>Delete card &amp; kill session</button>
  </div>
</Modal>

<style>
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
