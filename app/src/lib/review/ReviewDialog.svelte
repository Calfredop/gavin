<!--
  The one question a review has to ask: what to compare against. Mounted
  once at the app root beside AppDialog, driven by codeReviewActions'
  module-level store — because both surfaces that start a review (the Git
  toolbar and the card menu, which three different boards mount) would
  otherwise each need a modal of their own.

  It also says whether this workspace has review rules, and offers to
  create the file when it does not. That row is the only place the rules
  file is discoverable: it is a convention, not a setting, so nothing
  else in the app would ever mention it.
-->
<script lang="ts">
  import Modal from "$lib/core/Modal.svelte";
  import { REVIEW_RULES_LABEL } from "$lib/review/codeReview";
  import type { ReviewRequest } from "$lib/review/codeReviewActions";
  import {
    reviewRequest,
    cancelReview,
    confirmReview,
    createReviewRules,
  } from "$lib/review/codeReviewActions";

  // Seeded from the request and then owned here: the store holds what
  // the app worked out, this holds what the human has typed.
  let base = $state("");
  let error = $state<string | null>(null);
  let busy = $state(false);
  // Re-seeds whenever a different review is asked about. Keyed on the
  // request object rather than a mount, because the modal is mounted for
  // the life of the app and only its content changes.
  let seeded = $state<ReviewRequest | null>(null);
  $effect(() => {
    const request = $reviewRequest;
    if (request === seeded) return;
    seeded = request;
    base = request?.base ?? "";
    error = null;
    busy = false;
  });

  async function start(): Promise<void> {
    if (busy) return;
    busy = true;
    error = await confirmReview(base);
    busy = false;
  }

  async function createRules(): Promise<void> {
    error = await createReviewRules();
  }
</script>

{#if $reviewRequest}
  {@const request = $reviewRequest}
  <Modal onClose={cancelReview}>
    <form class="review" onsubmit={(e) => { e.preventDefault(); void start(); }}>
      <h3>Review with agent</h3>
      <p class="subject">Reviews {request.subject}, and files every finding as a card.</p>

      <label class="field">
        <span>Compare against</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input type="text" bind:value={base} placeholder="main" autofocus />
        <small>A branch, tag or commit — <code>origin/main</code> and <code>HEAD~5</code> work too.</small>
      </label>

      <div class="rules">
        {#if request.rulesExist}
          <span class="found">Review rules: <code>{REVIEW_RULES_LABEL}</code></span>
        {:else}
          <span>No review rules in this workspace.</span>
          <button type="button" class="link" onclick={() => void createRules()}>
            Create {REVIEW_RULES_LABEL}
          </button>
        {/if}
      </div>

      {#if error}<p class="error">{error}</p>{/if}

      <div class="actions">
        <button type="button" onclick={cancelReview}>Cancel</button>
        <button type="submit" class="primary" disabled={busy || base.trim().length === 0}>
          {busy ? "Starting…" : "Start review"}
        </button>
      </div>
    </form>
  </Modal>
{/if}

<style>
  .review {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 340px;
  }
  h3 {
    margin: 0;
    font-size: 1em;
    color: var(--text);
  }
  .subject {
    margin: 0;
    font-size: 0.8em;
    color: var(--text-muted);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.8em;
    color: var(--text-muted);
  }
  .field input {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-family: monospace;
    font-size: 1em;
    padding: 5px 8px;
  }
  .field input:focus {
    outline: none;
    border-color: var(--border-accent);
  }
  .field small {
    color: var(--text-subtle);
    font-size: 0.9em;
  }
  .rules {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 0.75em;
    color: var(--text-subtle);
  }
  .rules .found {
    color: var(--text-muted);
  }
  .rules code,
  .field code {
    color: var(--text-muted);
  }
  .link {
    background: transparent;
    border: 0;
    padding: 0;
    color: var(--accent-text);
    font-family: monospace;
    font-size: 1em;
    text-decoration: underline;
    cursor: pointer;
  }
  .error {
    margin: 0;
    font-size: 0.8em;
    color: var(--danger-text);
    white-space: pre-wrap;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
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
  .actions .primary {
    background: var(--surface-success);
    border-color: var(--border-success);
    color: var(--success-text);
  }
  .actions .primary:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
