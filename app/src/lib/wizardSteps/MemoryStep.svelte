<script lang="ts">
  import { layoutState } from "$lib/core/layoutState";
  import { memoryStepView, saveMemorySkipped, type MemoryReading } from "$lib/cards/memoryIndex";
  import { prepareMemoryIndex, watchMemoryIndex } from "$lib/cards/memoryIndexState";

  interface Props {
    workspaceId: string;
    /// Owned by the wizard, because the stepper's tick for this step is
    /// derived from the same reading.
    reading: MemoryReading | undefined;
    onChanged: () => void;
    onDone: () => void;
  }
  let { workspaceId, reading, onChanged, onDone }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const root = $derived(ws?.rootPath || null);
  const view = $derived(memoryStepView(reading));
  let starting = $state(false);

  // Live while the step is on screen: a download started here is
  // followed until the index is built.
  $effect(() => {
    if (root) return watchMemoryIndex(root);
  });

  /// Download the model if it is missing and build the index. Takes back
  /// an earlier "not now": the human just said yes.
  async function prepare(): Promise<void> {
    if (!root) return;
    starting = true;
    try {
      saveMemorySkipped(root, false);
      onChanged();
      await prepareMemoryIndex(root);
    } finally {
      starting = false;
    }
  }

  /// "Not now" is a decision, recorded per machine and root, and it is
  /// what finishes the step without a model -- never a fake "ready".
  function notNow(): void {
    if (root) saveMemorySkipped(root, true);
    onChanged();
    onDone();
  }
</script>

<h3>Memory</h3>
<p class="hint">
  Facts you adopt from memory cards land under <code>### Learned</code> in the instructions file. With
  this on, agents can also search them by meaning — <code>gavin_search_memories</code> — so a fact
  is found in whatever words the agent asks. gavin runs a small embedding model on this machine;
  nothing leaves it. Optional.
</p>

{#if reading === undefined}
  <p class="hint">Checking…</p>
{:else}
  <div class="row">
    <span class="label tone-{view.tone}">{view.label}</span>
    <span class="line">{view.line}</span>
  </div>

  <div class="actions">
    <button type="button" class="ghost" onclick={notNow}>Not now</button>
    {#if view.action}
      <button type="button" disabled={starting || view.busy} onclick={() => void prepare()}>
        {starting ? "Starting…" : view.action}
      </button>
    {/if}
    <button type="button" onclick={onDone}>Continue →</button>
  </div>
{/if}

<style>
  h3 {
    margin: 0 0 4px;
    font-size: 0.95em;
    font-family: monospace;
    color: #eee;
  }
  .hint {
    margin: 0 0 16px;
    color: #888;
    font-family: monospace;
    font-size: 0.8em;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    background: #2a2a2a;
    border: 1px solid #3a3a3a;
    border-radius: 6px;
    padding: 10px 12px;
    color: #ccc;
    font-family: monospace;
    font-size: 0.8em;
  }
  .label {
    flex: none;
    font-weight: bold;
  }
  .tone-on {
    color: #8bc98b;
  }
  .tone-warn {
    color: #e0b08a;
  }
  .tone-off,
  .tone-unknown {
    color: #888;
  }
  .line {
    min-width: 0;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 18px;
  }
  .actions button {
    background: #3a3a3a;
    border: none;
    color: #eee;
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
  .actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .actions button.ghost {
    background: none;
    color: #888;
  }
</style>
