<script lang="ts">
  // What "Pair a Workstation" opens over the hub: a thin template over
  // pairing/pairFlow.ts, one screen for each step of the ceremony.
  import PhoneHeader from "$companion/surfaces/PhoneHeader.svelte";
  import { spacedCode, type PairSheet } from "$shell/pairing/pairFlow";

  interface Props {
    sheet: PairSheet;
    onCancel: () => void;
    onClose: () => void;
    onRename: (name: string) => Promise<void>;
  }
  let { sheet, onCancel, onClose, onRename }: Props = $props();

  /// What the name field holds once edited; untouched, it shows the name
  /// the Workstation was kept under.
  let draft = $state<string | null>(null);

  async function done(name: string): Promise<void> {
    await onRename(name);
    draft = null;
    onClose();
  }
</script>

{#if sheet.step !== "closed"}
  <div class="sheet" role="dialog" aria-modal="true" aria-label="Pair a Workstation">
    <PhoneHeader title="Pair a Workstation" />
    <div class="body">
      {#if sheet.step === "scanning"}
        <p class="lead">Scan the code in Gavin’s Devices panel, at your desk.</p>
        <button type="button" class="action" onclick={onCancel}>Cancel</button>
      {:else if sheet.step === "working"}
        {#if sheet.phase.phase === "comparing"}
          <p class="lead">Check that your Workstation shows the same code:</p>
          <p class="code">{spacedCode(sheet.phase.code)}</p>
          <p class="note">Then press Confirm at the desk. If the desk shows any other code, reject it there.</p>
        {:else if sheet.phase.phase === "confirming"}
          <p class="lead">Confirm on this phone to sign the pairing.</p>
          <p class="note">This phone’s key signs the pairing only once you confirm it is you.</p>
        {:else if sheet.phase.phase === "connecting"}
          <p class="lead">Reaching your Workstation…</p>
        {:else}
          <p class="lead">Getting this phone’s keys ready…</p>
        {/if}
        <button type="button" class="action" onclick={onCancel}>Cancel</button>
      {:else if sheet.step === "paired"}
        {@const workstation = sheet.workstation}
        <p class="lead ok">Paired.</p>
        <p class="note">This phone is now a Device of this Workstation. What do you call it?</p>
        <input
          class="name"
          type="text"
          aria-label="Workstation name"
          autocomplete="off"
          value={draft ?? workstation.name}
          oninput={(e) => (draft = e.currentTarget.value)}
        />
        <button type="button" class="action primary" onclick={() => void done(draft ?? workstation.name)}>Done</button>
      {:else if sheet.step === "failed"}
        <p class="lead problem" role="alert">{sheet.problem}</p>
        <button type="button" class="action" onclick={onClose}>Close</button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .sheet {
    position: fixed;
    inset: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    background: var(--surface-base);
  }
  .body {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 14px;
    padding: 24px max(16px, env(safe-area-inset-right)) calc(24px + env(safe-area-inset-bottom))
      max(16px, env(safe-area-inset-left));
    overflow-y: auto;
  }
  .lead {
    margin: 0;
    color: var(--text);
    font-size: 1rem;
    line-height: 1.45;
  }
  .note {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.875rem;
    line-height: 1.5;
  }
  .ok {
    color: var(--success-text);
  }
  .problem {
    color: var(--danger-text);
  }
  .code {
    margin: 8px 0;
    color: var(--text);
    font-size: 2.5rem;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    letter-spacing: 0.08em;
  }
  .name {
    box-sizing: border-box;
    width: 100%;
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-sunken);
    color: var(--text);
    font: inherit;
    /* 16px or more, or iOS zooms the page when the field takes focus. */
    font-size: 1rem;
  }
  .name:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }
  .action {
    min-height: 44px;
    padding: 0 16px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.875rem;
  }
  .action:active {
    background: var(--surface-hover);
  }
  .action:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
  .primary {
    border-color: var(--accent);
    color: var(--accent-text);
  }
</style>
