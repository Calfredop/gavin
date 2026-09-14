<!--
  Explicit "Build review rail from findings": list the run's finding
  cards, let the human cull, then create the rail. Thin over
  criticalReviewFindingsRail.ts / criticalReviewFindingsRailActions.ts.
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import Modal from "$lib/core/Modal.svelte";
  import {
    cancelFindingsRail,
    confirmFindingsRail,
    findingsForRun,
    findingsRailRequest,
  } from "$lib/review/criticalReviewFindingsRailActions";
  import { criticalReviewRuns, runForPage } from "$lib/review/criticalReviewState";
  import { NO_FINDINGS_ERROR } from "$lib/review/criticalReviewFindingsRail";
  import { fetchBoard } from "$lib/board/kanbanState";

  let kept = $state<Set<string>>(new Set());
  let error = $state<string | null>(null);
  let busy = $state(false);
  let seededFor = $state<string | null>(null);

  const request = $derived($findingsRailRequest);
  const run = $derived(
    request
      ? runForPage($criticalReviewRuns[request.workspaceId], request.pageId)
      : null
  );
  const findings = $derived(
    request && run ? findingsForRun(request.workspaceId, run) : []
  );

  $effect(() => {
    const req = request;
    const list = findings;
    if (!req) {
      seededFor = null;
      return;
    }
    const key = `${req.workspaceId}:${req.pageId}:${list.map((f) => f.path).join(",")}`;
    if (key === seededFor) return;
    seededFor = key;
    kept = new Set(list.map((f) => f.path));
    error = null;
    busy = false;
    void fetchBoard(req.workspaceId);
  });

  const selectedCount = $derived([...kept].filter((p) => findings.some((f) => f.path === p)).length);

  function toggle(path: string): void {
    const next = new Set(kept);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    kept = next;
  }

  async function build(): Promise<void> {
    if (busy) return;
    busy = true;
    error = await confirmFindingsRail(kept);
    busy = false;
  }

  onDestroy(() => {
    // Leave the pending request alone: closing via Cancel calls
    // cancelFindingsRail; unmount from a workspace switch should not
    // silently drop a dialog the human still has open elsewhere.
  });
</script>

{#if request && run}
  <Modal onClose={cancelFindingsRail}>
    <form
      class="findings"
      onsubmit={(e) => {
        e.preventDefault();
        void build();
      }}
    >
      <h3>Build review rail from findings</h3>
      <p class="lead">
        Critical review of “{run.subjectLabel}” filed these cards. Untick any
        you want to leave off the new rail — one step each, in this order.
      </p>

      {#if findings.length === 0}
        <div class="err">{NO_FINDINGS_ERROR}.</div>
      {:else}
        <ul class="list">
          {#each findings as card (card.path)}
            <li>
              <label>
                <input
                  type="checkbox"
                  checked={kept.has(card.path)}
                  onchange={() => toggle(card.path)}
                />
                <span class="title">{card.title}</span>
                <code class="file">{card.fileName}</code>
              </label>
            </li>
          {/each}
        </ul>
      {/if}

      {#if error}<div class="err">{error}</div>{/if}

      <div class="actions">
        <button type="button" onclick={cancelFindingsRail}>Cancel</button>
        <button
          type="submit"
          class="primary"
          disabled={busy || selectedCount === 0}
        >
          {busy
            ? "Building…"
            : selectedCount === 0
              ? "Build rail"
              : `Build rail (${selectedCount})`}
        </button>
      </div>
    </form>
  </Modal>
{/if}

<style>
  .findings {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 420px;
    max-width: 560px;
  }
  h3 {
    margin: 0;
    font-size: 1em;
    color: var(--text);
  }
  .lead {
    margin: 0;
    font-size: 0.78em;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 280px;
    overflow: auto;
  }
  .list label {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 0.8em;
    color: var(--text);
    cursor: pointer;
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file {
    color: var(--text-subtle);
    font-size: 0.9em;
  }
  .err {
    color: var(--danger-text);
    font-size: 0.78em;
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
