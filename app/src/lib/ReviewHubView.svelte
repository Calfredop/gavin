<script lang="ts">
  // The Review tab: finished work, read beside the agent that produced
  // it.
  //
  // The board answers "what is being worked on"; this answers the
  // question that comes after it — what did this piece of work actually
  // do to the checkout, and is it right. Those are different shapes: a
  // column is ordered by when work started, and the cards a reviewer
  // needs to read TOGETHER are the ones that wrote to the same files.
  // So the list is clustered by touched files (reviewBoard.ts) and the
  // three columns beside it are all about one card: its agent, the files
  // its run touched, and one of those files.
  //
  // Thin, like every other hub view: the policy is in reviewBoard.ts,
  // the fetching in reviewState.ts, the remembering in reviewPrefs.ts.
  import { onDestroy, onMount, untrack } from "svelte";
  import { get } from "svelte/store";
  import { fetchBoard, refreshBoard, kanbanState, cardSessionFor } from "./kanbanState";
  import { gavinTrees } from "./gavinState";
  import { layoutState, daemonCompat } from "./layoutState";
  import { mergePlanCards, type CardView } from "./planBoard";
  import GitFileRow from "./GitFileRow.svelte";
  import ReviewAgentPane from "./ReviewAgentPane.svelte";
  import ReviewCardList from "./ReviewCardList.svelte";
  import ReviewFilePane from "./ReviewFilePane.svelte";
  import {
    groupCandidates,
    resolveReviewColumns,
    resolveSelection,
    reviewCards,
    reviewSummary,
    type ReviewCandidate,
  } from "./reviewBoard";
  import {
    prefsFor,
    pruneReviewPrefsFor,
    reviewPrefs,
    setReviewPrefs,
    toggleReviewColumn,
  } from "./reviewPrefs";
  import {
    clearReviewFile,
    loadTouchedFiles,
    reviewStore,
    selectReviewFile,
    type TouchRequest,
  } from "./reviewState";
  import { runBaseline, type RunBaseline } from "./runChanges";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  // The two fetches this tab would otherwise never make. Both no-op once
  // loaded; the refresh on reveal is how a card filed in another window
  // reaches this list.
  $effect(() => {
    void fetchBoard(workspaceId);
  });
  $effect(() => {
    void refreshBoard(workspaceId);
  });

  // Records for workspaces that are gone, dropped once per mount. The
  // ids are uuids, so an entry for a removed workspace can never match
  // anything again and would otherwise grow for the life of the install.
  // Here rather than inside the writer, so reviewPrefs.ts stays free of
  // layoutState -- the tab is the only thing that ever writes the record
  // and it already holds the workspace list.
  onMount(() => {
    pruneReviewPrefsFor(get(layoutState).workspaces.map((w) => w.id));
  });

  const board = $derived($kanbanState[workspaceId]);
  const tree = $derived($gavinTrees[workspaceId]);
  const merged = $derived(board ? mergePlanCards(board, tree) : null);
  const prefs = $derived($reviewPrefs[workspaceId] ?? prefsFor(workspaceId));

  const columns = $derived(board?.columns ?? []);
  const reviewColumns = $derived(resolveReviewColumns(columns, prefs.columns));
  const reviewColumnIds = $derived(reviewColumns.map((c) => c.id));

  const listed = $derived<CardView[]>(
    merged
      ? reviewCards(merged, reviewColumns, {
          includeArchived: prefs.includeArchived,
          query: prefs.query,
        })
      : []
  );
  const archivedPaths = $derived(new Set((merged?.archived ?? []).map((c) => c.id)));

  // A card's baseline: its binding's, through the same resolver the
  // Changes view uses -- so "no baseline" is spelled once and means the
  // same thing on both surfaces.
  //
  // The BINDING and not the run history. The history would give a
  // baseline for a card whose binding was replaced, but reading it costs
  // a daemon request per card and a transcript read behind it; this list
  // is forty cards wide. A card with no binding is reported as
  // unmeasured, which is exactly what it is.
  function baselineFor(card: CardView): RunBaseline {
    return runBaseline(cardSessionFor(board, card.id), $daemonCompat);
  }

  const requests = $derived<TouchRequest[]>(
    listed
      .map((card) => {
        const baseline = baselineFor(card);
        return baseline.kind === "ready"
          ? { path: card.id, cwd: baseline.cwd, baseSha: baseline.baseSha }
          : null;
      })
      .filter((r): r is TouchRequest => r !== null)
  );

  // Fetch whenever the list changes. Cached entries are skipped inside
  // the store, so typing in the search box costs nothing.
  //
  // `untrack` around the call for the reason every other fetching effect
  // in the app uses it: the store this writes is one this component
  // reads, and without it the effect would re-run on its own result.
  $effect(() => {
    const next = requests;
    untrack(() => void loadTouchedFiles(workspaceId, next));
  });

  const view = $derived($reviewStore[workspaceId]);
  const loadingPaths = $derived(new Set(view?.loadingPaths ?? []));

  const candidates = $derived<ReviewCandidate[]>(
    listed.map((card) => ({ card, files: view?.runs[card.id]?.files ?? null }))
  );
  const groups = $derived(groupCandidates(candidates));
  const summary = $derived(reviewSummary(groups));

  // The selection is re-resolved against the list on every change, never
  // merely remembered: the list moves under it when the query changes,
  // when the archive toggle flips, and when a card is filed elsewhere in
  // the app. A selection pointing at a card the list no longer holds
  // renders three empty columns beside a list with plenty in it.
  const selected = $derived(resolveSelection(groups, prefs.selected));
  const card = $derived(listed.find((c) => c.id === selected) ?? null);
  const binding = $derived(card ? (cardSessionFor(board, card.id) ?? null) : null);
  const run = $derived(selected ? (view?.runs[selected] ?? null) : null);
  // The selected card's baseline, kept as the union rather than reduced:
  // its `reason` is the sentence the middle column shows when there is
  // none, and writing a second one here would be a second answer to
  // "why can't gavin say what this card touched".
  const baseline = $derived(card ? baselineFor(card) : null);

  // Changing card drops the file: a diff belongs to the card it was read
  // from, and leaving it up under another card's name would be somebody
  // else's work under this heading.
  let fileFor = $state<string | null>(null);
  $effect(() => {
    const path = selected;
    if (fileFor === path) return;
    fileFor = path;
    untrack(() => clearReviewFile(workspaceId));
  });

  // The tab drops the open diff on its way out: it is the one large
  // object it holds, and the touched-file cache it keeps is what makes
  // coming back free (reviewState.ts).
  onDestroy(() => clearReviewFile(workspaceId));

  function select(path: string): void {
    setReviewPrefs(workspaceId, { selected: path });
  }
  function pickFile(file: string): void {
    if (run) void selectReviewFile(workspaceId, run, file);
  }
  const noop = (): void => {};
