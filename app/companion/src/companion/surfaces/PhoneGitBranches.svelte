<script lang="ts">
  // The Branches pane: switch to a branch, merge one into the branch
  // checked out, start a new one, or check out one that is only on the
  // remote. Every action is the desk's own; a merge asks first.
  import { checkout, createBranch, gitStore, mergeBranch } from "$lib/git/gitState";
  import {
    gitLocked,
    localBranches,
    mergeQuestion,
    newBranchProblem,
    remoteOnlyBranches,
  } from "$companion/surfaces/phoneGit";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const view = $derived($gitStore[workspaceId] ?? null);
  const locked = $derived(gitLocked(view));
  const locals = $derived(view ? localBranches(view) : []);
  const remotes = $derived(view ? remoteOnlyBranches(view) : []);

  let draft = $state("");
  let switchTo = $state(true);
  const name = $derived(draft.trim());
  const problem = $derived(view && name ? newBranchProblem(view, name) : null);

  /// The branch whose merge is waiting on its question's answer.
  let asking = $state<string | null>(null);

  async function create(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (locked || !name || problem !== null) return;
    // A refusal lands in the tab's error banner, as at the desk; the name
    // stays in the field so it can be put right.
    const result = await createBranch(workspaceId, name, null, switchTo);
    if (result.ok) draft = "";
  }

  function merge(branch: string): void {
    asking = null;
    void mergeBranch(workspaceId, branch);
  }
</script>

<div class="branches">
  <form class="new" onsubmit={create}>
    <input
      class="field"
      type="text"
      placeholder="New branch"
      aria-label="New branch name"
      autocapitalize="off"
      autocomplete="off"
      spellcheck="false"
      bind:value={draft}
    />
    <button type="submit" class="primary" disabled={locked || !name || problem !== null}>Create</button>
  </form>
  <label class="check">
    <input type="checkbox" bind:checked={switchTo} />
    Switch to it
  </label>
  {#if problem}
    <p class="problem">{problem}</p>
  {/if}

  <section aria-label="Branches">
    {#each locals as branch (branch.name)}
      <div class="row" class:current={branch.current}>
        <div class="what">
          <span class="name">{branch.name}</span>
          <span class="sub">{branch.standing ? `${branch.standing} · ` : ""}{branch.subject}</span>
        </div>
        {#if branch.current}
          <span class="here">Checked out</span>
        {:else}
          <span class="acts">
            <button type="button" disabled={locked} onclick={() => void checkout(workspaceId, branch.name, null)}>
              Switch
            </button>
            <button type="button" disabled={locked} onclick={() => (asking = branch.name)}>Merge</button>
          </span>
        {/if}
      </div>
      {#if asking === branch.name && view}
        <div class="confirm" role="group" aria-label="Confirm the merge">
          <span class="question">{mergeQuestion(view, branch.name)}</span>
          <span class="acts">
            <button type="button" onclick={() => (asking = null)}>Cancel</button>
            <button type="button" class="primary" disabled={locked} onclick={() => merge(branch.name)}>Merge</button>
          </span>
        </div>
      {/if}
    {:else}
      <p class="none">No branches yet</p>
    {/each}
  </section>

  {#if remotes.length > 0}
    <section aria-label="Only on the remote">
      <header class="section-head">Only on the remote</header>
      {#each remotes as branch (`${branch.remote}/${branch.name}`)}
        <div class="row">
          <div class="what">
            <span class="name">{branch.name}</span>
            <span class="sub">{branch.remote}</span>
          </div>
          <span class="acts">
            <button
              type="button"
              disabled={locked}
              onclick={() => void checkout(workspaceId, branch.name, branch.remote)}
            >
              Check out
            </button>
          </span>
        </div>
      {/each}
    </section>
  {/if}
</div>

<style>
  .branches {
    flex: 1 1 auto;
    min-height: 0;
    padding-bottom: calc(16px + env(safe-area-inset-bottom));
    overflow-y: auto;
  }
  .new {
    display: flex;
    gap: 8px;
    padding: 12px 12px 0;
  }
  .field {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 44px;
    box-sizing: border-box;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-base);
    color: var(--text);
    font-family: monospace;
    /* 16px and no smaller: iOS zooms into anything smaller when it
       takes focus. More at a larger text size. */
    font-size: max(16px, 1rem);
  }
  .field:focus {
    border-color: var(--border-accent);
    outline: none;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 12px;
    color: var(--text-muted);
    font-size: 0.8125rem;
  }
  .check input {
    width: 20px;
    height: 20px;
  }
  .problem {
    margin: -4px 0 8px;
    padding: 0 12px;
    color: var(--danger-text);
    font-size: 0.75rem;
  }
  .section-head {
    padding: 16px 12px 6px;
    color: var(--text-muted);
    font-size: 0.6875rem;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .row,
  .confirm {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 56px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border);
  }
  .row.current {
    background: var(--surface-sunken);
  }
  .what {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .name {
    overflow: hidden;
    color: var(--text);
    font-family: monospace;
    font-size: 0.875rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row.current .name {
    font-weight: 600;
  }
  .sub {
    overflow: hidden;
    color: var(--text-subtle);
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .here {
    flex: 0 0 auto;
    color: var(--success-text);
    font-size: 0.75rem;
  }
  .confirm {
    flex-wrap: wrap;
    background: var(--surface-accent);
  }
  .question {
    flex: 1 1 12em;
    color: var(--text);
    font-size: 0.8125rem;
    overflow-wrap: anywhere;
  }
  .acts {
    display: flex;
    flex: 0 0 auto;
    gap: 8px;
    margin-left: auto;
  }
  button {
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.8125rem;
  }
  button.primary {
    border-color: var(--border-success);
    background: var(--surface-success);
    color: var(--success-text);
  }
  button:disabled {
    opacity: 0.45;
  }
  button:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }
  .none {
    margin: 0;
    padding: 16px 12px;
    color: var(--text-subtle);
    font-size: 0.8125rem;
  }
</style>
