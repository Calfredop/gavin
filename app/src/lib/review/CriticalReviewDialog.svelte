<!--
  Critical review: N reviewers, one shared checkout, findings as cards.

  Thin template over criticalReview.ts / criticalReviewActions.ts. The
  picker rows mirror BestOfNDialog; the base field and rules row mirror
  ReviewDialog. No worktree preview, no pick-winner.
-->
<script lang="ts">
  import Modal from "$lib/core/Modal.svelte";
  import { agentProfilesStore, resolvedAgents } from "$lib/core/layoutState";
  import { CUSTOM_MODEL } from "$lib/agents/agentModel";
  import {
    candidateLabel,
    reviewersError,
    seedCandidates,
    type Candidate,
  } from "$lib/review/criticalReview";
  import {
    criticalReviewRequest,
    cancelCriticalReview,
    confirmCriticalReview,
    createCriticalReviewRules,
  } from "$lib/review/criticalReviewActions";
  import { REVIEW_RULES_LABEL } from "$lib/review/codeReview";

  interface Row {
    profileId: string;
    model: string;
    custom: boolean;
  }

  const profiles = $derived($agentProfilesStore);
  let workspaceId = $derived($criticalReviewRequest?.workspaceId ?? "");
  const workspaceAgent = $derived($resolvedAgents(workspaceId));

  let base = $state("");
  let alsoBuildFindingsRail = $state(false);
  let rows = $state<Row[]>([]);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let seeded = $state(false);
  let seededFor = $state<typeof $criticalReviewRequest>(null);

  $effect(() => {
    const request = $criticalReviewRequest;
    if (request === seededFor) return;
    seededFor = request;
    base = request?.base ?? "";
    alsoBuildFindingsRail = false;
    error = null;
    busy = false;
    seeded = false;
    rows = [];
  });

  $effect(() => {
    if (seeded || !$criticalReviewRequest || profiles.length === 0 || !workspaceId) return;
    seeded = true;
    rows = seedCandidates(profiles, workspaceAgent.profileId, workspaceAgent.model).map((c) => ({
      profileId: c.profileId,
      model: c.model,
      custom: false,
    }));
  });

  const reviewers = $derived<Candidate[]>(rows.map((r) => ({ profileId: r.profileId, model: r.model })));
  const labels = $derived(new Map(profiles.map((p) => [p.id, p.label])));
  const setError = $derived(reviewersError(reviewers));
  const promptError = $derived.by(() => {
    const blocked = reviewers.find((c) => profiles.find((p) => p.id === c.profileId)?.promptArgs === null);
    if (!blocked) return null;
    const label = labels.get(blocked.profileId) ?? blocked.profileId;
    return `${label} takes no prompt on its command line, so it cannot run a review.`;
  });
  const formError = $derived(setError ?? promptError ?? error);

  const MAX_ROWS = 6;

  function modelsFor(profileId: string): string[] {
    return profiles.find((p) => p.id === profileId)?.models ?? [];
  }

  function addRow(): void {
    const last = rows[rows.length - 1];
    rows = [
      ...rows,
      { profileId: last?.profileId ?? workspaceAgent.profileId, model: "", custom: false },
    ];
  }

  function removeRow(index: number): void {
    rows = rows.filter((_, i) => i !== index);
  }

  function pickModel(index: number, value: string): void {
    rows = rows.map((row, i) =>
      i === index
        ? value === CUSTOM_MODEL
          ? { ...row, custom: true, model: "" }
          : { ...row, custom: false, model: value }
        : row
    );
  }

  async function start(): Promise<void> {
    if (busy || setError || promptError) return;
    busy = true;
    error = await confirmCriticalReview({
      base,
      reviewers,
      alsoBuildFindingsRail,
    });
    busy = false;
  }

  async function createRules(): Promise<void> {
    error = await createCriticalReviewRules();
  }
</script>

