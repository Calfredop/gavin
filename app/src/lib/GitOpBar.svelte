<script lang="ts">
  import { gitStore, cancelOp } from "$lib/gitState";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const op = $derived($gitStore[workspaceId]?.op ?? null);
</script>

{#if op}
  <div class="opbar" role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span>
    <span class="label">{op.label}…</span>
    <span class="line">{op.line ?? ""}</span>
    <button type="button" onclick={() => cancelOp(workspaceId)}>Cancel</button>
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
