<script lang="ts">
  import { gitStore, findEntry, applyPatch } from "./gitState";
  import { layoutState, setGitViewPrefs } from "./layoutState";
  import { toUnifiedRows, toSplitRows } from "./diffRows";
  import { buildPatch } from "./patch";
  import { LARGE_HUNK_LINES, type DiffLayout } from "./git";
  import GitDiffUnified from "./GitDiffUnified.svelte";
  import GitDiffSplit from "./GitDiffSplit.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const view = $derived($gitStore[workspaceId]);
  const layout = $derived<DiffLayout>(
    $layoutState.workspaces.find((w) => w.id === workspaceId)?.gitView?.diffLayout ?? "unified"
  );
  function setLayout(next: DiffLayout): void {
    if (next !== layout) void setGitViewPrefs(workspaceId, { diffLayout: next });
  }
  const selected = $derived(view?.selected ?? null);
  const entry = $derived(view ? findEntry(view.status, view.selected) : null);
  const diff = $derived(view?.diff ?? null);
  const busy = $derived(view?.busy != null);
  // Untracked files have no index entry to patch against: file-level only (spec §1).
  const canAct = $derived(entry !== null && entry.status !== "?" && !busy);
  const actionLabel = $derived(selected?.area === "staged" ? "Unstage" : "Stage");
  const unifiedRows = $derived(diff ? toUnifiedRows(diff.hunks) : []);
  const splitRows = $derived(diff ? toSplitRows(diff.hunks) : []);

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
      <span class="seg" role="radiogroup" aria-label="Diff layout">
        <button type="button" class:on={layout === "unified"} role="radio" aria-checked={layout === "unified"} onclick={() => setLayout("unified")}>Unified</button>
        <button type="button" class:on={layout === "split"} role="radio" aria-checked={layout === "split"} onclick={() => setLayout("split")}>Split</button>
      </span>
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
    {:else if layout === "split"}
      <GitDiffSplit rows={splitRows} {isCollapsed} {canAct} {actionLabel} onHunkAction={hunkAction} onExpand={expand} />
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
  .seg {
    display: inline-flex;
    border: 1px solid #3a3a3a;
    border-radius: 6px;
    overflow: hidden;
  }
  .seg button {
    background: transparent;
    border: 0;
    color: #999;
    font-family: monospace;
    font-size: 0.95em;
    padding: 2px 8px;
    cursor: pointer;
  }
  .seg button.on {
    background: #2a3a4a;
    color: #eee;
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
