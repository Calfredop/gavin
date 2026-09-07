<script lang="ts">
  // The Review tab's third column: one file, read as a diff or opened
  // for editing.
  //
  // Two modes rather than three, and they are not the FileEditor's own
  // modes: Diff is what the run did to this file, Edit is the file as it
  // is now. FileEditor keeps its own formatted/plain/edit switcher
  // inside Edit, so a markdown file still renders -- this switcher sits
  // above that one and answers a different question ("what changed" vs
  // "what is there").
  //
  // Editing here is deliberate. A review that can only look is a review
  // that has to be carried somewhere else to act on, and the one-line
  // fixes a reviewer finds are exactly the ones not worth a session.
  // FileEditor autosaves and reconciles external writes on its own, which
  // is what makes that safe while the card's agent is alive in the first
  // column.
  import GitDiffUnified from "./GitDiffUnified.svelte";
  import FileEditor from "./FileEditor.svelte";
  import { toUnifiedRows } from "./diffRows";
  import { LARGE_HUNK_LINES, splitPath } from "./git";
  import type { FileDiff } from "./git";

  export type ReviewFileMode = "diff" | "edit";

  interface Props {
    /// Root-relative, as every path in a run's changes is.
    file: string | null;
    /// The repository root the paths are relative to, so Edit can open
    /// an absolute one. Null while the run's changes have not landed --
    /// Edit is then not offered rather than guessing a base.
    root: string | null;
    diff: FileDiff | null;
    loading: boolean;
    error: string | null;
  }
  let { file, root, diff, loading, error }: Props = $props();

  let mode = $state<ReviewFileMode>("diff");
  // Diff again on every new file. The mode is a question about the file
  // in front of you ("show me what changed here"), not a standing
  // preference -- and landing in Edit on a file you have not read yet is
  // an invitation to type into it by accident.
  $effect(() => {
    void file;
    mode = "diff";
  });

  const absolute = $derived(file && root ? `${root.replace(/\/+$/, "")}/${file}` : null);
  // Split the way every other file row in the app splits it: the
  // directory greys out and truncates, the name never does.
  const parts = $derived(file ? splitPath(file) : null);
  const rows = $derived(diff ? toUnifiedRows(diff.hunks) : []);

  // Hunk expansion, exactly as RunChangesModal does it: reset per diff,
  // so a long hunk expanded on one file does not arrive expanded on the
  // next.
  let expanded = $state<Set<number>>(new Set());
  $effect(() => {
    void diff;
    expanded = new Set();
  });
  const isCollapsed = (h: number, n: number): boolean => n > LARGE_HUNK_LINES && !expanded.has(h);
  const expand = (h: number): void => {
    expanded = new Set([...expanded, h]);
  };

  // GitDiffUnified is built for the Git tab, where rows are selectable
  // and hunks are actionable. Here it is a reader: every action is a
  // no-op and `canAct` is false, which is the same posture
  // RunChangesModal takes.
  const noSelection = new Set<string>();
  const noop = (): void => {};
  const nullLabel = (): null => null;
</script>

<div class="file-pane">
  <div class="head">
    <span class="path" title={file ?? ""}>
      {#if parts}<span class="dir">{parts.dir}</span><span class="name">{parts.name}</span>
      {:else}No file selected{/if}
    </span>
    {#if file}
      <div class="modes" role="group" aria-label="How to show this file">
        <button type="button" class:active={mode === "diff"} onclick={() => (mode = "diff")}>
          Diff
        </button>
        <!-- Disabled only while the run's changes have not landed:
             until they do there is no repository root to resolve the
             root-relative path against, and Edit would have to guess
             which checkout the file is in. -->
        <button
          type="button"
          class:active={mode === "edit"}
          disabled={absolute === null}
          onclick={() => (mode = "edit")}
        >
          Edit
        </button>
      </div>
    {/if}
  </div>

  <div class="body">
    {#if !file}
      <div class="none">Select a file</div>
    {:else if mode === "edit"}
      {#if absolute}
        <!-- Keyed on the path: FileEditor reads its file in onMount and
             holds a buffer for it, so pointing it at another file has to
             rebuild it rather than update a prop. -->
        {#key absolute}
          <FileEditor path={absolute} initialMode="edit" />
        {/key}
      {:else}
        <div class="none">Gavin doesn't know where this run's repository is, so it can't open the file.</div>
      {/if}
    {:else if error}
      <div class="none error">{error}</div>
    {:else if loading && !diff}
      <div class="none">Loading…</div>
    {:else if !diff}
      <div class="none">—</div>
    {:else if diff.binary}
      <div class="none">Binary file — no text diff</div>
    {:else if diff.tooLarge}
      <div class="none">Diff too large (&gt; 2 MB)</div>
    {:else if diff.hunks.length === 0}
      <div class="none">No textual changes</div>
    {:else}
      <GitDiffUnified
        {rows}
        {isCollapsed}
        canAct={false}
        actionLabel=""
        onHunkAction={noop}
        onExpand={expand}
        selection={noSelection}
        onLineClick={noop}
        onDragRange={noop}
        selectedLabel={nullLabel}
        discardLabel={nullLabel}
        onHunkDiscard={noop}
      />
    {/if}
  </div>
</div>

<style>
  .file-pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 8px 6px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .path {
    display: flex;
    flex: 1;
    min-width: 0;
    font-size: 0.8em;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .dir {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name {
    flex: none;
    color: var(--text);
  }
  .modes {
    display: flex;
    flex: none;
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
  }
  .modes button {
    padding: 2px 10px;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 0.8em;
    cursor: pointer;
  }
  .modes button + button {
    border-left: 1px solid var(--border);
  }
  .modes button.active {
    background: var(--surface-selected);
    color: var(--text);
  }
  .modes button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .none {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 16px;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.85em;
  }
  .none.error {
    color: var(--danger-text);
  }
</style>
