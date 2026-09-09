<script lang="ts">
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import {
    gitStore,
    loadMore,
    selectCommit,
    setGraphAll,
    setLogFilter,
    checkoutCommit,
    cherryPick,
    revertCommit,
    resetTo,
    createBranch,
    currentBranch,
  } from "$lib/gitState";
  import { matchesFilter, shortSha, type CommitInfo, type ResetMode } from "$lib/git";
  import { computeGraph } from "$lib/graphLanes";
  import { openContextMenuFromEvent, type ContextMenuEntry } from "$lib/contextMenu";
  import GitGraphRow from "$lib/GitGraphRow.svelte";
  import GitPromptDialog from "$lib/GitPromptDialog.svelte";
  import GitDiscardDialog from "$lib/GitDiscardDialog.svelte";
  import GitResetDialog from "$lib/GitResetDialog.svelte";
  import SearchInput from "$lib/ui/SearchInput.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const view = $derived($gitStore[workspaceId] ?? null);
  const log = $derived(view?.log ?? null);
  const commits = $derived(log?.commits ?? []);
  const rows = $derived(computeGraph(commits));
  const width = $derived(Math.max(1, ...rows.map((r) => r.lanes)));
  const filter = $derived(view?.logFilter ?? "");
  const visible = $derived(commits.map((c, i) => ({ c, i })).filter(({ c }) => matchesFilter(c, filter)));
  const locked = $derived(view == null || view.busy != null || view.op != null);
  const selected = $derived(view?.selectedCommit ?? null);
  const branch = $derived(view ? currentBranch(view) : null);
  const detached = $derived(view?.repo?.detached ?? false);

  let branchFrom = $state<string | null>(null);
  let revertSha = $state<string | null>(null);
  let resetSha = $state<string | null>(null);

  function menu(e: MouseEvent, c: CommitInfo): void {
    const cur = branch?.name ?? "HEAD";
    const entries: ContextMenuEntry[] = [
      { label: "Checkout (detached)", disabled: locked || c.isHead, onPick: () => void checkoutCommit(workspaceId, c.sha) },
      { label: "New branch here…", disabled: locked, onPick: () => (branchFrom = c.sha) },
      { separator: true },
      { label: `Copy SHA ${shortSha(c.sha)}`, onPick: () => void writeText(c.sha) },
      { label: "Copy message", onPick: () => void writeText(c.subject) },
      { separator: true },
      { label: `Cherry-pick onto ${cur}`, disabled: locked || c.isHead, onPick: () => void cherryPick(workspaceId, c.sha) },
      { label: "Revert…", disabled: locked || detached, onPick: () => (revertSha = c.sha) },
      { label: `Reset ${cur} to here…`, danger: true, disabled: locked || detached || c.isHead, onPick: () => (resetSha = c.sha) },
    ];
    openContextMenuFromEvent(e, entries);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const idx = visible.findIndex(({ c }) => c.sha === selected);
    const next = visible[idx + (e.key === "ArrowDown" ? 1 : -1)] ?? (idx < 0 ? visible[0] : undefined);
    if (next) void selectCommit(workspaceId, next.c.sha);
  }
</script>

<div class="graph" tabindex="0" role="listbox" aria-label="Commits" onkeydown={onKeydown}>
  <header>
    <span class="seg" role="radiogroup" aria-label="Graph scope">
      <button type="button" class:on={log?.all !== false} role="radio" aria-checked={log?.all !== false} onclick={() => setGraphAll(workspaceId, true)}>All branches</button>
      <button type="button" class:on={log?.all === false} role="radio" aria-checked={log?.all === false} onclick={() => setGraphAll(workspaceId, false)}>Current</button>
    </span>
    <SearchInput
      class="filter"
      value={filter}
      onValue={(next) => setLogFilter(workspaceId, next)}
      label="Search commits"
      placeholder="Search subject, author, sha…"
    />
    <span class="count">{filter ? `${visible.length} of ${commits.length}` : commits.length}{log?.hasMore ? "+" : ""}</span>
  </header>
  <div class="rows">
    {#if !log && view?.logLoading}
      <div class="none">Loading…</div>
    {:else if commits.length === 0}
      <div class="none">{view?.repo?.unborn ? "No commits yet" : "No commits"}</div>
    {:else}
      {#each visible as { c, i } (c.sha)}
        <GitGraphRow commit={c} row={rows[i]} {width} selected={c.sha === selected} onSelect={() => selectCommit(workspaceId, c.sha)} onMenu={(e) => menu(e, c)} />
      {/each}
      {#if log?.hasMore}
        <button type="button" class="more" disabled={view?.logLoading} onclick={() => loadMore(workspaceId)}>
          {view?.logLoading ? "Loading…" : "Load more"}
        </button>
      {/if}
    {/if}
  </div>
</div>

{#if branchFrom}
  {@const from = branchFrom}
  <GitPromptDialog
    title={`New branch at ${shortSha(from)}`}
    fields={[{ key: "name", label: "Branch name", value: "", placeholder: "feature/thing", required: true }]}
    checkbox={{ label: "Checkout after creating", checked: true }}
    primary="Create"
    onSubmit={(values, checked) => {
      branchFrom = null;
      void createBranch(workspaceId, values.name, from, checked);
    }}
    onCancel={() => (branchFrom = null)}
  />
{/if}

{#if revertSha}
  {@const sha = revertSha}
  <GitDiscardDialog
    title={`Revert ${shortSha(sha)}?`}
    body={"A new commit undoing this one is created on the current branch. Conflicts show in the banner with Abort / Continue."}
    offerSkip={false}
    confirmLabel="Revert"
    onConfirm={() => {
      revertSha = null;
      void revertCommit(workspaceId, sha);
    }}
    onCancel={() => (revertSha = null)}
  />
{/if}

{#if resetSha}
  {@const sha = resetSha}
  <GitResetDialog
    {sha}
    branch={branch?.name ?? "HEAD"}
    onConfirm={(mode: ResetMode) => {
      resetSha = null;
      void resetTo(workspaceId, sha, mode);
    }}
    onCancel={() => (resetSha = null)}
  />
{/if}

<style>
  .graph {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--surface-sunken);
    outline: none;
    font-family: monospace;
  }
  .graph:focus-visible {
    box-shadow: inset 0 0 0 1px var(--border-accent);
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px;
    border-bottom: 1px solid var(--border);
    font-size: 0.75em;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .seg button {
    background: transparent;
    border: 0;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 1em;
    padding: 2px 8px;
    cursor: pointer;
  }
  .seg button.on {
    background: var(--surface-accent);
    color: var(--text);
  }
  header :global(.filter) {
    flex: 1 1 auto;
    min-width: 0;
  }
  .count {
    color: var(--text-subtle);
  }
  .rows {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }
  .none {
    padding: 12px 10px;
    color: var(--text-subtle);
    font-size: 0.78em;
  }
  .more {
    width: 100%;
    background: transparent;
    border: 0;
    border-top: 1px solid var(--border);
    color: var(--accent-text);
    font-family: monospace;
    font-size: 0.78em;
    padding: 8px;
    cursor: pointer;
  }
  .more:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
