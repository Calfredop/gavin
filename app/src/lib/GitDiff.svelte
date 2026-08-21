<script lang="ts">
  import { gitStore, findEntry, applyPatch, setLineSelection } from "./gitState";
  import { layoutState, setGitViewPrefs } from "./layoutState";
  import { toUnifiedRows, toSplitRows } from "./diffRows";
  import { clickLine, rangeIds, selectionHunk } from "./diffSelection";
  import { buildPatch } from "./patch";
  import { describeHunkDiscard } from "./discardFlow";
  import { LARGE_HUNK_LINES, type DiffLayout } from "./git";
  import GitDiffUnified from "./GitDiffUnified.svelte";
  import GitDiffSplit from "./GitDiffSplit.svelte";
  import GitDiscardDialog from "./GitDiscardDialog.svelte";

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

  // Line selection (spec §3): ids are layout-independent, so the same set
  // drives both layouts; the anchor is the last plain-clicked line.
  const selection = $derived(view?.lineSelection ?? new Set<string>());
  let anchor = $state<number | null>(null);
  $effect(() => {
    void diff;
    anchor = null;
  });

  function onLineClick(hunkIndex: number, lineIndex: number, shift: boolean): void {
    if (!diff || !canAct) return;
    const next = clickLine(selection, diff.hunks, hunkIndex, lineIndex, shift, anchor);
    anchor = next.anchor;
    setLineSelection(workspaceId, next.ids);
  }
  function onDragRange(hunkIndex: number, from: number, to: number): void {
    if (!diff || !canAct) return;
    anchor = from;
    setLineSelection(workspaceId, rangeIds(diff.hunks, hunkIndex, from, to));
  }
  function selectedLabel(hunkIndex: number): string | null {
    return selectionHunk(selection) === hunkIndex && selection.size > 0 ? `${actionLabel} selected (${selection.size})` : null;
  }
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && selection.size > 0) {
      e.preventDefault();
      setLineSelection(workspaceId, new Set());
    }
  }

  // A selection inside the hunk stages only those lines; otherwise the whole hunk.
  function hunkAction(hunkIndex: number): void {
    if (!diff || !selected || !canAct) return;
    const partial = selectionHunk(selection) === hunkIndex && selection.size > 0 ? selection : null;
    const patch = buildPatch(diff, hunkIndex, partial);
    if (!patch) return;
    void applyPatch(workspaceId, patch, selected.area === "staged" ? "unstage" : "stage");
  }

  // Discard (spec §4): worktree changes only — unstaged rows of tracked
  // files. Confirms unless the per-workspace hunk/line opt-out is set.
  const skipHunkConfirm = $derived(
    $layoutState.workspaces.find((w) => w.id === workspaceId)?.gitView?.skipHunkDiscardConfirm ?? false
  );
  function discardLabelFor(hunkIndex: number): string | null {
    if (selected?.area !== "unstaged" || !canAct) return null;
    return selectionHunk(selection) === hunkIndex && selection.size > 0 ? `Discard selected (${selection.size})` : "Discard";
  }
  let pendingHunk = $state<{ hunkIndex: number; patch: string; title: string; body: string } | null>(null);

  function onHunkDiscard(hunkIndex: number): void {
    if (!diff || !selected || selected.area !== "unstaged" || !canAct) return;
    const partial = selectionHunk(selection) === hunkIndex && selection.size > 0 ? selection : null;
    const patch = buildPatch(diff, hunkIndex, partial);
    if (!patch) return;
    if (skipHunkConfirm) {
      void applyPatch(workspaceId, patch, "discard");
      return;
    }
    const { title, body } = describeHunkDiscard(diff.path, partial ? partial.size : null);
    pendingHunk = { hunkIndex, patch, title, body };
  }
  function confirmHunkDiscard(skip: boolean): void {
    if (!pendingHunk) return;
    const { patch } = pendingHunk;
    pendingHunk = null;
    if (skip) void setGitViewPrefs(workspaceId, { skipHunkDiscardConfirm: true });
    void applyPatch(workspaceId, patch, "discard");
  }
</script>

<!-- Focusable so Esc can clear the line selection; lines inside are the
     pointer targets. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="diff" role="listbox" aria-label="Diff" tabindex="-1" onkeydown={onKeydown} onpointerdown={(e) => e.currentTarget.focus()}>
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
    {#if view && typeof view.navSelection === "object"}
      <div class="msg">Stash contents — pop or apply to edit</div>
    {:else if !selected}
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
      <GitDiffSplit
        rows={splitRows}
        {isCollapsed}
        {canAct}
        {actionLabel}
        onHunkAction={hunkAction}
        onExpand={expand}
        {selection}
        {onLineClick}
        {onDragRange}
        {selectedLabel}
        discardLabel={discardLabelFor}
        {onHunkDiscard}
      />
    {:else}
      <GitDiffUnified
        rows={unifiedRows}
        {isCollapsed}
        {canAct}
        {actionLabel}
        onHunkAction={hunkAction}
        onExpand={expand}
        {selection}
        {onLineClick}
        {onDragRange}
        {selectedLabel}
        discardLabel={discardLabelFor}
        {onHunkDiscard}
      />
    {/if}
  </div>
</div>

{#if pendingHunk}
  <GitDiscardDialog title={pendingHunk.title} body={pendingHunk.body} offerSkip={true} onConfirm={confirmHunkDiscard} onCancel={() => (pendingHunk = null)} />
{/if}

<style>
  .diff {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--surface-sunken);
  }
  .diff:focus {
    outline: none;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    border-bottom: 1px solid var(--border);
    font-size: 0.78em;
  }
  .badge {
    font-weight: 700;
    color: var(--warning-text);
  }
  .path {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }
  .area {
    color: var(--text-subtle);
    text-transform: uppercase;
    font-size: 0.85em;
    letter-spacing: 0.05em;
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
    color: var(--text-subtle);
    font-size: 0.8em;
  }
</style>
