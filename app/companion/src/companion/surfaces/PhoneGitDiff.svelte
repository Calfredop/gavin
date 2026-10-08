<script lang="ts">
  // One file's diff, as a page of its own: the desk's third column, which
  // a phone has no room for beside the list. The lines are the desk's own
  // unified diff, read-only -- a whole file is staged from the button in
  // the page's bar, as its row does in the list.
  import { ChevronLeft } from "@lucide/svelte";
  import { toUnifiedRows } from "$lib/git/diffRows";
  import { LARGE_HUNK_LINES, type Area, type FileEntry } from "$lib/git/git";
  import GitDiffUnified from "$lib/git/GitDiffUnified.svelte";
  import { gitStore, resolveWhole, stageFiles, unstageFiles } from "$lib/git/gitState";
  import { diffBody, diffHeading, fileAction, gitLocked } from "$companion/surfaces/phoneGit";

  interface Props {
    workspaceId: string;
    entry: FileEntry;
    area: Area;
    onBack: () => void;
  }
  let { workspaceId, entry, area, onBack }: Props = $props();

  const view = $derived($gitStore[workspaceId] ?? null);
  const locked = $derived(gitLocked(view));
  const heading = $derived(diffHeading(entry, area));
  const body = $derived(view ? diffBody(view, entry) : "loading");
  const rows = $derived(view?.diff ? toUnifiedRows(view.diff.hunks) : []);

  // Large hunks open folded, as at the desk; a new diff folds them again.
  let expanded = $state<Set<number>>(new Set());
  $effect(() => {
    void view?.diff;
    expanded = new Set();
  });

  const NO_SELECTION: ReadonlySet<string> = new Set();
  const nothing = (): void => {};

  function act(): void {
    if (locked) return;
    void (area === "staged" ? unstageFiles(workspaceId, [entry.path]) : stageFiles(workspaceId, [entry.path]));
  }
</script>

<div class="page">
  <div class="bar">
    <button type="button" class="back" onclick={onBack}>
      <ChevronLeft size={18} />
      <span>Changes</span>
    </button>
    <button type="button" class="act" disabled={locked} onclick={act}>{fileAction(entry, area)}</button>
  </div>
  <div class="heading">
    <span class="name">{heading.name}</span>
    {#if heading.dir}<span class="dir">{heading.dir}</span>{/if}
    <span class="detail">{heading.detail}</span>
  </div>

  <div class="body">
    {#if body === "loading"}
      <p class="msg">Loading…</p>
    {:else if body === "conflict"}
      <div class="conflict">
        <p>
          Both sides changed this file. Keep one side whole, or fix the file in Files and then mark
          it resolved above, which git refuses while conflict markers are left in it.
        </p>
        <div class="choices">
          <button type="button" disabled={locked} onclick={() => void resolveWhole(workspaceId, "ours")}>
            Keep ours
          </button>
          <button type="button" disabled={locked} onclick={() => void resolveWhole(workspaceId, "theirs")}>
            Take theirs
          </button>
        </div>
      </div>
    {:else if body === "binary"}
      <p class="msg">Binary file — no text diff</p>
    {:else if body === "too-large"}
      <p class="msg">This diff is too large to show.</p>
    {:else if body === "empty"}
      <p class="msg">No changes</p>
    {:else}
      <GitDiffUnified
        {rows}
        isCollapsed={(hunk, lines) => lines > LARGE_HUNK_LINES && !expanded.has(hunk)}
        canAct={false}
        actionLabel=""
        onHunkAction={nothing}
        onExpand={(hunk) => (expanded = new Set([...expanded, hunk]))}
        selection={NO_SELECTION}
        onLineClick={nothing}
        onDragRange={nothing}
        selectedLabel={() => null}
        discardLabel={() => null}
        onHunkDiscard={nothing}
      />
    {/if}
  </div>
</div>

<style>
  .page {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
    border-top: 1px solid var(--border);
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 12px 0 6px;
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    min-height: 44px;
    padding: 0 8px 0 2px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--accent-text);
    font-size: 0.875rem;
  }
  .act {
    min-height: 44px;
    padding: 0 14px;
    border: 1px solid var(--border-success);
    border-radius: 6px;
    background: var(--surface-success);
    color: var(--success-text);
    font-size: 0.8125rem;
  }
  .act:disabled {
    opacity: 0.45;
  }
  .heading {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 14px 10px;
    border-bottom: 1px solid var(--border);
    font-family: monospace;
  }
  .name {
    overflow-wrap: anywhere;
    color: var(--text);
    font-size: 0.9375rem;
  }
  .dir,
  .detail {
    overflow-wrap: anywhere;
    color: var(--text-subtle);
    font-size: 0.75rem;
  }
  .body {
    flex: 1 1 auto;
    min-height: 0;
    padding-bottom: env(safe-area-inset-bottom);
    overflow: auto;
    background: var(--surface-sunken);
    /* The desk's diff sets its lines at 0.76em of this: about 13px, the
       smallest a phone reads code at without zooming. */
    font-size: 1.0625rem;
  }
  .msg {
    margin: 0;
    padding: 24px 16px;
    color: var(--text-subtle);
    font-size: 0.8125rem;
    text-align: center;
  }
  .conflict {
    padding: 16px;
    color: var(--text-muted);
    font-size: 0.875rem;
    line-height: 1.5;
  }
  .conflict p {
    margin: 0 0 12px;
  }
  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .choices button {
    min-height: 44px;
    padding: 0 14px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.8125rem;
  }
  .choices button:disabled {
    opacity: 0.45;
  }
  button:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }
</style>