</script>

<div class="review" class:collapsed={prefs.listCollapsed}>
  <ReviewCardList
    {groups}
    {selected}
    collapsed={prefs.listCollapsed}
    query={prefs.query}
    includeArchived={prefs.includeArchived}
    {columns}
    {reviewColumnIds}
    loading={loadingPaths.size > 0}
    {loadingPaths}
    {archivedPaths}
    onSelect={select}
    onQuery={(next) => setReviewPrefs(workspaceId, { query: next })}
    onToggleArchived={() => setReviewPrefs(workspaceId, { includeArchived: !prefs.includeArchived })}
    onToggleColumn={(id) =>
      setReviewPrefs(workspaceId, {
        columns: toggleReviewColumn(prefs.columns, reviewColumnIds, id),
      })}
    onToggleCollapsed={() => setReviewPrefs(workspaceId, { listCollapsed: !prefs.listCollapsed })}
    onRefresh={() => void loadTouchedFiles(workspaceId, requests, { force: true })}
  />

  <div class="panes">
    <div class="strip">
      <span class="title">{card?.title ?? "Nothing selected"}</span>
      {#if summary}<span class="summary">{summary}</span>{/if}
    </div>
    <div class="cols">
      <ReviewAgentPane {workspaceId} {card} {binding} />

      <div class="files">
        <div class="head"><span class="label">Touched files</span></div>
        <div class="file-list" role="listbox" aria-label="Files this card's run touched">
          {#if !card}
            <div class="none">Select a card</div>
          {:else if loadingPaths.has(card.id)}
            <div class="none">Reading the checkout…</div>
          {:else if run?.error}
            <div class="none error">{run.error}</div>
          {:else if run?.problem}
            <!-- A sentence, not an empty list: see reviewBoard.ts. -->
            <div class="none">{run.problem}</div>
          {:else if baseline?.kind === "none"}
            <div class="none">{baseline.reason}</div>
          {:else if !run}
            <div class="none">Reading the checkout…</div>
          {:else if run.files && run.files.length === 0}
            <div class="none">This run changed nothing in the checkout.</div>
          {:else if run.changes}
            {#each run.changes.files as entry (entry.path)}
              <GitFileRow
                {entry}
                area="unstaged"
                selected={view?.selectedFile === entry.path}
                disabled={true}
                readonly={true}
                onSelect={() => pickFile(entry.path)}
                onToggle={noop}
              />
            {/each}
          {/if}
        </div>
      </div>

      <ReviewFilePane
        file={view?.selectedFile ?? null}
        root={run?.changes?.root ?? null}
        diff={view?.diff ?? null}
        loading={view?.diffLoading ?? false}
        error={view?.diffError ?? null}
      />
    </div>
  </div>
</div>

<style>
  /* The row track is pinned rather than left implicit: WKWebView sizes
     an `auto` row to its content and lets it overflow the grid, so a
     long card list would push the whole tab past the window instead of
     scrolling inside its own column. */
  .review {
    display: grid;
    grid-template-columns: 280px minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    height: 100%;
    min-height: 0;
  }
  /* The rail is as narrow as the one button it holds. A collapsed list
     that kept its 280px would be a column of nothing. */
  .review.collapsed {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .panes {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .strip {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 4px 10px 8px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .summary {
    flex: none;
    font-size: 0.78em;
    color: var(--text-muted);
  }
  /* A grid, not three flex children: the middle column is a file list
     with a natural width and the outer two are elastic, and only a
     `minmax(0, …)` track keeps a long diff line from widening the whole
     row instead of scrolling inside it. */
  .cols {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 260px) minmax(0, 1.4fr);
    grid-template-rows: minmax(0, 1fr);
  }
  .cols > :global(*) {
    min-width: 0;
    border-left: 1px solid var(--border);
  }
  .cols > :global(*:first-child) {
    border-left: none;
  }
  .files {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .head {
    padding: 0 8px 6px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .label {
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .file-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .none {
    padding: 16px 12px;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.82em;
  }
  .none.error {
    color: var(--danger-text);
  }
</style>
