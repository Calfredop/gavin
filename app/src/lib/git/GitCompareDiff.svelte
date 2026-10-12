<script lang="ts">
  import { gitStore } from "$lib/git/gitState";
  import { layoutState, setGitViewPrefs } from "$lib/core/layoutState";
  import { LARGE_HUNK_LINES, type DiffLayout } from "$lib/git/git";
  import { toUnifiedRows, toSplitRows } from "$lib/git/diffRows";
  import GitDiffUnified from "$lib/git/GitDiffUnified.svelte";
  import GitDiffSplit from "$lib/git/GitDiffSplit.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const view = $derived($gitStore[workspaceId] ?? null);
  const compare = $derived(view?.compare ?? null);
  const diff = $derived(compare?.diff ?? null);
  const layout = $derived<DiffLayout>($layoutState.workspaces.find((w) => w.id === workspaceId)?.gitView?.diffLayout ?? "unified");
  const unifiedRows = $derived(diff ? toUnifiedRows(diff.hunks) : []);
  const splitRows = $derived(diff ? toSplitRows(diff.hunks) : []);
  const noSelection = new Set<string>();

  let expanded = $state<Set<number>>(new Set());
  $effect(() => {
    void diff;
    expanded = new Set();
  });
  const isCollapsed = (h: number, n: number): boolean => n > LARGE_HUNK_LINES && !expanded.has(h);
  const expand = (h: number): void => {
    expanded = new Set([...expanded, h]);
  };
  const noop = (): void => {};
  const nullLabel = (): null => null;
</script>

<div class="compare-diff">
  <div class="head">
    <span class="path" title={compare?.selectedPath ?? ""}>{compare?.selectedPath ?? ""}</span>
    <span class="spacer"></span>
    <span class="seg" role="radiogroup" aria-label="Diff layout">
      <button type="button" class:on={layout === "unified"} role="radio" aria-checked={layout === "unified"} onclick={() => setGitViewPrefs(workspaceId, { diffLayout: "unified" })}>Unified</button>
      <button type="button" class:on={layout === "split"} role="radio" aria-checked={layout === "split"} onclick={() => setGitViewPrefs(workspaceId, { diffLayout: "split" })}>Split</button>
    </span>
  </div>
  <div class="diff">
    {#if !compare?.selectedPath}
      <div class="msg small">Select a file</div>
    {:else if !diff}
      <div class="msg small">{compare.diffLoading ? "Loading…" : "No diff"}</div>
    {:else if diff.binary}
      <div class="msg small">Binary file — no text diff</div>
    {:else if diff.tooLarge}
      <div class="msg small">Diff too large (&gt; 2 MB)</div>
    {:else if diff.hunks.length === 0}
      <div class="msg small">No textual changes</div>
    {:else if layout === "split"}
      <GitDiffSplit rows={splitRows} {isCollapsed} canAct={false} actionLabel="" onHunkAction={noop} onExpand={expand} selection={noSelection} onLineClick={noop} onDragRange={noop} selectedLabel={nullLabel} discardLabel={nullLabel} onHunkDiscard={noop} />
    {:else}
      <GitDiffUnified rows={unifiedRows} {isCollapsed} canAct={false} actionLabel="" onHunkAction={noop} onExpand={expand} selection={noSelection} onLineClick={noop} onDragRange={noop} selectedLabel={nullLabel} discardLabel={nullLabel} onHunkDiscard={noop} />
    {/if}
  </div>
</div>

<style>
  .compare-diff {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--surface-sunken);
    font-family: monospace;
    color: var(--text);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 10px;
    border-bottom: 1px solid var(--border);
    font-size: 0.78em;
  }
  .path {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .spacer {
    flex: 1 1 auto;
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
    font-size: 0.95em;
    padding: 2px 8px;
    cursor: pointer;
  }
  .seg button.on {
    background: var(--surface-accent);
    color: var(--text);
  }
  .diff {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }
  .msg {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-subtle);
    font-size: 0.8em;
  }
  .msg.small {
    padding: 16px;
  }
</style>
