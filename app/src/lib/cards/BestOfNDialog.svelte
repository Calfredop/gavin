<script lang="ts">
  // Choosing the candidates for a best-of-N run, and showing what will
  // exist on disk if the human agrees to it.
  //
  // A thin template over bestOfN.ts, like every other logic-bearing
  // surface here: the branch names, the folders, the seeded pair and the
  // refusal all come from the pure module, so what this dialog previews
  // is literally what startBestOfN is handed.
  import Modal from "$lib/Modal.svelte";
  import { agentProfilesStore, configTrusts, resolvedAgents } from "$lib/layoutState";
  import { gitStore, ensureGitView, refresh as refreshGit, rootPathOf } from "$lib/git/gitState";
  import { gavinTrees, worktreeSetups } from "$lib/gavinState";
  import ConfigTrustNotice from "$lib/ConfigTrustNotice.svelte";
  import { CUSTOM_MODEL } from "$lib/agentModel";
  import { candidatesError, forkBase, planCandidates, seedCandidates, type Candidate } from "$lib/cards/bestOfN";
  import { startBestOfN } from "$lib/cards/bestOfNActions";
  import { setupPlan, setupNotice } from "$lib/git/worktreeSetup";
  import type { CardView } from "$lib/planBoard";

  interface Props {
    workspaceId: string;
    card: CardView;
    onClose: () => void;
    /// Errors go to the surface that opened this, which already has an
    /// error strip; the dialog stays open so the human can fix the rows.
    onError: (message: string) => void;
  }
  let { workspaceId, card, onClose, onError }: Props = $props();

  /// A row is the candidate plus the state a `<select>` needs that a
  /// candidate does not: whether "Custom…" is showing its text box. The
  /// model itself still lives on the candidate, so `rows.map(toCandidate)`
  /// is the whole conversion.
  interface Row {
    profileId: string;
    model: string;
    custom: boolean;
  }

  const profiles = $derived($agentProfilesStore);
  const workspaceAgent = $derived($resolvedAgents(workspaceId));
  const view = $derived($gitStore[workspaceId] ?? null);
  const root = $derived(view ? rootPathOf(view) : "");
  const takenBranches = $derived(view?.refs?.branches.map((b) => b.name) ?? []);
  const labels = $derived(new Map(profiles.map((p) => [p.id, p.label])));
  // Named, not left to git: `worktree add` with no start point forks
  // from the HEAD of whatever checkout the command runs in, and that is
  // wherever the Git tab was last pointed.
  const base = $derived(forkBase(view?.refs?.worktrees ?? []));

  // The Git tab may never have been opened in this workspace, and the
  // branch list is what keeps this dialog from proposing a name git
  // already has.
  const gavinRoot = $derived($gavinTrees[workspaceId]?.rootPath ?? "");
  $effect(() => {
    if (!gavinRoot) return;
    ensureGitView(workspaceId, gavinRoot);
    void refreshGit(workspaceId);
  });

  let rows = $state<Row[]>([]);
  let seeded = false;
  $effect(() => {
    // Once, and only once the profile table has arrived: it is fetched
    // asynchronously at bootstrap, so seeding from an empty table would
    // pin claude-code's answer for the life of the dialog.
    if (seeded || profiles.length === 0) return;
    seeded = true;
    rows = seedCandidates(profiles, workspaceAgent.profileId, workspaceAgent.model).map((c) => ({
      profileId: c.profileId,
      model: c.model,
      custom: false,
    }));
  });

  // Off the shared store rather than a read of its own: this is the copy
  // workspace trust hashed, so the preview cannot show one thing while
  // the launch runs another.
  const setup = $derived($worktreeSetups[workspaceId] ?? []);
  const trust = $derived($configTrusts(workspaceId));

  const candidates = $derived<Candidate[]>(rows.map((r) => ({ profileId: r.profileId, model: r.model })));
  const plans = $derived(planCandidates(card.title, candidates, labels, root, takenBranches));
  const setError = $derived(candidatesError(candidates));
  const rootError = $derived(root ? null : "This workspace is not a git repository, so there is nowhere to fork worktrees from.");
  // The same gate the launch applies, said here so a row that cannot run
  // is visible before the button is pressed rather than after.
  const promptError = $derived.by(() => {
    const blocked = candidates.find((c) => profiles.find((p) => p.id === c.profileId)?.promptArgs === null);
    if (!blocked) return null;
    const label = labels.get(blocked.profileId) ?? blocked.profileId;
    return `${label} takes no prompt on its command line, so it cannot run a card.`;
  });
  const error = $derived(rootError ?? setError ?? promptError);

  /// The line one candidate's session runs, for the preview. Every
  /// candidate's differs only in its agent command, so the notice is
  /// shown once with the setup that is common to all of them.
  const setupPreview = $derived(setup.length > 0 ? setupPlan(setup, null, trust.trusted) : null);

  const MAX_ROWS = 6;
  let submitting = $state(false);

  function modelsFor(profileId: string): string[] {
    return profiles.find((p) => p.id === profileId)?.models ?? [];
  }

  function addRow(): void {
    const last = rows[rows.length - 1];
    rows = [...rows, { profileId: last?.profileId ?? workspaceAgent.profileId, model: "", custom: false }];
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

  async function submit(): Promise<void> {
    if (error || submitting) return;
    submitting = true;
    const message = await startBestOfN(workspaceId, card, plans, base.ref);
    submitting = false;
    if (message) {
      onError(message);
      return;
    }
    onClose();
  }
</script>

<Modal onClose={onClose}>
  <form class="bon" onsubmit={(e) => { e.preventDefault(); void submit(); }}>
    <h3>Run “{card.title}” on several agents</h3>
    <p class="lead">
      Each candidate gets a worktree and a branch of its own, forked from
      <strong>{base.label}</strong>, and runs this card there. They open side by side on one page;
      you pick one when they are done.
    </p>

    <div class="rows">
      {#each rows as row, i (i)}
        <div class="row">
          <select
            aria-label="Agent"
            value={row.profileId}
            onchange={(e) => (rows = rows.map((r, j) => (j === i ? { ...r, profileId: e.currentTarget.value, model: "", custom: false } : r)))}
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
              oninput={(e) => (rows = rows.map((r, j) => (j === i ? { ...r, model: e.currentTarget.value } : r)))}
            />
          {:else}
            <select aria-label="Model" value={row.model} onchange={(e) => pickModel(i, e.currentTarget.value)}>
              <option value="">Default</option>
              {#each modelsFor(row.profileId) as model (model)}
                <option value={model}>{model}</option>
              {/each}
              <option value={CUSTOM_MODEL}>Custom…</option>
            </select>
          {/if}

          <code class="branch" title={plans[i]?.worktreePath ?? ""}>{plans[i]?.branch ?? ""}</code>

          <button
            type="button"
            class="drop"
            aria-label="Remove candidate"
            disabled={rows.length <= 2}
            onclick={() => removeRow(i)}>×</button
          >
        </div>
      {/each}
    </div>

    <button type="button" class="add" disabled={rows.length >= MAX_ROWS} onclick={addRow}>+ Add candidate</button>

    {#if plans.length > 0 && root}
      <div class="folders">
        <span>Folders, beside the repo:</span>
        <code>{plans[0].worktreePath}</code>
        {#if plans.length > 1}<span class="more">…and {plans.length - 1} more</span>{/if}
      </div>
    {/if}

    <!-- Above the preview, because an unapproved config makes that
         preview vanish rather than turn red. -->
    <ConfigTrustNotice {workspaceId} />

    {#if setupPreview}
      <div class="setup">
        <span>{setupNotice(setupPreview)}</span>
        <code>{setupPreview.line}</code>
      </div>
    {/if}

    {#if error}<div class="err">{error}</div>{/if}

    <div class="actions">
      <button type="button" onclick={onClose}>Cancel</button>
      <button type="submit" class="primary" disabled={!!error || submitting}>
        {submitting ? "Starting…" : `Start ${plans.length} candidates`}
      </button>
    </div>
  </form>
</Modal>

<style>
  .bon {
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
  .rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row {
    display: grid;
    /* The branch column takes what is left and clips: it is a preview,
       and a long name must not push the controls off the modal. */
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
  .branch {
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
  .folders,
  .setup {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.78em;
    color: var(--text-muted);
    min-width: 0;
  }
  .folders code,
  .setup code {
    display: block;
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-family: monospace;
    padding: 5px 8px;
    overflow-x: auto;
    white-space: pre;
    min-width: 0;
  }
  .more {
    color: var(--text-subtle);
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
