<script lang="ts">
  import { gitStore, findEntry, applyPatch } from "./gitState";
  import { toUnifiedRows } from "./diffRows";
  import { buildPatch } from "./patch";
  import { LARGE_HUNK_LINES } from "./git";
  import GitDiffUnified from "./GitDiffUnified.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const view = $derived($gitStore[workspaceId]);
  const selected = $derived(view?.selected ?? null);
  const entry = $derived(view ? findEntry(view.status, view.selected) : null);
  const diff = $derived(view?.diff ?? null);
  const busy = $derived(view?.busy != null);
  // Untracked files have no index entry to patch against: file-level only (spec §1).
  const canAct = $derived(entry !== null && entry.status !== "?" && !busy);
  const actionLabel = $derived(selected?.area === "staged" ? "Unstage" : "Stage");
  const unifiedRows = $derived(diff ? toUnifiedRows(diff.hunks) : []);

  let expanded = $state<Set<number>>(new Set());
  $effect(() => {
    void diff; // a new diff starts with every large hunk collapsed again
    expanded = new Set();
  });
  function isCollapsed(hunkIndex: number, lineCount: number): boolean {
    return lineCount > LARGE_HUNK_LINES && !expanded.has(hunkIndex);
  }
  function expand(hunkIndex: number): void {
    expanded = new Set([...expanded, hunkIndex]);
  }

  function hunkAction(hunkIndex: number): void {
    if (!diff || !selected || !canAct) return;
    const patch = buildPatch(diff, hunkIndex, null);
    if (!patch) return;
    void applyPatch(workspaceId, patch, selected.area === "staged" ? "unstage" : "stage");
  }
</script>

<div class="diff">
  {#if selected && entry}
    <div class="head">
      <span class="badge">{entry.status}</span>
      <span class="path">{#if entry.oldPath}{entry.oldPath} → {/if}{entry.path}</span>
      <span class="area">{selected.area}</span>
    </div>
  {/if}
  <div class="body">
    {#if !selected}
      <div class="msg">Select a file to see its diff</div>
    {:else if !diff}
      <div class="msg">Loading…</div>
    {:else if diff.binary}
      <div class="msg">Binary file — no text diff</div>
    {:else if diff.tooLarge}
      <div class="msg">Diff too large (&gt; 2 MB)</div>
    {:else if diff.hunks.length === 0}
      <div class="msg">No changes</div>
    {:else}
      <GitDiffUnified rows={unifiedRows} {isCollapsed} {canAct} {actionLabel} onHunkAction={hunkAction} onExpand={expand} />
    {/if}
  </div>
</div>

<style>
  .diff {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: #151515;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    border-bottom: 1px solid #2f2f2f;
    font-size: 0.78em;
  }
  .badge {
    font-weight: 700;
    color: #d9b45c;
  }
  .path {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #ddd;
  }
  .area {
    color: #777;
    text-transform: uppercase;
    font-size: 0.85em;
    letter-spacing: 0.05em;
  }
  .body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }
  .msg {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #777;
    font-size: 0.8em;
  }
</style>
