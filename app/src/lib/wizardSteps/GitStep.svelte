<script lang="ts">
  import { layoutState, markGitTrackingAsked } from "./../layoutState";
  import * as backend from "./../backend";
  import ConfirmPrompt from "./../ConfirmPrompt.svelte";
  import {
    canToggleTracking,
    needsUntrackConfirm,
    trackingSummary,
    untrackConfirm,
    type ConfirmCopy,
    type GavinTracking,
  } from "./../gitTracking";

  interface Props {
    workspaceId: string;
    onDone: () => void;
  }
  let { workspaceId, onDone }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);

  /// What git says right now. Read here rather than handed down from the
  /// wizard, unlike the Superpowers pair: the stepper's tick for this step
  /// is derived from a recorded answer, not from this, so the wizard has
  /// no reason to hold it.
  ///
  /// null while a read is out, and every control waits on it. Rendering a
  /// picked side for an unknown state is how a click lands on the opposite
  /// of what the human saw.
  let status = $state<GavinTracking | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let untrackPrompt = $state<ConfirmCopy | null>(null);
  let token = 0;

  async function read(): Promise<void> {
    const root = ws?.rootPath;
    status = null;
    error = null;
    const mine = ++token;
    if (!root) return;
    try {
      const next = await backend.gavinGitTracking(root);
      if (mine === token) status = next;
    } catch (e) {
      if (mine === token) error = String(e);
    }
  }

  $effect(() => {
    void ws?.rootPath;
    void read();
  });

  async function apply(tracked: boolean, untrack: boolean): Promise<void> {
    const root = ws?.rootPath;
    if (!root) return;
    untrackPrompt = null;
    busy = true;
    error = null;
    const mine = ++token;
    try {
      const next = await backend.setGavinGitTracking(root, tracked, untrack);
      if (mine === token) status = next;
    } catch (e) {
      if (mine === token) error = String(e);
    } finally {
      if (mine === token) busy = false;
    }
  }

  /// Picking a side acts immediately -- there is no Save here, and a
  /// wizard that collected an answer and applied it on Continue would
  /// leave the two out of step the moment somebody closed the modal.
  function pick(tracked: boolean): void {
    if (status?.tracked === tracked) return;
    if (needsUntrackConfirm(status, tracked)) {
      untrackPrompt = untrackConfirm(status?.indexed ?? 0);
      return;
    }
    void apply(tracked, false);
  }

  /// Continue records that the question was PUT, which is the whole of
  /// this step's evidence -- both answers are legitimate, and the repo
  /// cannot tell "tracked, deliberately" from "nobody decided". Marking
  /// even when nothing was clicked is deliberate: leaving the default in
  /// place is an answer, and the one most people will give.
  async function done(): Promise<void> {
    await markGitTrackingAsked(workspaceId);
    onDone();
  }
</script>

<h3>Git</h3>
<p class="hint">
  <code>.gavin-root/</code> and every <code>.gavin/</code> folder — the PRD, the cards, the rails —
  are files in this repository. Commit them with the project so anyone who clones it gets the board,
  or keep them out of git and let the plan stay on this machine. You can change this later on the
  workspace's Settings tab.
</p>

{#if !ws?.rootPath}
  <p class="hint">This workspace has no root folder yet, so there is no repository to decide about.</p>
{:else if error}
  <p class="warn">{error}</p>
{:else if !status}
  <p class="hint">Checking…</p>
{:else if !status.isRepo}
  <p class="hint">
    This root is not a git repository, so there is nothing to decide yet. If it becomes one, the
    switch is waiting on the Settings tab.
  </p>
{:else}
  <div class="choices">
    <button
      type="button"
      class="choice"
      class:picked={status.tracked}
      disabled={busy || !canToggleTracking(status)}
      onclick={() => pick(true)}
    >
      <span class="title">Commit them with the project</span>
      <span class="detail">The board travels with the repo. Gavin's default.</span>
    </button>
    <button
      type="button"
      class="choice"
      class:picked={!status.tracked}
      disabled={busy || !canToggleTracking(status)}
      onclick={() => pick(false)}
    >
      <span class="title">Keep them out of git</span>
      <span class="detail">An ignore rule in .gitignore. The files stay on disk.</span>
    </button>
  </div>
  <p class="hint state">{trackingSummary(status)}</p>
{/if}

<div class="actions">
  <button type="button" onclick={() => void done()}>Continue →</button>
</div>

<!-- Raised over the wizard's own modal, which the modal stack handles:
     the alternative -- collecting the answer and asking on Continue --
     would put the question a screen away from the click that caused it. -->
{#if untrackPrompt}
  {@const prompt = untrackPrompt}
  <ConfirmPrompt
    title={prompt.title}
    lines={prompt.lines}
    choices={[
      { label: "Ignore only", onPick: () => void apply(false, false) },
      { label: prompt.confirmLabel, onPick: () => void apply(false, true) },
    ]}
    onCancel={() => (untrackPrompt = null)}
  />
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
  .hint code {
    color: #aaa;
  }
  .hint.state {
    margin: 12px 0 0;
  }
  .warn {
    color: #e0b08a;
    font-family: monospace;
    font-size: 0.8em;
  }
  .choices {
    display: flex;
    gap: 10px;
  }
  .choice {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    text-align: left;
    background: #2a2a2a;
    border: 1px solid #3a3a3a;
    border-radius: 6px;
    padding: 10px 12px;
    color: #ccc;
    cursor: pointer;
    font-family: monospace;
  }
  .choice:disabled {
    cursor: default;
    opacity: 0.6;
  }
  /* The picked side is the one git is actually in right now, not a
     selection waiting to be saved -- so it is stated, not previewed. */
  .choice.picked {
    border-color: #4a9eff;
    color: #eee;
  }
  .choice .title {
    font-size: 0.85em;
  }
  .choice .detail {
    font-size: 0.75em;
    color: #888;
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
