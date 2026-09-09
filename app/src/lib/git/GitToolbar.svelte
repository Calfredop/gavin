<script lang="ts">
  import { GitBranch, RefreshCw, Download, ArrowDown, ArrowUp, Archive, ArchiveRestore, Bot, Check, Eye, ScanSearch } from "@lucide/svelte";
  import {
    gitStore,
    refresh,
    commitViaAgent,
    revealAgentCommit,
    agentCommitPhase,
    agentCommitBlocker,
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
  } from "$lib/git/gitState";
  import { branchLabel } from "$lib/git/git";
  import { gavinTrees } from "$lib/core/gavinState";
  import {
    agentProfilesStore,
    agentModelDefaultsStore,
    layoutState,
    trustedAgentConfigs,
  } from "$lib/core/layoutState";
  import { resolveAgentConfig } from "$lib/core/settings";
  import { reviewBlocker } from "$lib/review/codeReview";
  import { requestBranchReview } from "$lib/review/codeReviewActions";
  import { tooltip } from "$lib/core/tooltip";
  import IconButton from "$lib/ui/IconButton.svelte";
  import GitPromptDialog from "$lib/git/GitPromptDialog.svelte";

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

  // Read reactively rather than through resolvedAgentFor(): that helper
  // is a one-shot get(), so the button would keep whatever the agent
  // config was when this toolbar first rendered.
  const agent = $derived(
    resolveAgentConfig(
      $trustedAgentConfigs(workspaceId),
      $agentProfilesStore,
      $agentModelDefaultsStore
    )
  );
  const agentPhase = $derived(agentCommitPhase(view));
  const agentBusy = $derived(agentPhase === "starting" || agentPhase === "running");
  const agentBlocker = $derived(agentCommitBlocker(view, agent.headlessArgs));

  // Reviewing needs a gavin context to file findings into, so the root
  // context is the gate -- not the repository. A rooted workspace whose
  // tree has not arrived yet still names its root folder, which is where
  // `.gavin-root` is; codeReviewActions falls back to it for the same
  // reason.
  const reviewContext = $derived(
    $gavinTrees[workspaceId]?.contexts.find((c) => c.kind === "root")?.folderPath ??
      $layoutState.workspaces.find((w) => w.id === workspaceId)?.rootPath ??
      null
  );
  const reviewDisabled = $derived(
    reviewBlocker({ promptArgs: agent.promptArgs, agentLabel: agent.label, contextFolder: reviewContext })
  );

  let stashDialog = $state(false);
  let reviewError = $state<string | null>(null);

  async function startReview(): Promise<void> {
    reviewError = await requestBranchReview(workspaceId, view?.cwd ?? "");
  }

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
    <IconButton
      icon={Download}
      label="Fetch"
      text="Fetch"
      tip={tip(`Fetch from ${remote ?? "remote"}`, sync.fetch)}
      variant="outlined"
      size={13}
      disabled={locked || !sync.fetch}
      onclick={() => fetch(workspaceId)}
    />
    <IconButton
      icon={ArrowDown}
      label="Pull"
      text="Pull"
      tip={tip("Pull", sync.pull)}
      variant="outlined"
      size={13}
      disabled={locked || !sync.pull}
      onclick={() => pull(workspaceId)}
    >
      {#if branch && branch.behind > 0}<span class="badge">↓{branch.behind}</span>{/if}
    </IconButton>
    <IconButton
      icon={ArrowUp}
      label={pushText}
      text={pushText}
      tip={tip(`${pushText} to ${remote ?? "remote"}`, sync.push)}
      variant="outlined"
      size={13}
      disabled={locked || !sync.push}
      onclick={() => push(workspaceId)}
    >
      {#if branch && branch.ahead > 0}<span class="badge">↑{branch.ahead}</span>{/if}
    </IconButton>
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
    <IconButton
      icon={Archive}
      label="Stash"
      text="Stash"
      tip="Stash all changes"
      variant="outlined"
      size={13}
      disabled={locked || !view?.status || (view.status.unstaged.length === 0 && view.status.staged.length === 0)}
      onclick={() => (stashDialog = true)}
    />
    <IconButton
      icon={ArchiveRestore}
      label="Pop"
      text="Pop"
      tip={stashCount > 0 ? "Pop the latest stash" : "No stashes"}
      variant="outlined"
      size={13}
      disabled={locked || stashCount === 0}
      onclick={() => stashPop(workspaceId, 0)}
    >
      {#if stashCount > 0}<span class="badge">{stashCount}</span>{/if}
    </IconButton>
  </span>

  <span class="spacer"></span>
  {#if agentBusy}
    <span class="agent-state" role="status" aria-live="polite">
      <span class="spinner" aria-hidden="true"></span>
      Committing…
    </span>
    {#if agentPhase === "running"}
      <IconButton
        icon={Eye}
        label="Show the agent"
        text="Show"
        tip="Open the agent's session on the Agents page — it keeps running either way"
        variant="outlined"
        size={13}
        onclick={() => void revealAgentCommit(workspaceId)}
      />
    {/if}
  {:else if agentPhase === "done"}
    <span class="agent-state done" role="status" aria-live="polite">
      <Check size={13} />
      Committed
    </span>
  {:else}
    <IconButton
      icon={Bot}
      label="Commit via agent"
      text="Commit via agent"
      tip={agentBlocker ?? "Hand the working tree to the agent: it commits in logical chunks, and never pushes"}
      variant="outlined"
      size={13}
      disabled={agentBlocker !== null}
      onclick={() => void commitViaAgent(workspaceId)}
    />
  {/if}
  <!-- The reason hangs on the SPAN, not the button: a disabled element
       never fires mouseenter, so a tooltip bound to one can never
       appear. Null while the action is available, so the button's own
       tooltip is the only one on screen. -->
  <span use:tooltip={reviewDisabled}>
    <IconButton
      icon={ScanSearch}
      label="Review with agent"
      text="Review"
      tip="Review this branch against a base — every finding is filed as a card on the board"
      variant="outlined"
      size={13}
      disabled={reviewDisabled !== null || view?.cwd == null}
      onclick={() => void startReview()}
    />
  </span>
  <IconButton icon={RefreshCw} label="Refresh" variant="outlined" size={13} disabled={locked} onclick={() => refresh(workspaceId)} />
</div>

{#if reviewError}
  <div class="review-error" role="alert">
    <span>{reviewError}</span>
    <button type="button" use:tooltip={"Dismiss"} onclick={() => (reviewError = null)}>✕</button>
  </div>
{/if}

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
  /* Occupies the same slot as the button it replaces, so the toolbar's
     right end does not shift as the run changes phase. */
  .agent-state {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 5px;
    border: 1px solid transparent;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .agent-state.done {
    color: var(--success-text);
  }
  /* A refused review has no session and no banner of its own -- the Git
     tab's own error strip belongs to git operations. */
  .review-error {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 10px;
    background: var(--surface-danger);
    border-bottom: 1px solid var(--border-danger);
    color: var(--danger-text);
    font-size: 0.75em;
  }
  .review-error span {
    flex: 1 1 auto;
    white-space: pre-wrap;
  }
  .review-error button {
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
  }
  .spinner {
    width: 9px;
    height: 9px;
    border: 2px solid var(--border-accent);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
