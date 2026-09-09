<script lang="ts">
  import { pickPath } from "./picker";
  import { daemonCompat, layoutState, openFileInSplit, switchWorkspaceView } from "./layoutState";
  import { gavinTrees, refreshGavinTree } from "./gavinState";
  import type { GavinTree } from "./gavin";
  import { fetchBoard, kanbanState } from "./kanbanState";
  import {
    buildExplorerTree,
    followRenamedPath,
    isUnderRoot,
    loadExplorerSelection,
    newFilePath,
    requestedExplorerFile,
    saveExplorerSelection,
    slugFileName,
    type ExplorerContextNode,
    type ExplorerFile,
    type ExplorerSelection,
    type CreatableGroup,
  } from "./planExplorer";
  import { mergePlanCards, type CardView } from "./planBoard";
  import { NEW_CARD_STATUS } from "./cardCompose";
  import { placeCardAtColumnEnd } from "./planDrop";
  import { deletionPlanFor, executeDeletion, type DeletionPlan } from "./cardDelete";
  import { grantForAnsweredPrompt } from "./confirmGate";
  import { executeUnarchive } from "./archiveActions";
  import { featureBlockedReason } from "./daemonCompat";
  import { defaultMode } from "./fileEditing";
  import PlanTree from "./PlanTree.svelte";
  import FileEditor from "./FileEditor.svelte";
  import PlanMetadataPanel from "./PlanMetadataPanel.svelte";
  import ConfirmPrompt from "./ConfirmPrompt.svelte";
  import FormatHelpModal from "./FormatHelpModal.svelte";
  import SearchInput from "./ui/SearchInput.svelte";
  import { orchestrations, fetchOrchestration } from "./orchestrationState";
  import { ANY, filterExplorer, railIndex, statusFacets } from "./planFilter";
  import { contextFacets, pruneFacets } from "./boardFilters";
  import { facetsFor, isTabLinked, hubFacetState, resetTabFacets, setTabFacets, setTabLinked } from "./hubFacets";
  import FacetFilters from "./FacetFilters.svelte";
  import * as backend from "./backend";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  // The file on the right and the mode its editor holds it in (see
  // ExplorerSelection). Everything below still reasons about the path;
  // the mode rides along so the editor, keyed on the path, is created
  // in the right one.
  let selection = $state<ExplorerSelection | null>(null);
  const selectedPath = $derived(selection?.path ?? null);

  // A file picked from the tree opens the way a file tab does: rendered
  // when it can be, ready to read. Only a deep link asks for more.
  function select(path: string): void {
    selection = { path, mode: defaultMode(path, "tab") };
  }

  // `+page.svelte` renders one hub view at a time and destroys it on
  // every tab switch, so the selection would otherwise start over on
  // each visit. It is remembered per workspace instead (planExplorer.ts)
  // -- and re-read when the workspace prop changes, because this
  // instance survives a switch between two workspaces both parked on
  // their Plans tab.
  //
  // A restored path is provisional until the tree can vouch for it. A
  // card filed to Done while the tab was away has MOVED, and greeting
  // the human with "this file no longer exists" for a move they made
  // themselves is noise -- where the same notice for a file deleted
  // under their eyes is news. Plain `let`s: both are read inside the
  // effects that write them.
  let selectionWorkspace: string | null = null;
  let restoreUnverified = false;
  $effect(() => {
    if (selectionWorkspace === workspaceId) return;
    selectionWorkspace = workspaceId;
    const remembered = loadExplorerSelection(workspaceId);
    restoreUnverified = remembered !== null;
    selection = remembered;
  });

  // Deep link from a card's detail modal or menu ("Open in card
  // editor"). Declared after the restore so it wins on a mount where
  // both have something to say.
  $effect(() => {
    const requested = $requestedExplorerFile;
    if (requested) {
      selection = requested;
      restoreUnverified = false;
      requestedExplorerFile.set(null);
    }
  });
  let error = $state<string | null>(null);
  let editor = $state<{ flush: () => Promise<void> } | null>(null);

  const root = $derived($layoutState.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? null);
  const tree = $derived($gavinTrees[workspaceId]);
  const allContexts = $derived(buildExplorerTree(tree));

  const allPaths = $derived(
    new Set(
      allContexts.flatMap((c) =>
        c.groups.flatMap((g) => [...g.files, ...g.archived].map((f) => f.path))
      )
    )
  );
  // Selection is held by PATH because the tree rebuilds on every watcher
  // push; a file deleted in a terminal must say so rather than leave a
  // stale buffer on screen. Not while the tree is still unknown, though
  // (a fresh launch parked on this tab): an unloaded tree lists nothing,
  // and "vanished" would be the wrong word for "not looked yet".
  const treeKnown = $derived($gavinTrees[workspaceId] !== undefined);
  const selectionVanished = $derived(selectedPath !== null && treeKnown && !allPaths.has(selectedPath));

  // The restore's verification (see above): the first tree that can
  // answer decides whether the remembered file is still there. The
  // reactive reads come first, unconditionally, so the effect stays
  // subscribed through the runs where there is nothing to verify --
  // otherwise a workspace switch that arms a new restore would find it
  // no longer listening.
  $effect(() => {
    const known = treeKnown;
    const path = selectedPath;
    if (!restoreUnverified || !known) return;
    restoreUnverified = false;
    if (path !== null && !allPaths.has(path)) selection = null;
  });

  // Written on every change rather than on the way out: nothing runs
  // before a tab switch tears this view down, and a crash should not
  // lose it either. Skipped until the restore above has run for this
  // workspace, so a workspace switch can never file the old workspace's
  // selection under the new one's key.
  $effect(() => {
    const current = selection;
    if (selectionWorkspace !== workspaceId) return;
    saveExplorerSelection(workspaceId, current);
  });

  // ...but a file RENAMED or moved in a terminal isn't gone, and saying
  // so would make the human find it again by hand. Plain `let`, not
  // $state: this is read inside the effect that writes it, and a
  // reactive read there would re-trigger the effect forever.
  let previousTree: GavinTree | undefined = undefined;
  let previousWorkspaceId: string | null = null;
  $effect(() => {
    const tree = $gavinTrees[workspaceId];
    const previous = previousWorkspaceId === workspaceId ? previousTree : undefined;
    previousTree = tree;
    previousWorkspaceId = workspaceId;
    if (selectedPath === null || previous === undefined || previous === tree) return;
    const moved = followRenamedPath(previous, tree, selectedPath);
    if (moved !== null && selection) selection = { path: moved, mode: selection.mode };
  });

  const columnNames = $derived(($kanbanState[workspaceId]?.columns ?? []).map((c) => c.name));

  // Search, a facet only a plan can answer (status), and the trio Kanban
  // and Review answer the same way -- context, kind, rail (planFilter.ts,
  // boardFilters.ts). The trio lives in hubFacets.ts rather than
  // component `$state`, the same reason the selection above is
  // remembered outside the component: this view is destroyed on every
  // tab switch, and "shared with Kanban and Review" cannot mean that.
  let query = $state("");
  let statusFacet = $state(ANY);
  const hub = $derived($hubFacetState[workspaceId]);
  const sharedFacets = $derived(facetsFor(hub, "plans"));
  const facetsLinked = $derived(isTabLinked(hub, "plans"));
  const orch = $derived($orchestrations[workspaceId]);
  const rails = $derived(railIndex(orch ?? null));
  const contextOptions = $derived(contextFacets(tree));
  const statuses = $derived(statusFacets(columnNames, allContexts));
  const filtered = $derived(
    filterExplorer(
      allContexts,
      { query, status: statusFacet, rail: sharedFacets.rail, context: sharedFacets.context, kind: sharedFacets.kind },
      rails
    )
  );
  const contexts = $derived(filtered.contexts);

  // A facet whose option disappeared would silently filter everything
  // away -- reset it instead. Status is this tab's own and pruned
  // locally; context and rail are the shared trio's, pruned the same way
  // Kanban prunes them (boardFilters.ts's pruneFacets), so the two tabs
  // agree on when a vanished option gets cleared.
  $effect(() => {
    if (statusFacet !== ANY && !statuses.includes(statusFacet)) statusFacet = ANY;
  });
  $effect(() => {
    const next = pruneFacets(
      sharedFacets,
      tree && !tree.rootMissing ? contextOptions : null,
      orch === undefined ? null : rails
    );
    if (next.context !== sharedFacets.context || next.rail !== sharedFacets.rail) {
      setTabFacets(workspaceId, "plans", next);
    }
  });
  // The selected file's PlanFileInfo, when it is a plan -- docs and specs
  // have no frontmatter contract, so they get no panel.
  const selectedPlan = $derived.by(() => {
    const tree = $gavinTrees[workspaceId];
    if (!tree || !selectedPath) return null;
    for (const ctx of tree.contexts) {
      const found = ctx.plans.find((p) => p.path === selectedPath);
      if (found) return found;
    }
    return null;
  });

  // The board is needed for the metadata panel's status dropdown;
  // fetchBoard is idempotent, so calling it here means the panel never
  // renders an empty list.
  $effect(() => {
    void fetchBoard(workspaceId);
    // The rail facet needs the orchestration plan; idempotent, so the
    // dropdown is never empty just because this tab was opened first.
    void fetchOrchestration(workspaceId);
  });

  // A split needs a terminal session to anchor to; file and board tabs
  // are not sessions.
  const anchorSessionId = $derived.by(() => {
    const focused = $layoutState.focusedSessionId;
    if (!focused) return null;
    if (
        $layoutState.fileTabsById[focused] ||
        $layoutState.boardTabsById[focused] ||
        $layoutState.cardTabsById[focused]
      )
        return null;
    return focused;
  });

  async function createFile(
    context: ExplorerContextNode,
    group: CreatableGroup,
    title: string
  ): Promise<void> {
    error = null;
    const fileName = slugFileName(title);
    if (!fileName) {
      error = "That title has no usable filename characters.";
      return;
    }
    try {
      if (group === "plans") {
        // Same daemon path agents use: validated, never overwrites. The
        // status is passed rather than defaulted so this and the
        // placement below cannot name two different columns.
        const created = await backend.createPlan(context.folderPath, fileName, title, NEW_CARD_STATUS);
        select(created);
        // A card is born with no `order:`, and unordered cards sort
        // into their column's alphabetical tail -- so a card filed from
        // this tree turned up halfway down To Do on the Kanban tab.
        // Same rule as the board's own composer: a new card goes last.
        const placeError = await placeCardAtColumnEnd(workspaceId, created, NEW_CARD_STATUS, merged);
        if (placeError) error = placeError;
      } else {
        const path = newFilePath(context.gavinDir, group, fileName);
        await backend.writeFileForEditor(path, `# ${title}\n`);
        select(path);
      }
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
    // Outside contexts sit beyond the watched root, so no push ever
    // confirms this write; a refetch covers both worlds.
    void refreshGavinTree(workspaceId);
  }

  async function createContext(): Promise<void> {
    error = null;
    if (!root) return;
    const picked = await pickPath({
      directory: true,
      title: "Folder for the new gavin context",
    });
    if (typeof picked !== "string") return;
    try {
      if (isUnderRoot(root, picked)) {
        await backend.createGavinContext(picked);
      } else {
        // Outside the workspace: scaffold AND register it in the root
        // config's extra_contexts so scans list it (shown in orange).
        await backend.addExternalGavinContext(root, picked);
      }
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
    void refreshGavinTree(workspaceId);
  }

  // ---- deletion (files) ----------------------------------------------

  let pendingDelete = $state<ExplorerFile | null>(null);

  // The board's own reading of these files. Held once because two row
  // actions need different slices of it: delete needs the cascade over
  // the cards ON the board, restore needs the ones that have left it.
  const merged = $derived.by(() => {
    const board = $kanbanState[workspaceId];
    return board ? mergePlanCards(board, $gavinTrees[workspaceId]) : null;
  });

  // The board projection, for the plan-deletion cascade: nested children
  // die with their plan, free-standing children get un-parented -- same
  // rules as the kanban's delete.
  const allCards = $derived.by<CardView[]>(() => {
    if (!merged) return [];
    return [
      ...merged.columns.flatMap((c) => c.planCards),
      ...merged.autoColumns.flatMap((a) => a.planCards),
    ].flatMap((c) => [c, ...c.nestedChildren]);
  });

  // Null for docs/specs (plain files, no cascade) and when the board
  // hasn't loaded -- then the file deletes alone.
  const pendingDeletePlan = $derived.by<DeletionPlan | null>(() => {
    if (!pendingDelete || pendingDelete.group !== "plans") return null;
    const card = allCards.find((c) => c.id === pendingDelete?.path);
    return card ? deletionPlanFor(card, allCards) : null;
  });

  const pendingDeleteLines = $derived.by(() => {
    if (!pendingDelete) return [];
    const fileName = pendingDelete.path.split("/").at(-1) ?? pendingDelete.path;
    const lines = [`Deletes ${fileName} permanently.`];
    if (pendingDeletePlan) {
      const nested = pendingDeletePlan.files.length - 1;
      if (nested > 0) lines.push(`Also deletes ${nested} nested ${nested === 1 ? "task" : "tasks"}.`);
      const freed = pendingDeletePlan.unparent.length;
      if (freed > 0)
        lines.push(`Un-parents ${freed} free-standing ${freed === 1 ? "child" : "children"} on the board.`);
    }
    return lines;
  });

  async function confirmDelete(): Promise<void> {
    const target = pendingDelete;
    const plan = pendingDeletePlan;
    pendingDelete = null;
    if (!target) return;
    error = null;
    const deleted = plan ? plan.files.map((f) => f.id) : [target.path];
    if (plan) {
      const token = await grantForAnsweredPrompt("delete_card_file", plan.files.map((f) => f.id));
      const err = await executeDeletion(workspaceId, plan, token);
      if (err) error = err;
    } else {
      try {
        const token = await grantForAnsweredPrompt("delete_card_file", [target.path]);
        await backend.deleteCardFile(target.path, token);
      } catch (e) {
        error = String(e instanceof Error ? e.message : e);
      }
    }
    if (selectedPath && deleted.includes(selectedPath)) selection = null;
    void refreshGavinTree(workspaceId);
  }

  // ---- restore from the archive ---------------------------------------

  // Archived cards are NOT in `allCards`: mergePlanCards routes them out
  // of the columns into their own bucket, which is exactly what takes
  // them off the board. Restoring reads that bucket rather than widening
  // the deletion cascade's view, which must stay the board's.
  const archivedCards = $derived<CardView[]>(merged?.archived ?? []);
  const restoreBlocked = $derived(featureBlockedReason($daemonCompat, "archive"));

  async function restoreFile(file: ExplorerFile): Promise<void> {
    error = null;
    const card = archivedCards.find((c) => c.id === file.path);
    if (!card) {
      // The tree lists it but the board projection does not -- a stale
      // tree, or a card whose file vanished. Say so instead of moving
      // nothing and looking like a no-op.
      error = `Couldn't restore ${file.path.split("/").at(-1)}: it isn't on the board's archive.`;
      void refreshGavinTree(workspaceId);
      return;
    }
    const err = await executeUnarchive(workspaceId, [card]);
    if (err) error = err;
    // The selection is NOT reset here: executeUnarchive patches the new
    // path into the tree store, and the followRenamedPath effect above
    // moves the selection with it. A plan whose nested children moved
    // too is more than one rename, so that inference declines and the
    // pane falls back to "this file no longer exists" -- the same honest
    // answer it gives for any move it can't attribute.
    void refreshGavinTree(workspaceId);
  }

  // ---- outside contexts ----------------------------------------------

  let pendingRemoveOutside = $state<ExplorerContextNode | null>(null);

  async function confirmRemoveOutside(): Promise<void> {
    const target = pendingRemoveOutside;
    pendingRemoveOutside = null;
    if (!target || !root) return;
    error = null;
    try {
      await backend.removeExternalGavinContext(root, target.folderPath);
      if (selectedPath && selectedPath.startsWith(`${target.folderPath}/`)) selection = null;
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
    void refreshGavinTree(workspaceId);
  }

  let showFormatHelp = $state(false);

  async function openInSplit(path: string): Promise<void> {
    if (!anchorSessionId) return;
    await switchWorkspaceView(workspaceId, "terminal");
    await openFileInSplit(anchorSessionId, path);
  }
</script>

{#if !root}
  <div class="empty">No root folder set for this workspace.</div>
{:else}
  <div class="explorer">
    <div class="sidebar">
      <div class="sidebar-head">
        <span>Contexts</span>
        <div class="head-actions">
          <button type="button" onclick={() => (showFormatHelp = true)} title="gavin file formats">
            ?
          </button>
          <button type="button" onclick={createContext} title="Create a .gavin context in a folder">
            + context
          </button>
        </div>
      </div>
      <div class="filters">
        <SearchInput
          bind:value={query}
          label="Search plans, docs and specs"
          placeholder="Search files…"
          matches={filtered.filtering ? { shown: filtered.shown, total: filtered.total } : null}
        />
        <div class="facets">
          <select bind:value={statusFacet} aria-label="Filter by status" title="Filter plans by status">
            <option value={ANY}>Any status</option>
            {#each statuses as name (name)}
              <option value={name}>{name}</option>
            {/each}
          </select>
          <FacetFilters
            facets={sharedFacets}
            contexts={contextOptions}
            {rails}
            linked={facetsLinked}
            onChange={(next) => setTabFacets(workspaceId, "plans", next)}
            onToggleLink={() => setTabLinked(workspaceId, "plans", !facetsLinked)}
          />
          {#if filtered.filtering}
            <button
              type="button"
              class="reset"
              title="Clear the search and every filter"
              onclick={() => {
                query = "";
                statusFacet = ANY;
                resetTabFacets(workspaceId, "plans");
              }}
            >Reset</button>
          {/if}
        </div>
      </div>
      {#if allContexts.length === 0}
        <div class="empty small">No .gavin folders yet — create one to start planning.</div>
      {:else if contexts.length === 0}
        <div class="empty small">Nothing matches this filter.</div>
      {:else}
        <PlanTree
          {contexts}
          {selectedPath}
          onSelect={select}
          onCreateFile={createFile}
          onOpenInSplit={anchorSessionId ? openInSplit : null}
          onDeleteFile={(f) => (pendingDelete = f)}
          onRestoreFile={(f) => void restoreFile(f)}
          {restoreBlocked}
          onRemoveOutside={(c) => (pendingRemoveOutside = c)}
        />
      {/if}
    </div>
    <div class="detail">
      {#if error}
        <div class="error-strip">
          <span>{error}</span>
          <button type="button" onclick={() => (error = null)}>✕</button>
        </div>
      {/if}
      {#if selectedPath === null}
        <div class="empty">Select a file.</div>
      {:else if selectionVanished}
        <div class="empty">This file no longer exists.</div>
      {:else}
        {#key selectedPath}
          {#if selectedPlan}
            <PlanMetadataPanel
              plan={selectedPlan}
              {workspaceId}
              {columnNames}
              onBeforeWrite={async () => {
                await editor?.flush();
              }}
            />
          {/if}
          <FileEditor
            bind:this={editor}
            path={selectedPath}
            initialMode={selection?.mode}
            onModeChange={(mode) => {
              if (selection) selection = { path: selection.path, mode };
            }}
          />
        {/key}
      {/if}
    </div>
  </div>
{/if}

{#if pendingDelete}
  <ConfirmPrompt
    title="Delete {pendingDelete.path.split('/').at(-1)}?"
    lines={pendingDeleteLines}
    choices={[{ label: "Delete", danger: true, onPick: confirmDelete }]}
    onCancel={() => (pendingDelete = null)}
  />
{/if}

{#if pendingRemoveOutside}
  <ConfirmPrompt
    title="Remove {pendingRemoveOutside.name} from the navigator?"
    lines={[
      `Stops listing ${pendingRemoveOutside.folderPath} in this workspace.`,
      "No files are deleted — add it again any time with + context.",
    ]}
    choices={[{ label: "Remove", danger: true, onPick: confirmRemoveOutside }]}
    onCancel={() => (pendingRemoveOutside = null)}
  />
{/if}

{#if showFormatHelp}
  <FormatHelpModal onClose={() => (showFormatHelp = false)} />
{/if}

<style>
  .explorer {
    display: flex;
    height: 100%;
    min-height: 0;
  }
  .sidebar {
    width: 260px;
    flex: 0 0 auto;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .sidebar-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex: 0 0 auto;
  }
  .head-actions {
    display: flex;
    gap: 4px;
  }
  .filters {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 6px;
    border-bottom: 1px solid var(--border);
    flex: 0 0 auto;
  }
  .facets {
    display: flex;
    gap: 4px;
  }
  .facets :global(.facet-link) {
    flex: 0 0 auto;
  }
  .facets select {
    flex: 1 1 0;
    min-width: 0;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: monospace;
    font-size: 0.72em;
    padding: 2px 4px;
  }
  .reset {
    flex: 0 0 auto;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.72em;
    padding: 2px 6px;
    cursor: pointer;
  }
  .reset:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }
  .sidebar-head button {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 1em;
    padding: 1px 6px;
    cursor: pointer;
    text-transform: none;
  }
  .detail {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-subtle);
    font-family: monospace;
    font-size: 0.85em;
    padding: 8px;
    text-align: center;
  }
  .empty.small {
    height: auto;
    padding: 16px 8px;
  }
  .error-strip {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 8px;
    padding: 6px 10px;
    border: 1px solid var(--border-warning);
    border-radius: 6px;
    color: var(--warning-text);
    font-family: monospace;
    font-size: 0.8em;
    flex: 0 0 auto;
  }
  .error-strip button {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    margin-left: auto;
  }
</style>