{#if $criticalReviewRequest}
  {@const request = $criticalReviewRequest}
  <Modal onClose={cancelCriticalReview}>
    <form
      class="crit"
      onsubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <h3>Critical review</h3>
      <p class="lead">
        Reviews {request.subject} with several agents in the same checkout. Each
        files findings as cards — no worktrees, no pick-a-winner.
      </p>

      <label class="field">
        <span>Compare against</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input type="text" bind:value={base} placeholder="main" autofocus />
        <small>A branch, tag or commit — <code>origin/main</code> and <code>HEAD~5</code> work too.</small>
      </label>

      <div class="rows">
        {#each rows as row, i (i)}
          <div class="row">
            <select
              aria-label="Agent"
              value={row.profileId}
              onchange={(e) =>
                (rows = rows.map((r, j) =>
                  j === i
                    ? { ...r, profileId: e.currentTarget.value, model: "", custom: false }
                    : r
                ))}
            >
              {#each profiles as profile (profile.id)}
                <option value={profile.id}>{profile.label}</option>
              {/each}
            </select>

            {#if row.custom}
              <input
                type="text"
                aria-label="Model"
                placeholder="model name"
                value={row.model}
                oninput={(e) =>
                  (rows = rows.map((r, j) =>
                    j === i ? { ...r, model: e.currentTarget.value } : r
                  ))}
              />
            {:else}
              <select
                aria-label="Model"
                value={row.model}
                onchange={(e) => pickModel(i, e.currentTarget.value)}
              >
                <option value="">Default</option>
                {#each modelsFor(row.profileId) as model (model)}
                  <option value={model}>{model}</option>
                {/each}
                <option value={CUSTOM_MODEL}>Custom…</option>
              </select>
            {/if}

            <code class="label" title={candidateLabel(labels.get(row.profileId) ?? row.profileId, row.model)}>
              {candidateLabel(labels.get(row.profileId) ?? row.profileId, row.model)}
            </code>

            <button
              type="button"
              class="drop"
              aria-label="Remove reviewer"
              disabled={rows.length <= 2}
              onclick={() => removeRow(i)}>×</button
            >
          </div>
        {/each}
      </div>

      <button type="button" class="add" disabled={rows.length >= MAX_ROWS} onclick={addRow}
        >+ Add reviewer</button
      >

      <label class="toggle">
        <input type="checkbox" bind:checked={alsoBuildFindingsRail} />
        <span>Also build findings rail</span>
        <small>Off by default. Finding cards are filed either way; a rail of them is optional.</small>
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

      {#if formError}<div class="err">{formError}</div>{/if}

      <div class="actions">
        <button type="button" onclick={cancelCriticalReview}>Cancel</button>
        <button
          type="submit"
          class="primary"
          disabled={!!setError || !!promptError || busy || base.trim().length === 0}
        >
          {busy ? "Starting…" : `Start ${reviewers.length} reviewers`}
        </button>
      </div>
    </form>
  </Modal>
{/if}

<style>
  .crit {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 460px;
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
  .rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.2fr) auto;
    gap: 6px;
    align-items: center;
  }
  .row select,
  .row input {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-family: monospace;
    font-size: 0.8em;
    padding: 4px 6px;
    min-width: 0;
  }
  .row select:focus,
  .row input:focus {
    outline: none;
    border-color: var(--border-accent);
  }
  .label {
    color: var(--text-subtle);
    font-family: monospace;
    font-size: 0.75em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .drop {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-muted);
    cursor: pointer;
    font-family: monospace;
    line-height: 1;
    padding: 3px 7px;
  }
  .drop:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .add {
    align-self: flex-start;
    background: transparent;
    border: 1px dashed var(--border);
    border-radius: 6px;
    color: var(--text-muted);
    cursor: pointer;
    font-family: monospace;
    font-size: 0.78em;
    padding: 4px 10px;
  }
  .add:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .toggle {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 8px;
    align-items: start;
    font-size: 0.8em;
    color: var(--text-muted);
  }
  .toggle input {
    margin-top: 2px;
  }
  .toggle span {
    color: var(--text);
  }
  .toggle small {
    grid-column: 2;
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
