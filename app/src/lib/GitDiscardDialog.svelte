<script lang="ts">
  import Modal from "./Modal.svelte";

  interface Props {
    title: string;
    body: string;
    offerSkip: boolean;
    onConfirm: (skip: boolean) => void;
    onCancel: () => void;
    /// Primary button text; "Discard" by default — SP2 reuses this dialog
    /// for every destructive confirm (delete branch, drop stash, …).
    confirmLabel?: string;
    cancelLabel?: string;
    /// Label of the checkbox shown when `offerSkip`; its value reaches
    /// `onConfirm`. Defaults to SP1's "don't ask again" wording.
    skipLabel?: string;
  }
  let {
    title,
    body,
    offerSkip,
    onConfirm,
    onCancel,
    confirmLabel = "Discard",
    cancelLabel = "Cancel",
    skipLabel = "Don't ask again for hunks and lines",
  }: Props = $props();

  let skip = $state(false);
</script>

<Modal onClose={onCancel}>
  <h3>{title}</h3>
  <pre class="body">{body}</pre>
  {#if offerSkip}
    <label class="skip"><input type="checkbox" bind:checked={skip} /> {skipLabel}</label>
  {/if}
  <div class="actions">
    <button type="button" onclick={onCancel}>{cancelLabel}</button>
    <button type="button" class="danger" onclick={() => onConfirm(skip)}>{confirmLabel}</button>
  </div>
</Modal>

<style>
  h3 {
    margin: 0 0 10px;
    font-size: 1em;
    color: #eee;
  }
  .body {
    margin: 0 0 12px;
    white-space: pre-wrap;
    color: #bbb;
    font-size: 0.85em;
    max-height: 40vh;
    overflow: auto;
  }
  .skip {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #999;
    font-size: 0.8em;
    margin-bottom: 12px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .actions button {
    background: #333;
    border: 1px solid #444;
    border-radius: 6px;
    color: #ddd;
    padding: 5px 12px;
    font-family: monospace;
    cursor: pointer;
  }
  .actions .danger {
    background: #4a2020;
    border-color: #7a3030;
    color: #f0c0c0;
  }
</style>
