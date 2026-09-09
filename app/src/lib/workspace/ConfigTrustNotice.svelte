<script lang="ts">
  /// The workspace-trust gate, wherever a human can see the consequence
  /// of it: the Settings and Home agent panels, and the two dialogs that
  /// cut worktrees.
  ///
  /// `.gavin-root/config.toml` ships with the repository, and three of
  /// its keys name what gavin RUNS as the user rather than choosing among
  /// rows gavin already verified. Until a human has approved them, those
  /// keys are inert everywhere (`workspaceTrust.ts`) — and a control that
  /// is quietly ignoring what the file says has to say so, or the human
  /// reads the fallback as gavin misreading their config.
  ///
  /// The values are shown VERBATIM before the approval, because they are
  /// the whole decision. A paraphrase would be a second description to
  /// keep in sync with the thing actually executed.
  import { Lock } from "@lucide/svelte";
  import Modal from "$lib/Modal.svelte";
  import { approveWorkspaceConfig, configTrusts, revokeWorkspaceConfig } from "$lib/layoutState";
  import { configTrustNotice, trustRows } from "$lib/workspace/workspaceTrust";

  interface Props {
    workspaceId: string;
    /// Also draw the quiet "approved" line, with the way back out of it.
    /// Settings passes this; the dialogs do not — a fork dialog that
    /// reported an approval nobody is questioning would be noise on the
    /// path to a button.
    showApproved?: boolean;
  }
  let { workspaceId, showApproved = false }: Props = $props();

  const trust = $derived($configTrusts(workspaceId));
  const rows = $derived(trustRows(trust.keys));
  const approved = $derived(trust.trusted && rows.length > 0);

  let reviewing = $state(false);
  let busy = $state(false);

  async function decide(approve: boolean): Promise<void> {
    busy = true;
    // Await before closing: the sheet showed the values the store held,
    // and the stamp is taken from the store as it stands at this click.
    if (approve) await approveWorkspaceConfig(workspaceId);
    else await revokeWorkspaceConfig(workspaceId);
    busy = false;
    reviewing = false;
  }
</script>

{#if trust.needsApproval}
  <div class="trust-banner" role="status">
    <Lock size={14} aria-hidden="true" />
    <span>{configTrustNotice(trust.keys)}</span>
    <button type="button" onclick={() => (reviewing = true)}>Review…</button>
  </div>
{:else if approved && showApproved}
  <p class="trust-approved">
    You approved this repo's config.toml commands.
    <button type="button" class="link" onclick={() => (reviewing = true)}>Review</button>
  </p>
{/if}

{#if reviewing}
  <Modal onClose={() => (reviewing = false)}>
    <h3>What this repo's config.toml would run</h3>
    <p class="hint">
      These values come from <code>.gavin-root/config.toml</code>, which ships with the repository
      rather than being written by you. gavin runs them as you — on Run, on every rail step, and
      when a worktree is cut. Read them before approving.
    </p>
    <ul class="trust-rows">
      {#each rows as row, i (i)}
        <li>
          <span class="key">{row.key}</span>
          <code>{row.value}</code>
        </li>
      {/each}
    </ul>
    <p class="hint">
      Approving records these exact values. Change any of them — or pull a change — and gavin asks
      again.
    </p>
    <div class="actions">
      <!-- Focus stays on the DISMISSING button: approving is the
           consequential answer here, so Enter must not fire it. -->
      <!-- svelte-ignore a11y_autofocus -->
      <button type="button" autofocus onclick={() => (reviewing = false)}>Not now</button>
      {#if approved}
        <button type="button" class="danger" disabled={busy} onclick={() => void decide(false)}>
          Withdraw approval
        </button>
      {:else}
        <button type="button" class="primary" disabled={busy} onclick={() => void decide(true)}>
          Approve these commands
        </button>
      {/if}
    </div>
  </Modal>
{/if}

<style>
  .trust-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid var(--border-warning);
    background: var(--surface-warning);
    color: var(--warning-text);
    border-radius: 6px;
    font-size: 0.9em;
  }
  .trust-banner span {
    flex: 1;
    min-width: 0;
  }
  .trust-banner button {
    flex: none;
  }
  .trust-approved {
    color: var(--text-muted);
    font-size: 0.9em;
    margin: 0;
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent-text);
    cursor: pointer;
    font: inherit;
    text-decoration: underline;
  }
  .hint {
    color: var(--text-muted);
    font-size: 0.9em;
  }
  .trust-rows {
    list-style: none;
    margin: 12px 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .trust-rows li {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .key {
    color: var(--text-muted);
    font-size: 0.85em;
  }
  .trust-rows code {
    /* The line can be long and must not be abbreviated: the reader is
       deciding on exactly these characters. */
    display: block;
    overflow-x: auto;
    white-space: pre;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface-sunken);
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 12px;
  }
  .actions button {
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 6px 14px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
  .actions button:focus-visible {
    outline: 2px solid var(--border-accent);
    outline-offset: 1px;
  }
  .actions button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .actions button.primary {
    background: var(--surface-success);
    color: var(--success-text);
  }
  .actions button.danger {
    background: var(--surface-danger);
    color: var(--danger-text);
  }
</style>
