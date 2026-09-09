<script lang="ts">
  import { onDestroy } from "svelte";
  import Modal from "$lib/Modal.svelte";
  import GitFileRow from "$lib/GitFileRow.svelte";
  import GitDiffUnified from "$lib/GitDiffUnified.svelte";
  import { toUnifiedRows } from "$lib/diffRows";
  import { LARGE_HUNK_LINES, shortSha } from "$lib/git";
  import {
    changesProblem,
    changesSummary,
    discardBlockedReason,
    discardOutcome,
    discardPrompt,
  } from "$lib/runChanges";
  import {
    closeRunChanges,
    discardRun,
    openRunChanges,
    refreshRunChanges,
    runChangesStore,
    selectRunFile,
  } from "$lib/runChangesState";
  import { askConfirm } from "$lib/dialog";
  import { tooltip } from "$lib/tooltip";

  interface Props {
    /// The card whose run this is. Also the store key: one view per card,
    /// because one card has one live run.
    path: string;
    title: string;
    cwd: string;
    baseSha: string;
    /// Whether the run's agent is alive right now. A discard under a
    /// working agent is refused rather than confirmed.
    sessionIsLive: boolean;
    /// Draw as a pane rather than as a dialog -- see Modal's own prop.
    /// The tab chip splits this view off beside the agent it belongs to,
    /// which is the whole reason it is not a modal there.
    inline?: boolean;
    onClose: () => void;
  }
  let { path, title, cwd, baseSha, sessionIsLive, inline = false, onClose }: Props = $props();

  // Re-runs when the card or the run changes, which is what re-points an
  // already-open modal (a re-launch mints a new baseline).
  $effect(() => {
    void openRunChanges(path, cwd, baseSha);
  });

  const view = $derived($runChangesStore[path] ?? null);
  const changes = $derived(view?.changes ?? null);
  const summary = $derived(changesSummary(changes));
  const problem = $derived(changesProblem(changes));
  const blocked = $derived(discardBlockedReason(changes, sessionIsLive));
  const diff = $derived(view?.diff ?? null);
  const rows = $derived(diff ? toUnifiedRows(diff.hunks) : []);
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

  let outcome = $state<string | null>(null);

  function close(): void {
    closeRunChanges(path);
    onClose();
  }

  // As a PANE this view is closed from the tab bar's X, which unmounts it
  // without ever reaching close() -- and the cached diff is the largest
  // object the app keeps per card (see closeRunChanges). Harmless for the
  // modal, whose own close() has already dropped the entry.
  onDestroy(() => closeRunChanges(path));

  async function handleDiscard(): Promise<void> {
    if (!changes || blocked) return;
    const prompt = discardPrompt(changes, title);
    const confirmed = await askConfirm({
      title: prompt.title,
      lines: prompt.lines,
      confirmLabel: prompt.confirmLabel,
      danger: true,
    });
    if (!confirmed) return;
    const result = await discardRun(path);
    outcome = "error" in result ? result.error : discardOutcome(result.report);
  }
</script>

<Modal onClose={close} scrollKey={path} wide innerScroll {inline}>
  <div class="run-changes" class:inline>
    <div class="head">
      <div class="titles">
        <h2>{title}</h2>
        <p class="baseline">
          Since <span class="sha">{shortSha(baseSha)}</span>{#if changes?.baseSubject}
            · {changes.baseSubject}{/if}
        </p>
        <p class="where">{cwd}</p>
      </div>
      <div class="head-actions">
        {#if summary}<span class="summary">{summary}</span>{/if}
        <button type="button" onclick={() => void refreshRunChanges(path)} disabled={view?.loading}>
          Refresh
        </button>
        <!-- The reason lives on a non-disabled ancestor: a disabled
             element never fires mouseenter, so a tooltip bound to one
             can never appear. -->
        <span use:tooltip={blocked ?? undefined}>
          <button type="button" class="danger" disabled={blocked !== null || view?.busy} onclick={() => void handleDiscard()}>
            Discard this run…
          </button>
        </span>
      </div>
    </div>

    {#if view?.error}<p class="strip error">{view.error}</p>{/if}
    {#if outcome}<p class="strip error">{outcome}</p>{/if}
    {#if problem}<p class="strip quiet">{problem}</p>{/if}

    <div class="body">
      <div class="files" role="listbox" aria-label="Files this run changed">
        {#if view?.loading && !changes}
          <div class="none">Reading the checkout…</div>
        {:else if !changes || problem}
          <div class="none">—</div>
        {:else if changes.files.length === 0}
          <div class="none">
            {changes.commits > 0
              ? "Committed and left a clean tree — pick a commit in the Git tab to read it."
              : "Nothing yet"}
          </div>
        {:else}
          {#each changes.files as entry (entry.path)}
            <GitFileRow
              {entry}
              area="unstaged"
              selected={view?.selected === entry.path}
              disabled={true}
              readonly={true}
              onSelect={() => void selectRunFile(path, entry.path)}
              onToggle={noop}
            />
          {/each}
        {/if}
      </div>
      <div class="diff">
        {#if !view?.selected}
          <div class="none">Select a file</div>
        {:else if view.diffLoading && !diff}
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
  </div>
</Modal>

<style>
  .run-changes {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: min(70vh, 720px);
    width: min(88vw, 980px);
  }
  /* As a pane the size is the pane's, not the window's: a fixed 980px
     inside a half-width split would simply overflow it, and 70vh would
     ignore the pane's own height in both directions. */
  .run-changes.inline {
    height: 100%;
    width: 100%;
  }
  .head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }
  .titles {
    min-width: 0;
    flex: 1;
  }
  h2 {
    margin: 0;
    font-size: 1.05em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .baseline,
  .where {
    margin: 2px 0 0;
    font-size: 0.78em;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sha {
    font-family: monospace;
    color: var(--warning-text);
  }
  .head-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }
  .summary {
    font-size: 0.8em;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .strip {
    margin: 8px 0 0;
    font-size: 0.82em;
  }
  .strip.error {
    color: var(--danger-text);
  }
  .strip.quiet {
    color: var(--text-muted);
  }
  .body {
    display: flex;
    min-height: 0;
    flex: 1;
    margin-top: 10px;
    gap: 10px;
  }
  .files {
    width: 260px;
    flex: none;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-sunken);
  }
  .diff {
    flex: 1;
    min-width: 0;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-sunken);
    font-family: monospace;
  }
  .none {
    padding: 10px;
    font-size: 0.82em;
    color: var(--text-muted);
  }
  button.danger {
    color: var(--danger-text);
  }
</style>
