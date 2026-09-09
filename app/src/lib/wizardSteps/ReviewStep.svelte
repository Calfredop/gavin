<script lang="ts">
  import { layoutState, requireReviewDefault, setWorkspaceRequireReview, markRequireReviewAsked } from "$lib/layoutState";
  import {
    requireReviewFromSelect,
    requireReviewOptions,
    requireReviewToSelect,
    resolveRequireReview,
  } from "$lib/cards/cardReview";

  interface Props {
    workspaceId: string;
    onDone: () => void;
  }
  let { workspaceId, onDone }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const inherited = $derived(resolveRequireReview(undefined, $requireReviewDefault));

  /// Picking a side acts immediately, like the app-wide and per-workspace
  /// pickers on the Settings tab -- there is no separate Save here.
  function pick(value: string): void {
    void setWorkspaceRequireReview(workspaceId, requireReviewFromSelect(value));
  }

  /// Continue records that the question was PUT, which is the whole of
  /// this step's evidence -- both answers are legitimate, and leaving the
  /// gate on its default is indistinguishable on disk from nobody having
  /// decided. Marking even when nothing was clicked is deliberate: the
  /// default is the answer most people will give.
  async function done(): Promise<void> {
    await markRequireReviewAsked(workspaceId);
    onDone();
  }
</script>

<h3>Review before Run</h3>
<p class="hint">
  Before a card's content reaches an agent for the first time, gavin shows exactly what it will
  receive — the body, its attachments, whether it carries an auto-commit instruction — and asks for a
  deliberate yes. A clone of this repository can carry a card whose body is somebody else's
  instruction, which is what the gate is for. You can change this later on the workspace's Settings
  tab.
</p>

{#if ws}
  <div class="row">
    <span>Require review</span>
    <select value={requireReviewToSelect(ws.requireReview)} onchange={(e) => pick(e.currentTarget.value)}>
      {#each requireReviewOptions(inherited) as opt (opt.value)}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </select>
  </div>
{/if}

<div class="actions">
  <button type="button" onclick={() => void done()}>Continue →</button>
</div>

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
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    background: #2a2a2a;
    border: 1px solid #3a3a3a;
    border-radius: 6px;
    padding: 10px 12px;
    color: #ccc;
    font-family: monospace;
  }
  .row select {
    background: #1e1e1e;
    color: #eee;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    padding: 4px 6px;
    font-family: monospace;
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
</style>
