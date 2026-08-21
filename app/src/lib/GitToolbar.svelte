<script lang="ts">
  import { GitBranch, RefreshCw, Download, ArrowDown, ArrowUp, Archive, ArchiveRestore } from "@lucide/svelte";
  import {
    gitStore,
    refresh,
    fetch,
    pull,
    push,
    stashPush,
    stashPop,
    setActiveRemote,
    effectiveRemote,
    pushLabel,
    canSync,
    currentBranch,
  } from "./gitState";
  import { branchLabel } from "./git";
  import { tooltip } from "./tooltip";
  import GitPromptDialog from "./GitPromptDialog.svelte";

  interface Props {
    workspaceId: string;
    /// SP3 renders the worktree switcher here; SP2 shows the repo name.
    leading?: import("svelte").Snippet;
    repoName: string;
  }
  let { workspaceId, leading, repoName }: Props = $props();

  const view = $derived($gitStore[workspaceId] ?? null);
  const locked = $derived(view == null || view.busy != null || view.op != null);
  const branch = $derived(view ? currentBranch(view) : null);
  const sync = $derived(view ? canSync(view) : { fetch: false, pull: false, push: false, reason: null });
  const remotes = $derived(view?.refs?.remotes ?? []);
  const remote = $derived(view ? effectiveRemote(view) : null);
  const pushText = $derived(view ? pushLabel(view) : "Push");
  const stashCount = $derived(view?.refs?.stashes.length ?? 0);

  let stashDialog = $state(false);

  function tip(base: string, enabled: boolean): string {
    return enabled || !sync.reason ? base : `${base} — ${sync.reason}`;
  }
</script>

<div class="toolbar">
  {#if leading}
    {@render leading()}
  {:else}
    <span class="repo">{repoName}</span>
  {/if}
  {#if view?.repo}
    <span class="branch" class:detached={view.repo.detached}>
      <GitBranch size={12} />
      {branchLabel(view.repo)}
    </span>
  {/if}

  <span class="group">
    <button type="button" class="act" use:tooltip={tip(`Fetch from ${remote ?? "remote"}`, sync.fetch)} disabled={locked || !sync.fetch} onclick={() => fetch(workspaceId)}>
      <Download size={13} />
      <span>Fetch</span>
    </button>
    <button type="button" class="act" use:tooltip={tip("Pull", sync.pull)} disabled={locked || !sync.pull} onclick={() => pull(workspaceId)}>
      <ArrowDown size={13} />
      <span>Pull</span>
      {#if branch && branch.behind > 0}<span class="badge">↓{branch.behind}</span>{/if}
    </button>
    <button type="button" class="act" use:tooltip={tip(`${pushText} to ${remote ?? "remote"}`, sync.push)} disabled={locked || !sync.push} onclick={() => push(workspaceId)}>
      <ArrowUp size={13} />
      <span>{pushText}</span>
      {#if branch && branch.ahead > 0}<span class="badge">↑{branch.ahead}</span>{/if}
    </button>
    {#if remotes.length > 1}
      <select
        class="remote"
        use:tooltip={"Remote for Fetch and Push"}
        value={remote ?? ""}
        onchange={(e) => setActiveRemote(workspaceId, e.currentTarget.value || null)}
      >
        {#each remotes as r (r.name)}
          <option value={r.name}>{r.name}</option>
        {/each}
      </select>
    {/if}
  </span>

  <span class="group">
    <button type="button" class="act" use:tooltip={"Stash all changes"} disabled={locked || !view?.status || (view.status.unstaged.length === 0 && view.status.staged.length === 0)} onclick={() => (stashDialog = true)}>
      <Archive size={13} />
      <span>Stash</span>
    </button>
    <button type="button" class="act" use:tooltip={stashCount > 0 ? "Pop the latest stash" : "No stashes"} disabled={locked || stashCount === 0} onclick={() => stashPop(workspaceId, 0)}>
      <ArchiveRestore size={13} />
      <span>Pop</span>
      {#if stashCount > 0}<span class="badge">{stashCount}</span>{/if}
    </button>
  </span>

  <span class="spacer"></span>
  <button type="button" class="icon" use:tooltip={"Refresh"} onclick={() => refresh(workspaceId)} disabled={locked}>
    <RefreshCw size={13} />
  </button>
</div>

{#if stashDialog}
  <GitPromptDialog
    title="Stash changes"
    fields={[{ key: "message", label: "Message (optional)", value: "", placeholder: "WIP" }]}
    checkbox={{ label: "Include untracked files", checked: true }}
    primary="Stash"
    onSubmit={(values, checked) => {
      stashDialog = false;
      void stashPush(workspaceId, values.message ?? "", checked);
    }}
    onCancel={() => (stashDialog = false)}
  />
{/if}

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    font-size: 0.8em;
    font-family: monospace;
    color: var(--text);
  }
  .repo {
    color: var(--text);
    font-weight: 600;
  }
  .branch {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 7px;
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .branch.detached {
    border-color: var(--border-warning);
    color: var(--warning-text);
  }
  .group {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding-left: 10px;
    border-left: 1px solid var(--border);
  }
  .act {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-muted);
    padding: 3px 8px;
    font-family: monospace;
    font-size: 1em;
    cursor: pointer;
    white-space: nowrap;
  }
  .act:hover:not(:disabled) {
    border-color: var(--border-strong);
    color: var(--text);
  }
  .act:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .badge {
    color: var(--success-text);
    font-size: 0.9em;
  }
  .remote {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 1em;
    padding: 2px 6px;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .icon {
    display: inline-flex;
    align-items: center;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-muted);
    padding: 3px 6px;
    cursor: pointer;
  }
  .icon:hover:not(:disabled) {
    border-color: var(--border-strong);
    color: var(--text);
  }
  .icon:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
