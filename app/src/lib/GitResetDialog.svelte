<script lang="ts">
  import Modal from "./Modal.svelte";
  import { shortSha, type ResetMode } from "./git";

  interface Props {
    sha: string;
    branch: string;
    onConfirm: (mode: ResetMode) => void;
    onCancel: () => void;
  }
  let { sha, branch, onConfirm, onCancel }: Props = $props();

  let mode = $state<ResetMode>("mixed");
  let typed = $state("");
  const short = $derived(shortSha(sha));
  const armed = $derived(mode !== "hard" || typed.trim() === short);
</script>

<Modal onClose={onCancel}>
  <form class="reset" onsubmit={(e) => { e.preventDefault(); if (armed) onConfirm(mode); }}>
    <h3>Reset {branch} to {short}</h3>
    <label class="opt"><input type="radio" bind:group={mode} value="soft" /> <b>Soft</b> — move the branch; keep the index and working tree</label>
    <label class="opt"><input type="radio" bind:group={mode} value="mixed" /> <b>Mixed</b> — move the branch and reset the index; keep the working tree</label>
    <label class="opt danger"><input type="radio" bind:group={mode} value="hard" /> <b>Hard</b> — move the branch and discard all uncommitted changes</label>
    {#if mode === "hard"}
      <label class="confirm">
        <span>Type <code>{short}</code> to confirm</span>
        <input type="text" bind:value={typed} placeholder={short} spellcheck="false" />
      </label>
    {/if}
    <div class="actions">
      <button type="button" onclick={onCancel}>Cancel</button>
      <button type="submit" class:danger={mode === "hard"} disabled={!armed}>Reset</button>
    </div>
  </form>
</Modal>

<style>
  .reset {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 380px;
  }
  h3 {
    margin: 0;
    font-size: 1em;
    color: var(--text);
  }
  .opt {
    display: flex;
    gap: 8px;
    align-items: baseline;
    color: var(--text-muted);
    font-size: 0.8em;
  }
  .opt b {
    color: var(--text);
  }
  .opt.danger b {
    color: var(--danger-text);
  }
  .confirm {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.8em;
    color: var(--warning-text);
  }
  .confirm code {
    color: var(--text);
  }
  .confirm input {
    background: var(--surface-base);
    border: 1px solid var(--border-danger);
    border-radius: 6px;
    color: var(--text);
    font-family: monospace;
    padding: 5px 8px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .actions button {
    background: var(--surface-overlay);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    padding: 5px 12px;
    font-family: monospace;
    cursor: pointer;
  }
  .actions button.danger {
    background: var(--surface-danger);
    border-color: var(--border-danger);
    color: var(--danger-text);
  }
  .actions button:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
