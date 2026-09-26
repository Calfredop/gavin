<script lang="ts">
  import { gitStore, cancelOp } from "$lib/git/gitState";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const op = $derived($gitStore[workspaceId]?.op ?? null);

  // Shown once an op has run for REVEAL_MS. Commits and checkouts are ops
  // too now, for the Cancel a slow hook needs, and most are over in a
  // fraction of that: a bar that appears and vanishes within a frame or
  // two is a layout jump with nothing to read. The toolbar disables
  // itself through `locked` from the first moment either way. Keyed on
  // the id alone, so a progress line does not restart the wait.
  const REVEAL_MS = 300;
  const opId = $derived(op?.id ?? null);
  let revealedId = $state<string | null>(null);
  $effect(() => {
    const id = opId;
    if (id === null) return;
    const timer = setTimeout(() => (revealedId = id), REVEAL_MS);
    return () => clearTimeout(timer);
  });
</script>

{#if op && revealedId === op.id}
  <div class="opbar" role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span>
    <span class="label">{op.label}…</span>
    <span class="line">{op.line ?? ""}</span>
    {#if op.cancellable}
      <button type="button" onclick={() => cancelOp(workspaceId)}>Cancel</button>
    {/if}
  </div>
{/if}

<style>
  .opbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    background: var(--surface-accent);
    border-bottom: 1px solid var(--border-accent);
    font-family: monospace;
    font-size: 0.75em;
    color: var(--accent-text);
  }
  .spinner {
    width: 10px;
    height: 10px;
    border: 2px solid var(--border-accent);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .label {
    color: var(--text);
  }
  .line {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--accent-text);
  }
  button {
    background: transparent;
    border: 1px solid var(--border-accent);
    border-radius: 4px;
    color: var(--accent-text);
    font-family: monospace;
    padding: 1px 8px;
    cursor: pointer;
  }
  button:hover {
    border-color: var(--border-accent);
    color: var(--text);
  }
</style>
