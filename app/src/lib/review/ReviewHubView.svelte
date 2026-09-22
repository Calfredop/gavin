<script lang="ts">
  import { attributionKey, attributionStore, ownersOf } from "$lib/cards/changeAttributionState";
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
  import { fetchBoard, refreshBoard, kanbanState, cardSessionFor } from "$lib/board/kanbanState";
  import { gavinTrees } from "$lib/core/gavinState";
  import { layoutState, daemonCompat } from "$lib/core/layoutState";
  import { flattenCardViews, mergePlanCards, type CardView } from "$lib/core/planBoard";
  import GitFileRow from "$lib/git/GitFileRow.svelte";
  import ReviewAgentPane from "$lib/review/ReviewAgentPane.svelte";
  import ReviewCardList from "$lib/review/ReviewCardList.svelte";
  import ReviewFilePane from "$lib/review/ReviewFilePane.svelte";
  import {
    criticalReviewOffer,
    groupCandidates,
    isRailSubjectId,
    railCandidate,
    railSubjectId,
    resolveReviewColumns,
    resolveReviewSelection,
    reviewCards,
    reviewRails,
    reviewSummary,
    setAllGroupsExpanded,
    toggleExpandedGroup,
    withBaselinePeers,
    type ReviewCandidate,
    type ReviewRailCandidate,
  } from "$lib/review/reviewBoard";
  import {
    prefsFor,
    pruneReviewPrefsFor,
    reviewPrefs,
    setReviewPrefs,
    toggleReviewColumn,
  } from "$lib/review/reviewPrefs";
  import {
    clearReviewFile,
    loadTouchedFiles,
    railTouchRequest,
    reviewStore,
    selectReviewFile,
    type TouchRequest,
  } from "$lib/review/reviewState";
  import {
    requestCardCriticalReview,
    requestRailCriticalReview,
  } from "$lib/review/reviewCriticalReview";
  import {
    requestFindingsRail,
  } from "$lib/review/criticalReviewFindingsRailActions";
  import { criticalReviewRuns } from "$lib/review/criticalReviewState";
  import { runBaseline, type RunBaseline } from "$lib/cards/runChanges";
  import { orchestrations, fetchOrchestration } from "$lib/orchestration/orchestrationState";
  import { conflictCheckout } from "$lib/orchestration/orchestration";
  import { railIndex } from "$lib/board/planFilter";
  import { contextFacets, facetsEqual, pruneFacets } from "$lib/board/boardFilters";
  import { facetsFor, isTabLinked, hubFacetState, resetTabFacets, setTabFacets, setTabLinked } from "$lib/board/hubFacets";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  // The three fetches this tab would otherwise never make. All no-op
  // once loaded; the refresh on reveal is how a card filed in another
  // window reaches this list.
  $effect(() => {
    void fetchBoard(workspaceId);
  });
  $effect(() => {
    void refreshBoard(workspaceId);
  });
  $effect(() => {
    void fetchOrchestration(workspaceId);
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

  // The context/kind/rail trio Kanban and Plans answer the same way
  // (boardFilters.ts, shared across tabs by hubFacets.ts). Lives in
  // hubFacets.ts rather than component `$state` for the reason
  // ReviewCardList's own comment gives: the hub destroys this view on
  // every tab switch, and "shared with Kanban and Plans" cannot mean
  // that.
  const hub = $derived($hubFacetState[workspaceId]);
  const facets = $derived(facetsFor(hub, "review"));
  const facetsLinked = $derived(isTabLinked(hub, "review"));
  const orch = $derived($orchestrations[workspaceId]);
  const rails = $derived(railIndex(orch ?? null));
  const contexts = $derived(contextFacets(tree));

  // A facet whose option disappeared (the rail was deleted, the context
  // folder renamed) filters on a value the dropdown no longer offers --
  // reset it instead, the same rule the Kanban and Plans tabs follow.
  $effect(() => {
    const next = pruneFacets(
      facets,
      tree && !tree.rootMissing ? contexts : null,
      orch === undefined ? null : rails,
      board ? board.labels : null
    );
    if (!facetsEqual(next, facets)) {
      setTabFacets(workspaceId, "review", next);
    }
  });

  // Every card in the projection, for the detail panel the first column
  // can show. Deliberately NOT `listed`: the panel's Tasks list and its
  // "Part of" row name cards by path, and most of those are not up for
  // review -- a nested task has no status of its own, and a finished
  // card's parent plan may be anywhere. Handing it the filtered list
  // would draw a panel whose own links resolve to nothing.
  const allCards = $derived<CardView[]>(merged ? flattenCardViews(merged) : []);

  const listed = $derived<CardView[]>(
    merged
      ? reviewCards(merged, reviewColumns, {
          includeArchived: prefs.includeArchived,
          query: prefs.query,
          facets,
          rails,
        })
      : []
  );
  const archivedPaths = $derived(new Set((merged?.archived ?? []).map((c) => c.id)));

  // Rails as peers of the card list — same search/facet lens, no
  // Cards|Rails switcher. Position order from reviewRails.
  const listedRails = $derived(
    reviewRails(orch?.rails ?? [], { query: prefs.query, facets })
  );

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

  /// Step baseShas in rail step order — the fallback when no worktree
  /// fork point is known yet (railReviewBaseline).
  function stepBaseShasFor(rail: (typeof listedRails)[number]): (string | null)[] {
    return rail.stages.flatMap((stage) =>
      stage.steps.map((step) => {
        if (!step.cardPath) return null;
        return cardSessionFor(board, step.cardPath)?.baseSha ?? null;
      })
    );
  }

  // Card requests carry peer baselines; rail requests do not — a rail
  // subject is the whole checkout since its baseline, and mixing its
  // sha into withBaselinePeers would bound every card in that cwd.
  const cardRequests = $derived(
    withBaselinePeers(
      listed
        .map((card) => {
          const baseline = baselineFor(card);
          return baseline.kind === "ready"
            ? { path: card.id, title: card.title, cwd: baseline.cwd, baseSha: baseline.baseSha }
            : null;
        })
        .filter((r): r is { path: string; title: string; cwd: string; baseSha: string } => r !== null)
    )
  );
  const railRequests = $derived<TouchRequest[]>(
    listedRails
      .map((rail) => {
        const cwd = conflictCheckout(rail, tree);
        if (!cwd) return null;
        return railTouchRequest({
          railId: rail.id,
          cwd,
          worktreeForkPoint: null,
          stepBaseShas: stepBaseShasFor(rail),
        });
      })
      .filter((r): r is TouchRequest => r !== null)
  );
  const requests = $derived<TouchRequest[]>([...cardRequests, ...railRequests]);

  // What the list is ASKING FOR, reduced to a string. The effect below
  // depends on this rather than on `requests`, and that indirection is
  // load-bearing rather than tidy.
  //
  // `requests` is a fresh array on every emission of the board store,
  // and the board is refetched on every `.gavin*` tree push
  // (gavinState.ts) -- which is to say every time any agent in the fleet
  // writes a card file. A `$derived` array is never equal to its
  // predecessor, so the effect would re-enter on each of those; and
  // `loadTouchedFiles` ABANDONS the batch in flight whenever a new one
  // starts, throwing away up to FETCH_CONCURRENCY finished `git diff`s
  // each time. On a busy fleet the first load would restart faster than
  // it could finish and the list would sit on "reading…" forever.
  //
  // The key covers the baseline as well as the path, because that is
  // exactly what makes a cached answer stale (see `cached` in
  // reviewState.ts): a card re-launched onto a new sha has to be asked
  // again, and nothing else has to be.
  const requestKey = $derived(
    requests.map((r) => `${r.path}\u0000${r.cwd}\u0000${r.baseSha}\u0000${r.peers.join(",")}`).join("\n")
  );

  // Fetch whenever that set changes. Cached entries are skipped inside
  // the store as well, so flipping the archive toggle back costs
  // nothing.
  //
  // `untrack` around the call for the reason every other fetching effect
  // in the app uses it: the store this writes is one this component
  // reads, and without it the effect would re-run on its own result.
  $effect(() => {
    const id = workspaceId;
    void requestKey;
    untrack(() => void loadTouchedFiles(id, requests));
  });

  const view = $derived($reviewStore[workspaceId]);
  const loadingPaths = $derived(new Set(view?.loadingPaths ?? []));

  // The checkout is the run's repository ROOT when git resolved one, so
  // two cards launched at different depths of one tree still collide;
  // the launch cwd is the fallback for a run that never got that far.
  const candidates = $derived<ReviewCandidate[]>(
    listed.map((card) => {
      const run = view?.runs[card.id];
      return {
        card,
        files: run?.files ?? null,
        checkout: run ? (run.changes?.root ?? run.cwd) : null,
        baseSha: run?.baseSha ?? null,
        // Which card each file looks like, from TypeSafe change
        // attribution, under the same bound the files were measured
        // under. Undefined until it has answered, which the grouper reads
        // as today's answer: every file claimed.
        owners: ownersOf(
          run ? $attributionStore[attributionKey(card.id, run.baseSha, run.untilSha)] : undefined
        ),
      };
    })
  );
  const groups = $derived(groupCandidates(candidates));

  const railSubjects = $derived<ReviewRailCandidate[]>(
    listedRails.map((rail) => {
      const steps = stepBaseShasFor(rail);
      const subjectId = railSubjectId(rail.id);
      const run = view?.runs[subjectId];
      return railCandidate(rail, {
        files: run?.files ?? null,
        checkout: run ? (run.changes?.root ?? run.cwd) : null,
        baseSha: run?.baseSha ?? null,
        worktreeForkPoint: null,
        stepBaseShas: steps,
      });
    })
  );
  const summary = $derived(reviewSummary(groups, railSubjects));

  // The selection is re-resolved against the list on every change, never
  // merely remembered: the list moves under it when the query changes,
  // when the archive toggle flips, and when a card is filed elsewhere in
  // the app. A selection pointing at a card the list no longer holds
  // renders three empty columns beside a list with plenty in it.
  const selected = $derived(resolveReviewSelection(groups, railSubjects, prefs.selected));

  // ...and then written down, so the answer stops moving. Nothing about
  // `resolveSelection` is stable while the tab is loading: it falls back
  // to the first card of the first group, `groupCandidates` orders
  // groups by how many cards they hold, and that order changes with
  // every batch of touched files that lands. Left underived, the three
  // panes re-target — and the open diff is dropped — several times over
  // on first open, without the human touching anything.
  //
  // Terminates on its own: once stored, `resolveSelection` answers with
  // the stored path for as long as the list still holds it, so the
  // second pass writes nothing.
  $effect(() => {
    const path = selected;
    const stored = prefs.selected;
    if (path === null || path === stored) return;
    untrack(() => setReviewPrefs(workspaceId, { selected: path }));
  });

  const selectedRail = $derived(
    selected && isRailSubjectId(selected)
      ? (railSubjects.find((r) => r.id === selected) ?? null)
      : null
  );
  const card = $derived(
    selectedRail ? null : (listed.find((c) => c.id === selected) ?? null)
  );
  const binding = $derived(card ? (cardSessionFor(board, card.id) ?? null) : null);
  const run = $derived(selected ? (view?.runs[selected] ?? null) : null);
  // The selected card's baseline, kept as the union rather than reduced:
  // its `reason` is the sentence the middle column shows when there is
  // none, and writing a second one here would be a second answer to
  // "why can't gavin say what this card touched".
  const baseline = $derived(card ? baselineFor(card) : null);

  const criticalOffer = $derived(
    criticalReviewOffer(
      selected,
      railSubjects,
      listed.map((c) => c.id)
    )
  );
  let criticalError = $state<string | null>(null);
  // Critical-review runs still remembered for this workspace — the run
  // summary and the explicit "Build review rail from findings" entry.
  const critiqueRuns = $derived($criticalReviewRuns[workspaceId] ?? []);
  let findingsError = $state<string | null>(null);

  async function startCriticalReview(): Promise<void> {
    if (!criticalOffer) return;
    criticalError = null;
    if (criticalOffer.kind === "card") {
      const c = listed.find((x) => x.id === criticalOffer.cardPath);
      if (!c) return;
      const err = await requestCardCriticalReview(workspaceId, c);
      if (err) criticalError = err;
      return;
    }
    const rail = listedRails.find((r) => r.id === criticalOffer.railId);
    if (!rail) return;
    const rootPath = tree && !tree.rootMissing ? tree.rootPath : null;
    const err = await requestRailCriticalReview(
      workspaceId,
      { id: rail.id, name: rail.name, worktreePath: rail.worktreePath },
      {
        worktreeForkPoint: criticalOffer.worktreeForkPoint,
        stepBaseShas: criticalOffer.stepBaseShas,
        rootPath,
      }
    );
    if (err) criticalError = err;
  }

  function openFindingsRail(pageId: string): void {
    findingsError = null;
    const err = requestFindingsRail(workspaceId, pageId);
    if (err) findingsError = err;
  }

  // Changing card/rail drops the file: a diff belongs to the subject it
  // was read from, and leaving it up under another name would be somebody
  // else's work under this heading.
  let fileFor = $state<string | null>(null);
  $effect(() => {
    const path = selected;
    if (fileFor === path) return;
    fileFor = path;
    criticalError = null;
    findingsError = null;
    untrack(() => clearReviewFile(workspaceId));
  });

  // The tab drops the open diff on its way out: it is the one large
  // object it holds, and the touched-file cache it keeps is what makes
  // coming back free (reviewState.ts).
  onDestroy(() => clearReviewFile(workspaceId));

  // The three-column row, watched for the reason HomeHubView watches its
  // agent cell: TerminalPane fits on mount and on a font-size change and
  // at no other time, so a terminal whose column got wider keeps the rows
  // and columns it was born with, and the agent goes on wrapping its
  // output to a width that is no longer there. The row is the right thing
  // to observe because every track in it is a fraction of the row -- and
  // it moves without the window moving at all: collapsing the card list
  // hands it that list's 280px.
  let colsEl = $state<HTMLElement | null>(null);
  let agentPane = $state<{ fit: () => void } | null>(null);
  onMount(() => {
    if (!colsEl) return;
    const observer = new ResizeObserver(() => agentPane?.fit());
    observer.observe(colsEl);
    return () => observer.disconnect();
  });

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
    railSubjects={railSubjects}
    {selected}
    collapsed={prefs.listCollapsed}
    query={prefs.query}
    includeArchived={prefs.includeArchived}
    {columns}
    {reviewColumnIds}
    loading={loadingPaths.size > 0}
    {loadingPaths}
    {archivedPaths}
    expandedGroups={prefs.expandedGroups}
    {facets}
    {contexts}
    {rails}
    labels={board?.labels ?? []}
    linked={facetsLinked}
    onSelect={select}
    onQuery={(next) => setReviewPrefs(workspaceId, { query: next })}
    onToggleArchived={() => setReviewPrefs(workspaceId, { includeArchived: !prefs.includeArchived })}
    onFacets={(next) => setTabFacets(workspaceId, "review", next)}
    onToggleLink={() => setTabLinked(workspaceId, "review", !facetsLinked)}
    onResetFilters={() => {
      setReviewPrefs(workspaceId, { query: "" });
      resetTabFacets(workspaceId, "review");
    }}
    onToggleColumn={(id) =>
      setReviewPrefs(workspaceId, {
        columns: toggleReviewColumn(prefs.columns, reviewColumnIds, id),
      })}
    onToggleCollapsed={() => setReviewPrefs(workspaceId, { listCollapsed: !prefs.listCollapsed })}
    onToggleGroup={(id) =>
      setReviewPrefs(workspaceId, {
        expandedGroups: toggleExpandedGroup(prefs.expandedGroups, id),
      })}
    onSetAllGroups={(open) =>
      setReviewPrefs(workspaceId, {
        expandedGroups: setAllGroupsExpanded(groups, prefs.expandedGroups, open),
      })}
    onRefresh={() => void loadTouchedFiles(workspaceId, requests, { force: true })}
  />

  <div class="panes">
    <div class="strip">
      <span class="title"
        >{selectedRail?.name ?? card?.title ?? "Nothing selected"}</span
      >
      {#if summary}<span class="summary">{summary}</span>{/if}
      {#if criticalOffer}
        <button type="button" class="critical" onclick={() => void startCriticalReview()}>
          Critical review…
        </button>
      {/if}
      {#if criticalError}<span class="critical-error">{criticalError}</span>{/if}
    </div>
    {#if critiqueRuns.length > 0}
      <div class="run-summary" aria-label="Critical review runs">
        {#each critiqueRuns as run (run.pageId)}
          <div class="run">
            <span class="run-label">
              Critical review: {run.subjectLabel}
              <span class="run-meta">{run.sessionIds.length} reviewers</span>
            </span>
            <button type="button" class="critical" onclick={() => openFindingsRail(run.pageId)}>
              Build review rail from findings…
            </button>
          </div>
        {/each}
        {#if findingsError}<span class="critical-error">{findingsError}</span>{/if}
      </div>
    {/if}
    <div class="cols" bind:this={colsEl}>
      <ReviewAgentPane
        bind:this={agentPane}
        {workspaceId}
        {card}
        rail={selectedRail}
        {binding}
        pane={prefs.pane}
        onPane={(next) => setReviewPrefs(workspaceId, { pane: next })}
        {columns}
        labels={board?.labels ?? []}
        {allCards}
        onOpenCard={select}
        onPathChange={select}
      />

      <div class="files">
        <div class="head"><span class="label">Touched files</span></div>
        <div
          class="file-list"
          role="listbox"
          aria-label={selectedRail
            ? "Files this rail's checkout touched"
            : "Files this card's run touched"}
        >
          {#if !card && !selectedRail}
            <div class="none">Select a card or rail</div>
          {:else if selected && loadingPaths.has(selected)}
            <div class="none">Reading the checkout…</div>
          {:else if run?.error}
            <div class="none error">{run.error}</div>
          {:else if run?.problem}
            <!-- A sentence, not an empty list: see reviewBoard.ts. -->
            <div class="none">{run.problem}</div>
          {:else if card && baseline?.kind === "none"}
            <div class="none">{baseline.reason}</div>
          {:else if selectedRail && !run}
            <div class="none">
              Gavin didn't record where this rail's work started, so it can't say what it touched.
            </div>
          {:else if !run}
            <div class="none">Reading the checkout…</div>
          {:else if run.files && run.files.length === 0}
            <div class="none">
              {selectedRail
                ? "This rail changed nothing in the checkout."
                : "This run changed nothing in the checkout."}
            </div>
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
    /* The tab's own text colour, and the reason it has to be said at
       all: nothing in the app sets a root one. theme.css defines the
       tokens and two base rules and stops, and no stylesheet declares
       `color-scheme`, so an element with no `color` inherits the user
       agent's black -- which on this ground is a card title at 1.1:1.
       Every other component pays for that by naming its own (BoardCard
       sets `color: var(--text)` on `.card` for exactly this reason);
       four rules in this tab did not, and the card list rendered
       invisible. Said once here so the panes below inherit it, and
       again on each pane's own root so none of them depends on being
       mounted inside this one.

       Both header rows are pinned rather than left to their content:
       the tab has two of them, drawn twice each -- the card list's
       search row beside the strip, its column picker beside the three
       column heads -- and a few pixels of difference between the halves
       puts two rules across the window at two heights. Measured in
       WKWebView (root font-size 13px): the heads came to 20px, 20px,
       26px with the diff/edit group in them, and 23px, so the rules
       landed at three different y. The first row now reads
       --hub-bar-height, the same band as the Scratchpad and Kanban.
       28px is still what the 19px switch needs in the column heads,
       with 4px above and below it -- and `padding-top: 0`, which every
       head had, is what glued that switch to the top border.
       reviewTabStyles.test.ts holds all four to these. */
    color: var(--text);
    --review-strip-height: var(--hub-bar-height);
    --review-head-height: 28px;
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
    align-items: center;
    gap: 10px;
    height: var(--review-strip-height);
    box-sizing: border-box;
    padding: 0 10px;
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
  .critical {
    margin-left: auto;
    flex: none;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--text);
    font-size: 0.78em;
    cursor: pointer;
  }
  .critical:hover {
    background: var(--surface-hover, rgba(255, 255, 255, 0.04));
  }
  .critical-error {
    flex: none;
    font-size: 0.78em;
    color: var(--danger, #e57373);
  }
  .run-summary {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    flex: none;
    background: var(--surface-overlay, transparent);
  }
  .run-summary .run {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .run-summary .run-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.78em;
    color: var(--text-muted);
  }
  .run-summary .run-meta {
    color: var(--text-subtle);
  }
  .run-summary .critical {
    margin-left: auto;
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
    display: flex;
    align-items: center;
    height: var(--review-head-height);
    box-sizing: border-box;
    padding: 0 8px;
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
