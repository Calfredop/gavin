<script lang="ts">
  import { ArrowRightLeft } from "@lucide/svelte";
  import {
    gitStore,
    setCompareBase,
    setCompareTarget,
    swapCompareRefs,
    setCompareMode,
    selectCompareFile,
  } from "$lib/git/gitState";
  import { compareRefOptions, LIST_DISPLAY_CAP, shortSha } from "$lib/git/git";
  import { filterFiles } from "$lib/git/gitSearch";
  import { isSearching } from "$lib/core/search";
  import { tooltip } from "$lib/core/tooltip";
  import IconButton from "$lib/ui/IconButton.svelte";
  import SearchInput from "$lib/ui/SearchInput.svelte";
  import GitFileRow from "$lib/git/GitFileRow.svelte";
  import GitRefPicker from "$lib/git/GitRefPicker.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const view = $derived($gitStore[workspaceId] ?? null);
  const compare = $derived(view?.compare ?? null);
  const summary = $derived(compare?.summary ?? null);
  const groups = $derived(
    view?.refs ? compareRefOptions(view.refs) : { head: [], branches: [], remotes: [], worktrees: [] }
  );
  const ready = $derived(compare !== null && compare.base !== null && compare.target !== null);

  let query = $state("");
  const filtering = $derived(isSearching(query));
  const files = $derived(filterFiles(summary?.files ?? [], query));
  const noop = (): void => {};
</script>

<div class="compare">
  <div class="refs">
    <span class="side">
      <span class="tag">Base</span>
      <GitRefPicker
        label="Base ref"
        value={compare?.base ?? null}
        {groups}
        disabled={!view?.refs}
        onPick={(v) => void setCompareBase(workspaceId, v)}
      />
    </span>
    <IconButton
      icon={ArrowRightLeft}
      label="Swap base and target"
      size={12}
      disabled={!ready || compare?.loading}
      onclick={() => void swapCompareRefs(workspaceId)}
    />
    <span class="side">
      <span class="tag">Target</span>
      <GitRefPicker
        label="Target ref"
        value={compare?.target ?? null}
        {groups}
        disabled={!view?.refs}
        onPick={(v) => void setCompareTarget(workspaceId, v)}
      />
    </span>
  </div>
  <div class="modebar">
    <span class="seg" role="radiogroup" aria-label="Diff mode">
      <button
        type="button"
        class:on={compare?.threeDot !== false}
        role="radio"
        aria-checked={compare?.threeDot !== false}
        use:tooltip={"Diff from the merge-base: what the target changed since the two refs forked"}
        onclick={() => void setCompareMode(workspaceId, true)}>Three-dot</button
      >
      <button
        type="button"
        class:on={compare?.threeDot === false}
        role="radio"
        aria-checked={compare?.threeDot === false}
        use:tooltip={"The full difference between the two refs"}
        onclick={() => void setCompareMode(workspaceId, false)}>Two-dot</button
      >
    </span>
    {#if summary}
      <span class="counts">
        {summary.filesChanged} file{summary.filesChanged === 1 ? "" : "s"} changed,
        <span class="ins">+{summary.insertions}</span> <span class="del">−{summary.deletions}</span>
        · {summary.commitsAhead} ahead, {summary.commitsBehind} behind
      </span>
    {/if}
  </div>
  {#if summary && compare?.threeDot !== false && summary.mergeBase === null}
    <div class="note">No common history — showing the full difference</div>
  {:else if summary && compare?.threeDot !== false && summary.mergeBase !== null}
    <div class="note">From merge-base {shortSha(summary.mergeBase)}</div>
  {/if}
  <div class="filter-bar">
    <SearchInput bind:value={query} label="Search changed files" placeholder="Filter by path…" />
  </div>
  <div class="rows" role="listbox" aria-label="Changed files">
    {#if !ready}
      <div class="none">Pick two refs to compare</div>
    {:else if summary === null}
      <div class="none">{compare?.loading ? "Loading…" : "No comparison yet"}</div>
    {:else if files.length === 0}
      <div class="none">{filtering ? "No match" : "No differences"}</div>
    {:else}
      {#each files.slice(0, LIST_DISPLAY_CAP) as entry (entry.path)}
        <GitFileRow
          {entry}
          area="staged"
          selected={compare?.selectedPath === entry.path}
          disabled={true}
          readonly={true}
          onSelect={() => selectCompareFile(workspaceId, entry.path)}
          onToggle={noop}
        />
      {/each}
      {#if files.length > LIST_DISPLAY_CAP}
        <div class="more">… and {files.length - LIST_DISPLAY_CAP} more</div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .compare {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--surface-sunken);
    font-family: monospace;
    color: var(--text);
  }
  .refs {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
  }
  .side {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
  }
  .tag {
    color: var(--text-subtle);
    font-size: 0.72em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .modebar {
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
    flex: 0 0 auto;
  }
  .seg button {
    background: transparent;
    border: 0;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.95em;
    padding: 2px 8px;
    cursor: pointer;
  }
  .seg button.on {
    background: var(--surface-accent);
    color: var(--text);
  }
  .counts {
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ins {
    color: var(--success-text);
  }
  .del {
    color: var(--danger-text);
  }
  .note {
    padding: 4px 8px;
    color: var(--text-subtle);
    font-size: 0.72em;
    border-bottom: 1px solid var(--border);
  }
  .filter-bar {
    padding: 5px 8px;
    border-bottom: 1px solid var(--border);
    flex: 0 0 auto;
  }
  .rows {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .more,
  .none {
    padding: 6px 8px;
    color: var(--text-subtle);
    font-size: 0.75em;
  }
</style>
