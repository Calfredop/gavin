<script lang="ts">
  import { onDestroy } from "svelte";
  import Modal from "$lib/core/Modal.svelte";
  import GitFileRow from "$lib/git/GitFileRow.svelte";
  import GitDiffUnified from "$lib/git/GitDiffUnified.svelte";
  import { toUnifiedRows } from "$lib/git/diffRows";
  import { LARGE_HUNK_LINES, shortSha } from "$lib/git/git";
  import {
    changesProblem,
    changesSummary,
    checkoutSourceStrip,
    discardBlockedReason,
    discardOutcome,
    discardPrompt,
    EMPTY_AFTER_NARROW,
  } from "$lib/cards/runChanges";
  import {
    closeRunChanges,
    discardRun,
    openRunChanges,
    refreshRunChanges,
    runChangesStore,
    selectRunFile,
  } from "$lib/cards/runChangesState";
  import { foreignFiles, foreignLine } from "$lib/cards/changeAttribution";
  import { attributionKey, attributionStore } from "$lib/cards/changeAttributionState";
  import { askConfirm } from "$lib/core/dialog";
  import { tooltip } from "$lib/core/tooltip";
  import { DEFAULT_LIST_SHARE, listShareFromWidth, loadListShare, saveListShare } from "$lib/cards/runChangesSplit";

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
    /// Workspace + conversation for the transcript narrow. Absent when
    /// the binding has no conversation id (or the transcript is out of
    /// reach); the view then keeps the checkout list and the honest strip.
    workspaceId?: string | null;
    conversationId?: string | null;
    /// Draw as a pane rather than as a dialog -- see Modal's own prop.
    /// The tab chip splits this view off beside the agent it belongs to,
    /// which is the whole reason it is not a modal there.
    inline?: boolean;
    onClose: () => void;
  }
  let {
    path,
    title,
    cwd,
    baseSha,
    sessionIsLive,
    workspaceId = null,
    conversationId = null,
    inline = false,
    onClose,
  }: Props = $props();

  // Re-runs when the card or the run changes, which is what re-points an
  // already-open modal (a re-launch mints a new baseline).
  $effect(() => {
    void openRunChanges(path, cwd, baseSha, title, workspaceId, conversationId);
  });

  const view = $derived($runChangesStore[path] ?? null);
  const changes = $derived(view?.changes ?? null);
  const source = $derived(view?.source ?? "checkout");
  // What TypeSafe change attribution says about this run's files, when
  // its switch is on and there was a question to ask. Keyed by the
  // unbounded window this view shows (`untilSha` null); the Review tab's
  // bounded answer for the same card is a different entry. A hint and
  // never a filter: it adds a chip, a count and a line to the prompt,
  // and the list, the diff and the discard read none of it.
  // Skipped when the transcript already narrowed the list: those files
  // are this agent's, and a guess must not hand one to a neighbour.
  const attribution = $derived(
    source === "transcript" ? null : ($attributionStore[attributionKey(path, baseSha, null)] ?? null)
  );
  const readings = $derived(attribution && attribution.state !== "skipped" ? attribution.attribution : null);
  const foreign = $derived(foreignFiles(readings, path));
  const foreignCount = $derived(foreign.reduce((n, g) => n + g.paths.length, 0));
  const ownerTitleByPath = $derived(
    new Map(foreign.flatMap((g) => g.paths.map((p) => [p, g.title] as const)))
  );
  const summary = $derived(changesSummary(changes, foreignCount));
  const problem = $derived(changesProblem(changes));
  const blocked = $derived(discardBlockedReason(changes, sessionIsLive));
  const sourceStrip = $derived(checkoutSourceStrip(source));
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

  // The list/diff divider, as the list's share of the pair (see
  // runChangesSplit.ts). Window-level listeners with a buttons===0
  // bail-out, like the Git tab's splitters: WKWebView drops pointerup
  // when the pointerdown target leaves the DOM, and the rows beside this
  // one are replaced on every refresh.
  let listShare = $state(loadListShare());
  function startResize(e: PointerEvent): void {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement | null;
    const list = el?.previousElementSibling as HTMLElement | null;
    const detail = el?.nextElementSibling as HTMLElement | null;
    if (!list || !detail) return;
    const startX = e.clientX;
    const startW = list.offsetWidth;
    const total = startW + detail.offsetWidth;
    const startShare = listShare;
    const move = (ev: PointerEvent): void => {
      if (ev.buttons === 0) {
        up();
        return;
      }
      listShare = listShareFromWidth(startW + ev.clientX - startX, total);
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      // A click that never moved writes nothing, which keeps the two
      // clicks of a double-click from racing the reset below.
      if (listShare !== startShare) saveListShare(listShare);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }
  function resetSplit(): void {
    listShare = DEFAULT_LIST_SHARE;
    saveListShare(null);
  }

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
    const prompt = discardPrompt(changes, title, foreign.map(foreignLine), source === "transcript");
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
    {#if sourceStrip && changes && !problem}<p class="strip quiet">{sourceStrip}</p>{/if}

    <div class="body">
      <div class="files" role="listbox" aria-label="Files this run changed" style:flex-grow={listShare}>
        {#if view?.loading && !changes}
          <div class="none">Reading the checkout…</div>
        {:else if !changes || problem}
          <div class="none">—</div>
        {:else if changes.files.length === 0}
          <div class="none">
            {source === "transcript"
              ? EMPTY_AFTER_NARROW
              : changes.commits > 0
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
              note={ownerTitleByPath.get(entry.path) ?? null}
              onSelect={() => void selectRunFile(path, entry.path)}
              onToggle={noop}
            />
          {/each}
        {/if}
      </div>
      <div
        class="vsplit"
        role="separator"
        aria-orientation="vertical"
        use:tooltip={"Drag to resize \u00b7 double-click to reset"}
        onpointerdown={startResize}
        ondblclick={resetSplit}
      ></div>
      <div class="diff" style:flex-grow={1 - listShare}>
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
  }
  /* Both sides grow by their share from a zero basis, so the split holds
     at any width and neither side's content can push the other. */
  .files {
    flex: 0 1 0;
    min-width: 0;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-sunken);
  }
  /* The 10px gap the two boxes always had, now the handle that moves it;
     the line down its middle shows on hover. */
  .vsplit {
    flex: 0 0 10px;
    cursor: col-resize;
    position: relative;
  }
  .vsplit::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 4px;
    width: 2px;
    border-radius: 1px;
  }
  .vsplit:hover::after {
    background: var(--surface-selected);
  }
  .diff {
    flex: 0 1 0;
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
