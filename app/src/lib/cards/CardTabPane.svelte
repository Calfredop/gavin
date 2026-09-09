<script lang="ts">
  // A card's own view, living in a pane instead of in a modal.
  //
  // The two chips on a terminal tab open this: "Show plan" gives the
  // card's detail panel, the Changes chip the diff of what this run did
  // to the checkout. Both used to leave the terminal behind -- one
  // switched the whole window to a hub tab, the other threw a modal over
  // it -- and both answer a question the human is asking ABOUT the agent
  // they are watching. Beside it is where the answer belongs.
  //
  // Deliberately thin, like BoardPane: it locates the card in the board's
  // own projection and hands it to the same components the hub tabs
  // mount, so a card never has two different detail panels.
  import { fetchBoard, refreshBoard, kanbanState, cardSessionFor } from "$lib/board/kanbanState";
  import { fetchOrchestration, orchestrations } from "$lib/orchestrationState";
  import { gavinTrees } from "$lib/gavinState";
  import { indexCardViews, mergePlanCards, type CardView } from "$lib/planBoard";
  import {
    layoutState,
    daemonCompat,
    closeSession,
    retargetCardTabs,
    setCardTabPath,
  } from "$lib/layoutState";
  import { cardSessionState } from "$lib/board/columnRunAction";
  import { runBaseline } from "$lib/cards/runChanges";
  import { linkForCardPath, openLinkedCard } from "$lib/cards/cardTabLink";
  import type { CardTabView } from "$lib/gavin";
  import CardDetailModal from "$lib/cards/CardDetailModal.svelte";
  import RunChangesModal from "$lib/cards/RunChangesModal.svelte";

  interface Props {
    workspaceId: string;
    /// The card this pane shows. Not `$bindable` -- the store owns it, so
    /// a card that moves on disk is followed by retargetCardTabs and
    /// arrives back here as a new prop.
    path: string;
    view: CardTabView;
    visible: boolean;
    /// The tab this pane occupies, so the panel's own close can close it.
    tabId: string;
  }
  let { workspaceId, path, view, visible, tabId }: Props = $props();

  // The contract every pane honors: Pane.svelte calls fit() on all of
  // them. A card panel has nothing to fit.
  export function fit(): void {}

  // Two fetches this page would otherwise never make: the board holds the
  // card bindings this pane reads, the orchestration plan decides which
  // hub tab "Show on the board" goes to. Both no-op once loaded.
  $effect(() => {
    void fetchBoard(workspaceId);
    void fetchOrchestration(workspaceId);
  });

  // Staleness, exactly as BoardPane handles it: refetch when this pane is
  // revealed and when the window regains focus.
  $effect(() => {
    if (visible) void refreshBoard(workspaceId);
  });
  $effect(() => {
    const onFocus = () => void refreshBoard(workspaceId);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  });

  const board = $derived($kanbanState[workspaceId]);
  const tree = $derived($gavinTrees[workspaceId]);
  const orch = $derived($orchestrations[workspaceId]);
  // The whole root, unfiltered: this pane is opened from a terminal that
  // may be anywhere, so the card can live in any context.
  const merged = $derived(board ? mergePlanCards(board, tree) : null);
  const placed = $derived(merged ? indexCardViews(merged) : new Map());
  const allCards = $derived<CardView[]>([...placed.values()].map((p) => p.view));
  const card = $derived<CardView | null>(placed.get(path)?.view ?? null);

  // The run this pane's card is under, and the commit its checkout was on
  // when it started. Null when there is no baseline to diff against -- an
  // older daemon, a launch outside a repository, or a card with no live
  // binding at all.
  const run = $derived.by(() => {
    const binding = cardSessionFor(board, path);
    const baseline = runBaseline(binding, $daemonCompat);
    if (baseline.kind !== "ready") return null;
    return {
      cwd: baseline.cwd,
      baseSha: baseline.baseSha,
      live: cardSessionState($layoutState, binding) === "live",
    };
  });

  // Named from the tree when it knows the card, from the file name when
  // it does not -- the same fallback the tab label uses, so the two can
  // never disagree.
  const link = $derived(linkForCardPath(orch, tree, path));

  function close(): void {
    void closeSession(tabId);
  }
</script>

<!-- display, not visibility+z-index: the detail panel mounts real
     modals of its own (a confirm, the run history), and a positioned
     pane with a z-index would make a stacking context that traps their
     fixed backdrops under the pane beside this one. BoardPane hides
     itself this way for the same reason. -->
<div class="pane" style:display={visible ? "block" : "none"}>
  {#if view === "plan"}
    {#if card && board}
      <CardDetailModal
        {card}
        {workspaceId}
        columns={board.columns}
        labels={board.labels}
        {allCards}
        inline
        onClose={close}
        onOpenCard={(next) => void setCardTabPath(tabId, next)}
        onPathChange={(next) => void retargetCardTabs(path, next)}
        onGoToBoard={() => void openLinkedCard(workspaceId, link)}
      />
    {:else}
      <p class="empty">
        {board ? `No card at ${path} — it may have been deleted.` : "Loading the board…"}
      </p>
    {/if}
  {:else if run}
    <RunChangesModal
      {path}
      title={link.title}
      cwd={run.cwd}
      baseSha={run.baseSha}
      sessionIsLive={run.live}
      inline
      onClose={close}
    />
  {:else}
    <p class="empty">
      {board
        ? "This card has no run to diff — nothing recorded where its checkout started."
        : "Loading the board…"}
    </p>
  {/if}
</div>

<style>
  /* Positioned, because Modal's inline mode fills its nearest positioned
     ancestor. Same absolute-inset shape as every other pane. */
  .pane {
    position: absolute;
    inset: 0;
    background: var(--surface-base);
    color: var(--text);
    overflow: hidden;
  }
  .empty {
    margin: 0;
    padding: 16px;
    color: var(--text-muted);
    font-family: monospace;
    font-size: 0.8em;
  }
</style>
