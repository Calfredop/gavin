<script lang="ts">
  // The keys panel, a debug build's only: a thin template over
  // keys/keysPanel.ts. Closed, at the hub's foot: pairing makes and uses
  // the keys for real, and this is for looking at them, never in the way
  // of Pair.
  import { onMount } from "svelte";
  import type { DeviceKeysPlugin } from "$shell/native/deviceKeys";
  import { panelAction, statusLines, type PanelAction, type PanelLine } from "$shell/keys/keysPanel";

  interface Props {
    keys: DeviceKeysPlugin;
  }
  let { keys }: Props = $props();

  let lines = $state<PanelLine[]>([]);
  let result = $state<PanelLine | null>(null);
  let busy = $state(false);
  let hasKeys = $state(false);

  async function refresh(): Promise<void> {
    try {
      const status = await keys.status();
      lines = statusLines(status);
      hasKeys = status.keys !== null;
    } catch (e) {
      lines = [{ tone: "problem", text: `The keys plugin did not answer: ${e instanceof Error ? e.message : String(e)}` }];
    }
  }

  async function run(action: PanelAction): Promise<void> {
    busy = true;
    result = await panelAction(keys, action);
    await refresh();
    busy = false;
  }

  onMount(() => void refresh());
</script>

<details class="keys">
  <summary>Device keys <span class="tag">debug</span></summary>
  {#each lines as line}
    <p class="line tone-{line.tone}">{line.text}</p>
  {/each}
  <div class="actions">
    <button type="button" class="action" disabled={busy || hasKeys} onclick={() => run("create")}>Create keys</button>
    <button type="button" class="action" disabled={busy || !hasKeys} onclick={() => run("sign")}>Sign</button>
    <button type="button" class="action" disabled={busy || !hasKeys} onclick={() => run("delete")}>Delete keys</button>
  </div>
  {#if result}
    <p class="line tone-{result.tone}" role="status">{result.text}</p>
  {/if}
</details>

<style>
  .keys {
    margin: var(--space-3) var(--space-2) 0;
    padding: 0 var(--space-2);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  summary {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--text-muted);
    font-size: 0.875rem;
    font-weight: 600;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary::after {
    margin-left: auto;
    content: "Show";
    font-weight: 400;
  }
  .keys[open] summary::after {
    content: "Hide";
  }
  .tag {
    padding: 2px 6px;
    border: 1px solid var(--border-warning);
    border-radius: 4px;
    background: var(--surface-warning);
    color: var(--warning-text);
    font-size: 0.6875rem;
    font-weight: 400;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .line {
    margin: 0 0 var(--space-1);
    font-size: 0.8125rem;
    line-height: 1.45;
  }
  .tone-ok {
    color: var(--success-text);
  }
  .tone-problem {
    color: var(--danger-text);
  }
  .tone-muted {
    color: var(--text-muted);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin: var(--space-1) 0 var(--space-2);
  }
  .action {
    flex: 1 1 0;
    min-height: 44px;
    padding: 0 var(--space-2);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.875rem;
  }
  .action:active:not(:disabled) {
    background: var(--surface-hover);
  }
  .action:disabled {
    opacity: 0.5;
  }
  .action:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
</style>
