<script lang="ts">
  // One workspace's Git tab, on a phone. A thin template over phoneGit.ts.
  // The state and every action are the desktop's (`gitState.ts`), and the
  // op bar, the file rows, the commit box and the diff are the desktop's
  // own components -- the desk's `GitHubView` is not, because its columns,
  // folds and diff layout are saved in the desk's layout.
  import { ArrowDown, ArrowUp, Download, GitBranch, RefreshCw } from "@lucide/svelte";
  import type { Workspace } from "$lib/core/workspace";
  import GitOpBar from "$lib/git/GitOpBar.svelte";
  import {
    abortInProgress,
    continueInProgress,
    dismissError,
    ensureGitView,
    fetch,
    gitStore,
    pull,
    push,
    refresh,
    select,
    startWatching,
  } from "$lib/git/gitState";
  import { onReconnect, reachability, shownError } from "$companion/state/reachability";
  import PhoneGitBranches from "$companion/surfaces/PhoneGitBranches.svelte";
  import PhoneGitChanges from "$companion/surfaces/PhoneGitChanges.svelte";
  import PhoneGitDiff from "$companion/surfaces/PhoneGitDiff.svelte";
  import {
    branchLine,
    changesCount,
    gitLocked,
    gitScreen,
    inProgressBanner,
    openFile,
    recoverGit,
    syncButtons,
    syncNote,
    type GitPane,
  } from "$companion/surfaces/phoneGit";

  interface Props {
    workspace: Workspace;
  }
  let { workspace }: Props = $props();

  const root = $derived(workspace.rootPath ?? null);
  const view = $derived($gitStore[workspace.id] ?? null);
  const screen = $derived(gitScreen(root, view));
  const locked = $derived(gitLocked(view));
  const sync = $derived(view ? syncButtons(view) : null);
  const banner = $derived(view ? inProgressBanner(view) : null);
  const file = $derived(view ? openFile(view) : null);
  const error = $derived(shownError(view?.error, $reachability));

  let pane = $state<GitPane>("changes");

  // The checkout this reads is always the workspace's root. The desk can
  // point its tab at a linked worktree, but that choice is kept in the
  // desk's layout -- the desk's to make, and never the phone's to save.
  $effect(() => {
    const target = root;
    const id = workspace.id;
    if (!target) return;
    ensureGitView(id, target);
    void refresh(id);
  });

  // Read again when the connection comes back, once, with the banner
  // that only said it was gone taken down first.
  $effect(() => {
    const id = workspace.id;
    if (!root) return;
    return onReconnect(() => void recoverGit(id));
  });

  // Watched while the surface is up, as the desk's tab watches while it
  // is open. The Workstation counts watches, so this one ending does not
  // end the desk's.
  $effect(() => {
    const cwd = view?.cwd ?? null;
    const id = workspace.id;
    if (!cwd) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void startWatching(id).then((teardown) => {
      if (cancelled) teardown();
      else stop = teardown;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  });
</script>

{#if screen === "no-root"}
  <p class="note">This workspace is bound to no folder, so it has no repository.</p>
{:else if screen === "loading"}
  <p class="note">Reading the repository…</p>
{:else if screen === "git-missing"}
  <p class="note problem">git was not found on the Workstation’s PATH. Install it there, then open this again.</p>
{:else if screen === "not-a-repo"}
  <p class="note">This workspace’s folder is not a Git repository.</p>
{:else if view && sync}
  {@const note = syncNote(view)}
  {@const line = branchLine(view)}
  <div class="git">
    <div class="head">
      <span class="branch">
        <GitBranch size={15} />
        <span class="branch-name">{line ?? "…"}</span>
      </span>
      <button
        type="button"
        class="icon"
        aria-label="Refresh"
        disabled={locked}
        onclick={() => void refresh(workspace.id)}
      >
        <RefreshCw size={17} />
      </button>
    </div>

    <div class="sync">
      <button type="button" class="sync-button" disabled={!sync.fetch.enabled} onclick={() => void fetch(workspace.id)}>
        <Download size={16} />
        {sync.fetch.label}
      </button>
      <button type="button" class="sync-button" disabled={!sync.pull.enabled} onclick={() => void pull(workspace.id)}>
        <ArrowDown size={16} />
        {sync.pull.label}
        {#if sync.pull.count > 0}<span class="count">{sync.pull.count}</span>{/if}
      </button>
      <button type="button" class="sync-button" disabled={!sync.push.enabled} onclick={() => void push(workspace.id)}>
        <ArrowUp size={16} />
        {sync.push.label}
        {#if sync.push.count > 0}<span class="count">{sync.push.count}</span>{/if}
      </button>
    </div>
    {#if note}
      <p class="hint">{note}</p>
    {/if}

    <GitOpBar workspaceId={workspace.id} />

    {#if banner}
      <div class="banner info" role="status">
        <span class="banner-text">{banner.text}</span>
        <span class="banner-acts">
          {#if banner.canContinue}
            <button
              type="button"
              disabled={!banner.continueEnabled}
              onclick={() => void continueInProgress(workspace.id, banner.kind)}
            >
              Continue
            </button>
          {/if}
          <button
            type="button"
            class="danger"
            disabled={locked}
            onclick={() => void abortInProgress(workspace.id, banner.kind)}
          >
            Abort {banner.kind}
          </button>
        </span>
      </div>
    {/if}
    {#if error}
      <div class="banner error" role="alert">
        <span class="banner-text">{error}</span>
        <span class="banner-acts">
          <button type="button" onclick={() => dismissError(workspace.id)}>Dismiss</button>
        </span>
      </div>
    {/if}

    {#if file && view.selected}
      <PhoneGitDiff
        workspaceId={workspace.id}
        entry={file}
        area={view.selected.area}
        onBack={() => void select(workspace.id, null)}
      />
    {:else}
      <div class="panes" role="tablist" aria-label="Git">
        <button
          type="button"
          role="tab"
          class="pane-tab"
          class:shown={pane === "changes"}
          aria-selected={pane === "changes"}
          onclick={() => (pane = "changes")}
        >
          Changes
          {#if changesCount(view) > 0}<span class="count">{changesCount(view)}</span>{/if}
        </button>
        <button
          type="button"
          role="tab"
          class="pane-tab"
          class:shown={pane === "branches"}
          aria-selected={pane === "branches"}
          onclick={() => (pane = "branches")}
        >
          Branches
        </button>
      </div>
      {#if pane === "changes"}
        <PhoneGitChanges workspaceId={workspace.id} />
      {:else}
        <PhoneGitBranches workspaceId={workspace.id} />
      {/if}
    {/if}
  </div>
{/if}

<style>
  .note {
    margin: 0;
    padding: 24px 16px;
    color: var(--text-muted);
    font-size: 0.875rem;
    line-height: 1.5;
  }
  .note.problem {
    color: var(--danger-text);
  }
  .git {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px max(8px, env(safe-area-inset-right)) 0 max(14px, env(safe-area-inset-left));
  }
  .branch {
    display: inline-flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--text);
    font-family: monospace;
    font-size: 0.875rem;
  }
  .branch-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .icon {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--text-muted);
  }
  .sync {
    display: flex;
    gap: 8px;
    padding: 4px max(12px, env(safe-area-inset-right)) 8px max(12px, env(safe-area-inset-left));
  }
  .sync-button {
    display: inline-flex;
    flex: 1 1 0;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 44px;
    padding: 0 8px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.875rem;
  }
  .sync-button:disabled,
  .icon:disabled {
    opacity: 0.45;
  }
  .sync-button:active:not(:disabled),
  .icon:active:not(:disabled) {
    background: var(--surface-hover);
  }
  .count {
    min-width: 1.4em;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--surface-accent);
    color: var(--accent-text);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
  .hint {
    margin: -2px 0 8px;
    padding: 0 max(14px, env(safe-area-inset-right)) 0 max(14px, env(safe-area-inset-left));
    color: var(--text-subtle);
    font-size: 0.75rem;
  }
  .banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 8px max(12px, env(safe-area-inset-right)) 8px max(12px, env(safe-area-inset-left));
    font-size: 0.8125rem;
  }
  .banner.info {
    border-block: 1px solid var(--border-warning);
    background: var(--surface-warning);
    color: var(--warning-text);
  }
  .banner.error {
    border-block: 1px solid var(--border-danger);
    background: var(--surface-danger);
    color: var(--danger-text);
  }
  .banner-text {
    flex: 1 1 14em;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .banner-acts {
    display: flex;
    gap: 8px;
    margin-left: auto;
  }
  .banner-acts button {
    min-height: 36px;
    padding: 0 12px;
    border: 1px solid currentColor;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font-size: 0.8125rem;
  }
  .banner-acts button:disabled {
    opacity: 0.45;
  }
  .panes {
    display: flex;
    flex: 0 0 auto;
    border-block: 1px solid var(--border);
    background: var(--surface-sunken);
  }
  .pane-tab {
    display: inline-flex;
    flex: 1 1 0;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 44px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--text-muted);
    font-size: 0.8125rem;
  }
  .pane-tab.shown {
    border-bottom-color: var(--accent);
    color: var(--text);
  }
  button:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }
</style>
